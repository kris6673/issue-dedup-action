export const COMMENT_MARKER = "<!-- issue-dedup-action -->";

export interface Duplicate {
  number: number;
  title: string;
  url: string;
  reasoning: string;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

/**
 * Copy of the env for child processes (npm install, the Copilot CLI) with
 * action inputs and credential-looking variables removed, so a compromised
 * dependency can't read the GitHub token or BYOK keys. The SDK injects its
 * own auth from the `gitHubToken` option.
 */
export function scrubbedEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^INPUT_/i.test(key)) continue;
    if (/(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (/_KEY$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeCopilotCliVersion(version: string): string {
  const trimmed = version.trim();
  const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (trimmed !== "latest" && !exactSemver.test(trimmed)) {
    throw new Error(
      "cli_version must be 'latest' or an exact @github/copilot version, for example 1.0.70; other tags, ranges, URLs, and file paths are not allowed",
    );
  }
  return trimmed;
}

export function buildCommentBody(duplicates: Duplicate[]): string {
  const footer = `<sub>Detected automatically by [issue-dedup-action](https://github.com/kris6673/issue-dedup-action)</sub>`;
  if (!duplicates.length) {
    return `${COMMENT_MARKER}\nNo duplicate issues currently detected.\n\n${footer}`;
  }
  const items = duplicates
    .map((d) => `- #${d.number} — ${d.reasoning}`)
    .join("\n");
  return `${COMMENT_MARKER}\n### Possible duplicate issues\n\n${items}\n\n${footer}`;
}
