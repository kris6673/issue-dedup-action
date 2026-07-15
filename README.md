# Issue Deduplicator

GitHub Action that checks whether a new issue duplicates an existing one, using the [Copilot SDK](https://github.com/github/copilot-sdk) for LLM reasoning. When duplicates are found it can comment on the issue with links and reasoning, apply the `duplicate` label, and expose the results as action outputs.

Inspired by [pelikhan/action-genai-issue-dedup](https://github.com/pelikhan/action-genai-issue-dedup).

## How it works

1. **Label classification** (optional, `labels: auto`) — a small model classifies the issue against the repository's labels; the result filters the candidate set.
2. **Candidate retrieval** — recently updated issues (filtered by state/labels/date) merged with a keyword search on the issue title.
3. **Batch detection** — a small model compares the issue against candidates in batches and returns a structured verdict (`DUP`/`UNI`) with reasoning for each.
4. **Confirmation** — each suspected duplicate is re-checked by a stronger model before being reported (disable with `confirm_duplicates: false`).
5. **Reporting** — outputs, a job summary, an upserted issue comment (one comment, updated on re-runs — never stacked), and optionally the `duplicate` label.

Structured results come from schema-validated tool calls, not free-text parsing.

## Usage

Save as `.github/workflows/issue-dedup.yml`:

```yaml
name: Issue dedup
on:
  issues:
    types: [opened, edited]
permissions:
  copilot-requests: write
  issues: write
concurrency:
  group: issue-dedup-${{ github.event.issue.number }}
  cancel-in-progress: true
jobs:
  dedup:
    runs-on: ubuntu-latest
    steps:
      - uses: kris6673/issue-dedup-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          labels: auto
          label_as_duplicate: true
```

> [!IMPORTANT]
> Copilot usage is billed to the repository owner as AI credits / premium requests. For organization-owned repositories the org policy **"Allow use of Copilot CLI billed to the organization"** must be enabled. No PAT is needed — the built-in `GITHUB_TOKEN` works with the `copilot-requests: write` permission.

## Inputs

| Input | Default | Description |
|---|---|---|
| `github_token` | (required) | Token with `copilot-requests: write` and `issues: write` |
| `github_issue` | event issue | Issue number to check (for `workflow_dispatch`) |
| `count` | `30` | Max candidate issues to compare against |
| `since` | | Only consider issues updated after this ISO 8601 date |
| `labels` | | Comma-separated label filter, or `auto` to classify first |
| `state` | `open` | Candidate issue state: `open`, `closed`, `all` |
| `max_duplicates` | `3` | Stop after this many confirmed duplicates |
| `confirm_duplicates` | `true` | Re-check suspects with the stronger model |
| `comment` | `true` | Upsert a comment listing duplicates on the issue |
| `label_as_duplicate` | `false` | Add the `duplicate` label when duplicates are found |
| `model` | `gpt-5-mini` | Model for classification and batch detection |
| `confirm_model` | `claude-sonnet-4.5` | Model for confirmation |
| `cli_version` | `latest` | `@github/copilot` CLI package version to install |
| `byok_base_url` | | BYOK: your own endpoint base URL (skips Copilot billing) |
| `byok_api_key` | | BYOK: API key for that endpoint |
| `byok_type` | `openai` | BYOK: `openai`, `azure`, or `anthropic` |

## Outputs

- `found` — `"true"` when at least one duplicate was found.
- `duplicates` — JSON array of `{ number, title, url, reasoning }`.

## BYOK

To use your own model provider instead of Copilot billing, set `byok_base_url`, `byok_api_key` (store it as a secret), and `byok_type`. When BYOK is active, `model` and `confirm_model` must be model IDs your endpoint understands.

## Development

```bash
npm ci
npm test        # typecheck + unit tests
npm run build   # bundle to dist/index.cjs (commit the result)
```

Local end-to-end run against a real issue (requires a Copilot-entitled token):

```bash
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo INPUT_GITHUB_TOKEN=$GITHUB_TOKEN \
INPUT_GITHUB_ISSUE=123 node dist/index.cjs
```

## Release

Tag and push: `git tag v1 && git push --tags` (move the `v1` tag for compatible updates).
