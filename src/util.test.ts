import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMENT_MARKER,
  buildCommentBody,
  chunk,
  normalizeCopilotCliVersion,
  scrubbedEnv,
  truncate,
} from "./util.ts";

test("chunk splits into groups with remainder", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test("truncate only cuts long text", () => {
  assert.equal(truncate("short", 100), "short");
  assert.match(truncate("x".repeat(200), 100), /truncated/);
});

test("normalizeCopilotCliVersion accepts only exact versions", () => {
  for (const version of ["1.0.70", "1.0.70-alpha-beta.1", "1.0.70+build.1"]) {
    assert.equal(normalizeCopilotCliVersion(` ${version} `), version);
  }

  for (const version of [
    "latest",
    "^1.0.70",
    "~1.0.70",
    "1",
    "01.0.70",
    "1.0.0-01",
    "1.0.0-beta..1",
    "file:/tmp/pkg.tgz",
    "https://example.com/pkg.tgz",
  ]) {
    assert.throws(() => normalizeCopilotCliVersion(version), /cli_version must be an exact/);
  }
});

test("buildCommentBody lists duplicates with marker", () => {
  const body = buildCommentBody([
    { number: 12, title: "t", url: "u", reasoning: "same crash" },
  ]);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /#12 — same crash/);
});

test("scrubbedEnv strips inputs and credential-looking vars, keeps the rest", () => {
  const env = {
    PATH: "/usr/bin",
    RUNNER_TEMP: "/tmp",
    INPUT_GITHUB_TOKEN: "ghs_secret",
    input_byok_api_key: "sk-secret",
    GITHUB_TOKEN: "ghs_secret",
    COPILOT_GITHUB_TOKEN: "ghs_secret",
    MY_PASSWORD: "hunter2",
    AWS_CREDENTIALS: "x",
    SOME_API_KEY: "x",
    npm_config_registry: "https://registry.npmjs.org",
  };
  assert.deepEqual(scrubbedEnv(env), {
    PATH: "/usr/bin",
    RUNNER_TEMP: "/tmp",
    npm_config_registry: "https://registry.npmjs.org",
  });
});

test("buildCommentBody without duplicates says so", () => {
  const body = buildCommentBody([]);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /No duplicate issues/);
});
