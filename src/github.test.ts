import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getIssue,
  listCandidates,
  removeDuplicateLabel,
  upsertComment,
  type Octokit,
} from "./github.ts";
import { COMMENT_MARKER } from "./util.ts";

const repo = { owner: "owner", repo: "repo" };

function mockOctokit(viewerLogin: string, commentLogin: string, type: "Bot" | "User") {
  const calls = { created: 0, updated: 0 };
  const listComments = () => undefined;
  const octokit = {
    graphql: async () => ({ viewer: { login: viewerLogin } }),
    paginate: async () => [
      { id: 1, body: COMMENT_MARKER, user: { login: commentLogin, type } },
    ],
    rest: {
      issues: {
        listComments,
        updateComment: async () => {
          calls.updated++;
        },
        createComment: async () => {
          calls.created++;
        },
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

test("updates a PAT user's marker comment", async () => {
  const { octokit, calls } = mockOctokit("alice", "alice", "User");
  assert.equal(await upsertComment(octokit, repo, 1, "body"), "updated");
  assert.deepEqual(calls, { created: 0, updated: 1 });
});

test("updates a GITHUB_TOKEN bot's marker comment", async () => {
  const { octokit, calls } = mockOctokit("github-actions[bot]", "github-actions[bot]", "Bot");
  assert.equal(await upsertComment(octokit, repo, 1, "body"), "updated");
  assert.deepEqual(calls, { created: 0, updated: 1 });
});

test("creates a comment when the marker belongs to another identity", async () => {
  const { octokit, calls } = mockOctokit("alice", "mallory", "User");
  assert.equal(await upsertComment(octokit, repo, 1, "body"), "created");
  assert.deepEqual(calls, { created: 1, updated: 0 });
});

test("matches marker comment logins case-insensitively", async () => {
  const { octokit, calls } = mockOctokit("Alice", "aLiCe", "User");
  assert.equal(await upsertComment(octokit, repo, 1, "body"), "updated");
  assert.deepEqual(calls, { created: 0, updated: 1 });
});

test("reads issue labels and removes the duplicate label", async () => {
  let removed: Record<string, unknown> | undefined;
  const octokit = {
    rest: {
      issues: {
        get: async () => ({
          data: {
            number: 1,
            title: "Issue",
            body: null,
            html_url: "https://example.test/1",
            labels: ["bug", { name: "duplicate" }],
          },
        }),
        removeLabel: async (options: Record<string, unknown>) => {
          removed = options;
        },
      },
    },
  } as unknown as Octokit;

  const issue = await getIssue(octokit, repo, 1);
  assert.deepEqual(issue.labels, ["bug", "duplicate"]);
  await removeDuplicateLabel(octokit, repo, issue.number);
  assert.deepEqual(removed, { ...repo, issue_number: 1, name: "duplicate" });
});

test("treats an already-absent duplicate label as success", async () => {
  const octokit = {
    rest: {
      issues: {
        removeLabel: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      },
    },
  } as unknown as Octokit;

  await assert.doesNotReject(removeDuplicateLabel(octokit, repo, 1));
});

test("uses the full title with GitHub hybrid issue search", async () => {
  let requestOptions: Record<string, unknown> | undefined;
  const octokit = {
    request: async (_route: string, options: Record<string, unknown>) => {
      requestOptions = options;
      return { data: { items: [] } };
    },
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
      },
    },
  } as unknown as Octokit;

  await listCandidates(octokit, repo, {
    state: "open",
    labels: [],
    count: 30,
    exclude: 1,
    title: "Authentication error when using Azure login",
  });

  assert.deepEqual(requestOptions, {
    q: "repo:owner/repo is:issue state:open authentication error when using azure login",
    per_page: 30,
    search_type: "hybrid",
  });
});
