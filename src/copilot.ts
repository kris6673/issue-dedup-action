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

const RESULT_TOOL = "report_result";

let client: CopilotClient | null = null;

/**
 * The SDK drives the Copilot CLI as a subprocess. The CLI is not bundled into
 * dist/, so install `@github/copilot` (a small loader plus one platform
 * package) into the runner temp dir and point the SDK at it explicitly —
 * the SDK's own require.resolve lookup does not survive esbuild bundling.
 */
async function installCli(version: string): Promise<string> {
  const prefix = join(process.env.RUNNER_TEMP ?? tmpdir(), "issue-dedup-copilot-cli");
  const loader = join(prefix, "node_modules", "@github", "copilot", "npm-loader.js");
  if (!existsSync(loader)) {
    core.info(`Installing @github/copilot@${version}`);
    await exec("npm", [
      "install",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `@github/copilot@${version}`,
    ]);
  }
  return loader;
}

export async function startCopilot(opts: {
  token: string;
  cliVersion: string;
}): Promise<void> {
  const cliPath = await installCli(opts.cliVersion);
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    gitHubToken: opts.token,
    useLoggedInUser: false,
    logLevel: "error",
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
