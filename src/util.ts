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

export function parseNonNegativeInteger(value: string, name: string): number {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return parsed;
}

export function reconcileIssueVerdicts<T extends { issue_number: number }>(
  expectedIssueNumbers: number[],
  verdicts: T[],
): {
  byIssueNumber: Map<number, T>;
  unknownIssueNumbers: number[];
  ambiguousIssueNumbers: number[];
  missingIssueNumbers: number[];
} {
  const expected = new Set(expectedIssueNumbers);
  const byIssueNumber = new Map<number, T>();
  const unknown = new Set<number>();
  const ambiguous = new Set<number>();

  for (const verdict of verdicts) {
    const number = verdict.issue_number;
    if (!expected.has(number)) {
      unknown.add(number);
    } else if (byIssueNumber.has(number) || ambiguous.has(number)) {
      byIssueNumber.delete(number);
      ambiguous.add(number);
    } else {
      byIssueNumber.set(number, verdict);
    }
  }

  return {
    byIssueNumber,
    unknownIssueNumbers: [...unknown].sort((a, b) => a - b),
    ambiguousIssueNumbers: expectedIssueNumbers.filter((number) => ambiguous.has(number)),
    missingIssueNumbers: expectedIssueNumbers.filter(
      (number) => !byIssueNumber.has(number) && !ambiguous.has(number),
    ),
  };
}

export function shouldFlushSuspects(
  suspectCount: number,
  remainingSlots: number,
  minimumBatch: number,
): boolean {
  return remainingSlots > 0 && suspectCount >= Math.max(remainingSlots, minimumBatch);
}

export function confirmationBatchSize(
  remainingSlots: number,
  minimumBatch: number,
  maximumBatch: number,
): number {
  return Math.min(maximumBatch, Math.max(minimumBatch, remainingSlots * 2));
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

export function sinceDaysToISOString(sinceDays: string, now = Date.now()): string {
  const days = parseNonNegativeInteger(sinceDays, "since_days");

  const date = new Date(now - days * 86400000);
  if (Number.isNaN(date.getTime())) {
    throw new Error("since_days is too large to convert to a valid date");
  }
  return date.toISOString();
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
