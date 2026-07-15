import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addUsageMetrics,
  collectUsageMetrics,
  emptyUsageSummary,
  formatUsageDebug,
  formatUsageSummary,
} from "./copilot.ts";

function metrics(
  model: string,
  opts: {
    calls?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    premium?: number;
    nanoAiu?: number;
    duration?: number;
  } = {},
) {
  return {
    totalPremiumRequestCost: opts.premium ?? 0,
    totalApiDurationMs: opts.duration ?? 0,
    totalNanoAiu: opts.nanoAiu,
    modelMetrics: {
      [model]: {
        requests: { count: opts.calls ?? 1, cost: opts.premium ?? 0 },
        usage: {
          inputTokens: opts.input ?? 0,
          outputTokens: opts.output ?? 0,
          cacheReadTokens: opts.cacheRead ?? 0,
          cacheWriteTokens: opts.cacheWrite ?? 0,
          reasoningTokens: opts.reasoning,
        },
        totalNanoAiu: opts.nanoAiu,
      },
    },
  };
}

test("aggregates sessions and formats AI Credits", () => {
  const usage = emptyUsageSummary();
  addUsageMetrics(
    usage,
    metrics("gpt-5-mini", { calls: 2, input: 12_000, output: 800, nanoAiu: 250_000_000 }),
    false,
  );
  addUsageMetrics(
    usage,
    metrics("claude-sonnet-4.5", {
      calls: 2,
      input: 6_420,
      output: 330,
      nanoAiu: 170_000_000,
      cacheRead: 500,
      reasoning: 40,
      duration: 1_234,
    }),
    false,
  );

  assert.equal(
    formatUsageSummary(usage),
    "AI usage: 4 model calls · 18,420 input tokens · 1,130 output tokens · 0.420 AI Credits",
  );
  assert.deepEqual(formatUsageDebug(usage), [
    "AI usage [claude-sonnet-4.5]: 2 calls · 6,420 input · 330 output · 500 cache read · 0 cache write · 40 reasoning · 0.170 AI Credits",
    "AI usage [gpt-5-mini]: 2 calls · 12,000 input · 800 output · 0 cache read · 0 cache write · 0 reasoning · 0.250 AI Credits",
    "AI usage: 1,234 ms model API time",
  ]);
});

test("falls back to legacy premium requests", () => {
  const usage = emptyUsageSummary();
  addUsageMetrics(usage, metrics("gpt-5-mini", { premium: 0.33 }), false);
  assert.match(formatUsageSummary(usage) ?? "", /0\.330 premium requests$/);
});

test("suppresses billing units for BYOK", () => {
  const usage = emptyUsageSummary();
  addUsageMetrics(usage, metrics("custom-model", { input: 10, output: 2, nanoAiu: 50 }), true);
  assert.equal(formatUsageSummary(usage), "AI usage: 1 model call · 10 input tokens · 2 output tokens");
  assert.ok(formatUsageDebug(usage).every((line) => !/Credits|premium/.test(line)));
});


test("stores prototype-looking model names without polluting objects", () => {
  const usage = emptyUsageSummary();
  const metric = {
    requests: { count: 1, cost: 0.25 },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 5,
    },
    totalNanoAiu: 6,
  };

  addUsageMetrics(
    usage,
    {
      totalPremiumRequestCost: 0.25,
      totalApiDurationMs: 7,
      modelMetrics: JSON.parse(`{"__proto__":${JSON.stringify(metric)}}`),
    },
    false,
  );

  assert.equal(Object.hasOwn(usage.models, "__proto__"), true);
  assert.deepEqual(Object.keys({}), []);
  assert.equal(Object.hasOwn(Object.prototype, "calls"), false);
  assert.equal(usage.models.__proto__.calls, 1);
  assert.equal(usage.models.__proto__.nanoAiu, 6);
});

test("returns no log lines when metrics were unavailable", () => {
  const usage = emptyUsageSummary();
  assert.equal(formatUsageSummary(usage), undefined);
  assert.deepEqual(formatUsageDebug(usage), []);
});

test("metric retrieval errors are non-fatal", async () => {
  const usage = emptyUsageSummary();
  await assert.doesNotReject(
    collectUsageMetrics(usage, () => Promise.reject(new Error("unsupported")), false, "test"),
  );
  assert.equal(formatUsageSummary(usage), undefined);
});
