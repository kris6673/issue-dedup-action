export const COMMENT_MARKER = "<!-- issue-dedup-action -->";

export interface Duplicate {
  number: number;
  title: string;
  url: string;
  reasoning: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "of", "to", "for", "and", "or", "not", "no", "with",
  "when", "after", "before", "while", "it", "its", "this", "that",
  "these", "those", "can", "cannot", "cant", "does", "doesnt", "do",
  "dont", "at", "by", "from", "as", "if", "but", "how", "why", "what",
  "will", "wont", "should", "would", "could", "has", "have", "had",
  "using", "use", "via", "get", "gets", "issue", "bug", "error",
]);

/** Keywords from an issue title for a GitHub search query. */
export function extractKeywords(title: string, max = 6): string[] {
  const words = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
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
