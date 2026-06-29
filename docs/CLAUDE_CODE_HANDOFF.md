# Claude Code Handoff

Date: 2026-06-29
Branch: `codex/public-report-hardening`

## Current Objective

Prepare Frugal Fusion for a safer public-repository release without enabling
public cost-performance claims or live model spend.

This branch hardens no-spend public release gates around:

- public report claim safety;
- public sample manifest intent and claim readiness;
- no-spend CI workflow constraints;
- repository publication guards;
- high-confidence secret scanning;
- path-level hygiene for private/generated artifacts in the current release
  candidate tree.

## Recent Commits

- `73954dc` Add public report verifier
- `01be31c` Gate manifest public evals before spend
- `aab7a4f` Improve public sample evidence mix
- `0a5dbd4` Add public release contribution docs
- `a59e8e7` Add no-spend CI workflow
- `255c0a7` Add public release audit script
- `7b50059` Add public secret scan guard
- This handoff commit adds current-tree public artifact path hygiene, focused
  tests, documentation updates, and this handoff note.

## Latest Slice

`scripts/public-release-audit.mjs` now scans tracked files plus untracked
non-ignored files and blocks release-candidate paths that look like private
holdouts, private reports, generated eval reports, model/price snapshots,
provider-routing artifacts, raw prompts/answers, extra manifests, or unapproved
JSONL case sets.

The path guard intentionally does not exempt `docs/`, `tests/`, `src/`, or
`scripts/`. Generated/private artifact-like names should be blocked wherever
they appear in the release candidate. Source-style camelCase names such as
`src/evalPreflight.ts` remain allowed because matching uses normalized token
boundaries rather than broad substring checks.

Failure output summarizes nested artifact paths as `root/.../basename` to avoid
printing private customer or workspace names.

## Verification

Last known no-spend verification commands for this handoff all passed:

```bash
pnpm vitest run tests/publicReleaseAudit.test.ts
pnpm run public-release:audit
pnpm run format:check
pnpm run public-release:secrets
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl
pnpm tsx src/cli.ts --help
node dist/src/cli.js --help
ruby -e 'require "yaml"; workflow = YAML.load_file(".github/workflows/no-spend-ci.yml"); raise "missing jobs" unless workflow.fetch("jobs").key?("no-spend")'
```

No live OpenRouter/model/API calls were made.

## Known Remaining Blockers

- No git remote is configured in this local repository at handoff time, so Codex
  could commit locally but could not push or open a PR until a remote is added.
- No repository license has been chosen. `package.json` must remain
  `"private": true`, and the project should not be called open-source yet.
- A private security reporting channel still needs to be configured.
- Hosted secret scanning and push protection still need to be enabled before
  publication.
- `pnpm run public-release:audit` covers the current release-candidate tree. It
  does not replace manual release-history path review, prose/source semantic
  review, or host-side secret scanning.
- Public cost-performance claims remain blocked until the private holdout,
  HMAC manifest, endpoint pinning, bootstrap interval, private reproduction
  artifact, and report-verification requirements in
  `docs/PUBLIC_RELEASE_CHECKLIST.md` are satisfied.

## Suggested Next Steps

1. Add or confirm the intended remote, then push this branch and open a review
   PR.
2. Decide license and package-publication policy, or keep the current guards.
3. Configure private vulnerability reporting and hosted secret scanning.
4. Add an explicit release-history path-hygiene process if the repository will
   be published from existing history instead of a fresh sanitized export.
5. Only after public repository blockers are closed, plan the private holdout
   evidence workflow for any cost-performance claim.

## Operational Notes

- Keep generated `dist/`, `.frugal-fusion/`, logs, private reports, model
  snapshots, and evaluation outputs out of commits unless a maintainer
  explicitly approves a sanitized artifact.
- After running `pnpm build`, remove `dist/` again before committing unless the
  release process changes.
- The public sample at `examples/cases.public.jsonl` is a harness example, not a
  benchmark or holdout.
