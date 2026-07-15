# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## What this is

A GitHub Action (Node 24, TypeScript) that detects duplicate GitHub issues using the Copilot SDK for LLM reasoning, then comments, labels, and sets outputs. Runs from a committed bundle at `dist/index.cjs`.

## Commands

```bash
npm ci
npm test              # typecheck + all unit tests
npm run typecheck     # tsc --noEmit only
npm run build         # esbuild bundle to dist/index.cjs — commit the result
node --experimental-strip-types --test src/util.test.ts   # single test file
```

**`dist/` is committed and CI enforces it's current** (`git diff --exit-code dist/`). After any `src/` change, run `npm run build` and commit `dist/index.cjs` together with the source, or CI fails.

Local end-to-end run against a real issue (needs a Copilot-entitled token):

```bash
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo INPUT_GITHUB_TOKEN=$GITHUB_TOKEN \
INPUT_GITHUB_ISSUE=123 node dist/index.cjs
```

## Architecture

Source is ESM TypeScript with explicit `.ts` import specifiers, run directly by Node's type stripping in tests and bundled to CJS by esbuild for the action runtime.

Pipeline (all in `src/main.ts`): optional label classification (`labels: auto`, small model) → candidate retrieval → batch duplicate detection in chunks of 15 (small model, `DUP`/`UNI` verdicts) → per-suspect confirmation (stronger model, on by default) → reporting (outputs, job summary, upserted comment, optional `duplicate` label).

- `src/copilot.ts` — Copilot SDK wrapper. `runStructured()` is the only LLM entry point: it exposes the Zod schema as a single `report_result` tool the model must call — that tool call is the structured-output channel (the SDK has no native JSON-schema response format; free-text JSON is a fallback only). Also: runtime install of the `@github/copilot` CLI into the runner temp dir (the SDK's own resolution doesn't survive esbuild bundling), and best-effort usage/billing metrics that must never fail the action.
- `src/github.ts` — Octokit helpers. `listCandidates()` merges recently-updated issues with GitHub's hybrid semantic/keyword search on the issue title (search failure is non-fatal). `upsertComment()` finds this action's single prior comment via `COMMENT_MARKER` and only trusts comments authored by the token's own identity.
- `src/util.ts` — pure helpers: `scrubbedEnv()`, `normalizeCopilotCliVersion()`, comment body building.
- `action.yml` — input/output contract. New inputs need matching `core.getInput()` defaults in `main.ts` and a row in the README inputs table.

Tests are colocated `src/*.test.ts` using `node:test`, covering the pure logic (util, github/copilot helpers) — nothing mocks the LLM.

## Security invariants (do not weaken)

- Issue titles/bodies are untrusted model input: they go into prompts wrapped in `<issue-data>` blocks with the `UNTRUSTED_DATA_NOTICE` framing. Keep that framing on any new prompt.
- Child processes (npm install, the Copilot CLI) get `scrubbedEnv()`: no `INPUT_*` or credential-looking variables. Auth is injected by the SDK from `gitHubToken` only.
- The Copilot CLI install is pinned to an exact version by default with `--ignore-scripts`; `cli_version` accepts only `latest` or an exact semver (validated in `normalizeCopilotCliVersion`).
- Never log prompts, issue content, or raw SDK metrics — the usage log is aggregate numbers only.

## Commits and releases

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`; `feat!:`/`BREAKING CHANGE:` for breaking changes to the action's input/output contract.
- Version per SemVer: breaking input/output changes = major, new inputs/features = minor, fixes = patch. Bump `version` in `package.json` accordingly.
- Release by tagging: `git tag vX.Y.Z && git push --tags`, then move the floating major tag (`v1`) to the new release for compatible updates.

## Conventions

- Line endings are LF everywhere (enforced via `.gitattributes`) so the CI dist check is stable across platforms.
- `README.md` documents every input/default — keep it in sync with `action.yml`.
