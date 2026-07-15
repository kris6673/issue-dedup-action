import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { exec } from "@actions/exec";
import {
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  approveAll,
  defineTool,
} from "@github/copilot-sdk";
import type { ProviderConfig } from "@github/copilot-sdk";
import type { ZodType } from "zod";
import { scrubbedEnv } from "./util.ts";

const RESULT_TOOL = "report_result";

let client: CopilotClient | null = null;

interface ModelUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  premiumRequestCost: number;
  nanoAiu?: number;
}

export interface UsageSummary extends ModelUsageSummary {
  collected: boolean;
  byok: boolean;
  apiDurationMs: number;
  models: Record<string, ModelUsageSummary>;
}

interface SessionUsageMetrics {
  totalPremiumRequestCost: number;
  totalApiDurationMs: number;
  totalNanoAiu?: number;
  modelMetrics: Record<
    string,
    | {
        requests: { count: number; cost: number };
        usage: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          reasoningTokens?: number;
        };
        totalNanoAiu?: number;
      }
    | undefined
  >;
}

function emptyModelUsage(): ModelUsageSummary {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    premiumRequestCost: 0,
  };
}

export function emptyUsageSummary(): UsageSummary {
  return {
    ...emptyModelUsage(),
    collected: false,
    byok: false,
    apiDurationMs: 0,
    models: Object.create(null) as Record<string, ModelUsageSummary>,
  };
}

let usage = emptyUsageSummary();

export function addUsageMetrics(
  summary: UsageSummary,
  metrics: SessionUsageMetrics,
  byok: boolean,
): void {
  summary.collected = true;
  summary.byok ||= byok;
  summary.apiDurationMs += metrics.totalApiDurationMs;
  summary.premiumRequestCost += metrics.totalPremiumRequestCost;
  if (metrics.totalNanoAiu !== undefined) {
    summary.nanoAiu = (summary.nanoAiu ?? 0) + metrics.totalNanoAiu;
  }

  for (const [model, metric] of Object.entries(metrics.modelMetrics)) {
    if (!metric) continue;
    const target = (summary.models[model] ??= emptyModelUsage());
    for (const item of [summary, target]) {
      item.calls += metric.requests.count;
      item.inputTokens += metric.usage.inputTokens;
      item.outputTokens += metric.usage.outputTokens;
      item.cacheReadTokens += metric.usage.cacheReadTokens;
      item.cacheWriteTokens += metric.usage.cacheWriteTokens;
      item.reasoningTokens += metric.usage.reasoningTokens ?? 0;
    }
    target.premiumRequestCost += metric.requests.cost;
    if (metric.totalNanoAiu !== undefined) {
      target.nanoAiu = (target.nanoAiu ?? 0) + metric.totalNanoAiu;
    }
  }
}

export async function collectUsageMetrics(
  summary: UsageSummary,
  getMetrics: () => Promise<SessionUsageMetrics>,
  byok: boolean,
  label: string,
): Promise<void> {
  try {
    addUsageMetrics(summary, await getMetrics(), byok);
  } catch (err) {
    core.debug(
      `[${label}] usage metrics unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const integer = new Intl.NumberFormat("en-US");

function billingUnits(value: number): string {
  return value > 0 && value < 0.001 ? "<0.001" : value.toFixed(3);
}

function billingSuffix(summary: ModelUsageSummary, byok: boolean): string | undefined {
  if (byok) return undefined;
  if (summary.nanoAiu !== undefined) {
    return `${billingUnits(summary.nanoAiu / 1_000_000_000)} AI Credits`;
  }
  if (summary.premiumRequestCost > 0) {
    return `${billingUnits(summary.premiumRequestCost)} premium requests`;
  }
  return undefined;
}

export function formatUsageSummary(summary: UsageSummary): string | undefined {
  if (!summary.collected) return undefined;
  const parts = [
    `${integer.format(summary.calls)} model call${summary.calls === 1 ? "" : "s"}`,
    `${integer.format(summary.inputTokens)} input tokens`,
    `${integer.format(summary.outputTokens)} output tokens`,
  ];
  const billing = billingSuffix(summary, summary.byok);
  if (billing) parts.push(billing);
  return `AI usage: ${parts.join(" · ")}`;
}

export function formatUsageDebug(summary: UsageSummary): string[] {
  if (!summary.collected) return [];
  const lines = Object.entries(summary.models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, item]) => {
      const parts = [
        `${integer.format(item.calls)} calls`,
        `${integer.format(item.inputTokens)} input`,
        `${integer.format(item.outputTokens)} output`,
        `${integer.format(item.cacheReadTokens)} cache read`,
        `${integer.format(item.cacheWriteTokens)} cache write`,
        `${integer.format(item.reasoningTokens)} reasoning`,
      ];
      const billing = billingSuffix(item, summary.byok);
      if (billing) parts.push(billing);
      return `AI usage [${model}]: ${parts.join(" · ")}`;
    });
  lines.push(`AI usage: ${integer.format(summary.apiDurationMs)} ms model API time`);
  return lines;
}

export function logUsage(): void {
  const line = formatUsageSummary(usage);
  if (!line) return;
  core.info(line);
  for (const detail of formatUsageDebug(usage)) core.debug(detail);
}

/**
 * The SDK drives the Copilot CLI as a subprocess. The CLI is not bundled into
 * dist/, so install `@github/copilot` (a small loader plus one platform
 * package) into the runner temp dir and point the SDK at it explicitly —
 * the SDK's own require.resolve lookup does not survive esbuild bundling.
 */
async function installCli(version: string): Promise<string> {
  // Version in the dir name: a cached install can never satisfy a different pin.
  const prefix = join(process.env.RUNNER_TEMP ?? tmpdir(), `issue-dedup-copilot-cli-${version}`);
  const loader = join(prefix, "node_modules", "@github", "copilot", "npm-loader.js");
  if (!existsSync(loader)) {
    core.info(`Installing @github/copilot@${version}`);
    await exec(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        // The CLI packages have no lifecycle scripts (verified at 1.0.70);
        // disabling them means a compromised release can't run code at install.
        "--ignore-scripts",
        "--loglevel=error",
        `@github/copilot@${version}`,
      ],
      { env: scrubbedEnv(process.env) as Record<string, string> },
    );
  }
  return loader;
}

export async function startCopilot(opts: {
  token: string;
  cliVersion: string;
}): Promise<void> {
  usage = emptyUsageSummary();
  const cliPath = await installCli(opts.cliVersion);
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    gitHubToken: opts.token,
    useLoggedInUser: false,
    logLevel: "error",
    // The CLI subprocess gets a scrubbed env: no INPUT_* or credential vars.
    // Auth comes from gitHubToken above, injected by the SDK itself.
    env: scrubbedEnv(process.env),
  });
  await client.start();
}

export async function stopCopilot(): Promise<void> {
  await client?.stop();
  client = null;
}

export interface StructuredOptions<T> {
  model: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  provider?: ProviderConfig;
  label: string;
}

/**
 * Run one prompt and get a schema-validated result back. The schema is
 * exposed as the session's only tool; the model is instructed to answer by
 * calling it, which is the SDK's reliable structured-output channel (no
 * native JSON-schema response format yet, see copilot-sdk#1185).
 */
export async function runStructured<T>(opts: StructuredOptions<T>): Promise<T> {
  if (!client) throw new Error("Copilot client not started");
  core.debug(`[${opts.label}] model=${opts.model}`);

  let captured: unknown;
  const tool = defineTool(RESULT_TOOL, {
    description:
      "Report your final structured result. Call this tool exactly once with the complete answer.",
    parameters: opts.schema,
    skipPermission: true,
    handler: (args: unknown) => {
      captured = args;
      return "recorded";
    },
  });

  const session = await client.createSession({
    model: opts.model,
    tools: [tool],
    availableTools: new ToolSet().addCustom(RESULT_TOOL).toArray(),
    systemMessage: { mode: "replace", content: opts.system },
    onPermissionRequest: approveAll,
    provider: opts.provider,
  });
  try {
    const res = await session.sendAndWait({ prompt: opts.prompt }, 300_000);
    if (captured === undefined) {
      captured = parseJsonLoose(res?.data.content, opts.label);
    }
    return opts.schema.parse(captured);
  } finally {
    await collectUsageMetrics(
      usage,
      () => session.rpc.usage.getMetrics(),
      Boolean(opts.provider),
      opts.label,
    );
    await session.disconnect().catch(() => {});
  }
}

/** Fallback when the model answers in text instead of calling the tool. */
function parseJsonLoose(text: string | undefined, label: string): unknown {
  if (!text) throw new Error(`[${label}] model returned no tool call and no text`);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `[${label}] model did not call ${RESULT_TOOL} and returned unparseable text: ${text.slice(0, 400)}`,
    );
  }
}
