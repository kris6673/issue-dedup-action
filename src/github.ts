import type { getOctokit } from "@actions/github";
import * as core from "@actions/core";
import { COMMENT_MARKER } from "./util.ts";

export type Octokit = ReturnType<typeof getOctokit>;

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueLite {
  number: number;
  title: string;
  body: string;
  html_url: string;
}

export interface IssueFull extends IssueLite {
  labels: string[];
}

export async function getIssue(
  octokit: Octokit,
  repo: RepoRef,
  issue_number: number,
): Promise<IssueFull> {
  const { data } = await octokit.rest.issues.get({ ...repo, issue_number });
  return {
    ...toLite(data),
    labels: (data.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return name ? [name] : [];
    }),
  };
}

export async function listRepoLabels(
  octokit: Octokit,
  repo: RepoRef,
): Promise<{ name: string; description: string }[]> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    ...repo,
    per_page: 100,
  });
  return labels.map((l) => ({ name: l.name, description: l.description ?? "" }));
}

export interface CandidateOptions {
  state: "open" | "closed" | "all";
  since?: string;
  labels: string[];
  count: number;
  exclude: number;
  title: string;
}

/**
 * Candidate issues to compare against: GitHub's hybrid semantic/keyword
 * search on the new issue's title merged with recently-updated issues
 * (optionally per label, mirroring the upstream action), deduped and capped
 * at `count`. Search hits come first — they're relevance-ranked, so they
 * must survive the cap even when the recency listing alone could fill it.
 */
export async function listCandidates(
  octokit: Octokit,
  repo: RepoRef,
  opts: CandidateOptions,
): Promise<IssueLite[]> {
  const collected: IssueLite[] = [];
  const recent: IssueLite[] = [];

  for (const label of opts.labels.length ? opts.labels : [undefined]) {
    const { data } = await octokit.rest.issues.listForRepo({
      ...repo,
      state: opts.state,
      sort: "updated",
      direction: "desc",
      per_page: Math.min(opts.count, 100),
      since: opts.since || undefined,
      labels: label,
    });
    recent.push(...data.filter((i) => !i.pull_request).map(toLite));
  }

  const searchText = opts.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (searchText) {
    const qualifiers = [`repo:${repo.owner}/${repo.repo}`, "is:issue"];
    if (opts.state !== "all") qualifiers.push(`state:${opts.state}`);
    if (opts.since) qualifiers.push(`updated:>=${opts.since}`);
    const q = [...qualifiers, searchText].join(" ");
    core.debug(`search query: ${q}`);
    try {
      const { data } = await octokit.request("GET /search/issues", {
        q,
        per_page: Math.min(opts.count, 100),
        search_type: "hybrid",
      });
      collected.push(...data.items.filter((i) => !i.pull_request).map(toLite));
    } catch (err) {
      // Search is additive; the recency listing above still provides candidates.
      core.warning(`Keyword search failed, continuing without it: ${err}`);
    }
  }

  for (const issue of recent) collected.push(issue);

  const seen = new Set<number>([opts.exclude]);
  return collected
    .filter((i) => !seen.has(i.number) && Boolean(seen.add(i.number)))
    .slice(0, opts.count);
}

/**
 * Create or update this action's single comment on the issue (found via the
 * hidden marker), so re-runs on `issues: edited` never stack comments.
 */
export async function upsertComment(
  octokit: Octokit,
  repo: RepoRef,
  issue_number: number,
  body: string,
  { onlyUpdate = false } = {},
): Promise<"created" | "updated" | "skipped"> {
  const { viewer } = await octokit.graphql<{ viewer: { login: string } }>(
    "query { viewer { login } }",
  );
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find(
    (c) =>
      c.body?.includes(COMMENT_MARKER) &&
      c.user?.login.toLowerCase() === viewer.login.toLowerCase(),
  );
  if (existing) {
    try {
      await octokit.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
      return "updated";
    } catch (err) {
      core.warning(`Could not update marker comment ${existing.id}, creating a new one: ${err}`);
    }
  }
  if (onlyUpdate) return "skipped";
  await octokit.rest.issues.createComment({ ...repo, issue_number, body });
  return "created";
}

export async function addDuplicateLabel(
  octokit: Octokit,
  repo: RepoRef,
  issue_number: number,
): Promise<void> {
  await octokit.rest.issues.addLabels({ ...repo, issue_number, labels: ["duplicate"] });
}

function toLite(i: {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
}): IssueLite {
  return { number: i.number, title: i.title, body: i.body ?? "", html_url: i.html_url };
}
