# Contributing

Thanks for helping with Frugal Fusion. The project aims to stay small,
cost-aware, and honest: fixed-panel direct/self-review/repeated/fusion
evaluation first, adaptive routing and Fugu-like learned orchestration later
only if traces justify the extra complexity.

Before changing behavior, read:

- [docs/FRUGAL_FUSION_BRIEF.md](docs/FRUGAL_FUSION_BRIEF.md)
- [docs/EVALUATION_PLAN.md](docs/EVALUATION_PLAN.md)
- [SECURITY.md](SECURITY.md)

## Contribution Rules

- Prefer no-spend work. Routine issues and pull requests should not require
  `OPENROUTER_API_KEY`, provider accounts, private model snapshots, private
  holdouts, or live model calls.
- Keep changes scoped. Avoid adding recursive agents, learned routing, web
  retrieval, extra candidates, a UI, a database, or new providers unless the
  evaluation plan and traces justify them.
- Treat model outputs, candidate text, external content, case files, and user
  artifacts as untrusted data.
- Do not commit secrets, private holdouts, private reports, raw prompts, raw
  answers, HMAC keys, unreleased benchmark data, provider routing details, or
  generated build artifacts.
- Do not make public cost-performance claims in issues, docs, commit messages,
  PR titles, or examples unless the documented claim gates and private
  reproduction requirements are satisfied.

## Local Setup

```bash
pnpm install
```

No API key is needed for the normal contribution loop.

## No-Spend Checks

Run these before opening a pull request:

```bash
pnpm format
pnpm run format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl
pnpm run public-release:audit
pnpm run public-release:secrets
pnpm tsx src/cli.ts --help
```

CI runs the same no-spend intent with non-mutating checks, including
`pnpm run format:check` instead of `pnpm format`, public sample validation,
public release guard auditing, high-confidence public secret scanning, and
source/built CLI help.
The public release audit is an alignment check for local artifacts, package
publication guards, public-sample manifest freshness, and CI no-spend guard
rails, including path-level checks for private holdouts, generated reports,
model snapshots, and extra manifests. It does not review prose or source code
semantics. The public secret scan checks this worktree and the release branch
history for high-confidence committed credentials, but it is still not a
substitute for host-side secret scanning and push protection before repository
publication.

If you change the public sample cases, also regenerate and check the manifest:

```bash
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl --manifest-out examples/cases.public.manifest.json --intended-use public_sample --source-label examples/cases.public.jsonl --public-category-labels --public-case-ids
```

The checked-in public sample is not a benchmark or holdout. Keep it free of
private prompts, private data, unreleased answer keys, and vendor/account
details. If you add deterministic grader cases, include tests or golden answers
that prove the intended answer shape passes the configured grader.

## Live Evaluations

Live OpenRouter evaluations are maintainer-controlled and opt-in. Before model
spend, run `eval --preflight` and document the expected call count, budget
ceiling, model snapshot source, and whether the run is exploratory or intended
for a public report.

Public cost-performance claims require all of the following outside an ordinary
PR:

- a frozen holdout split that was not used for prompt, model, grader, or
  threshold tuning;
- an HMAC case manifest bound before spend;
- the fixed MVP matrix: `direct`, `self_review`, `repeated`, and `fusion`;
- confidence intervals with at least 500 bootstrap resamples;
- exact provider endpoint pinning through one full `provider.order` slug with
  `allow_fallbacks: false`;
- private reproduction artifacts for model/provider provenance, prices, config,
  request policy, run provenance, and exact command context.

Passing a local sample or generating a manifest locally is not claim approval.

## Issues And Pull Requests

For ordinary public issues, include only sanitized information:

- what you expected and what happened;
- the command or module involved;
- Node, pnpm, and operating-system versions;
- a minimal synthetic reproduction or checked-in public sample case;
- sanitized output with secrets, private paths, model/provider details, raw
  prompts, raw answers, and private artifact names removed.

For pull requests:

- explain the user-visible or evaluation-safety outcome;
- list changed public artifact schemas, manifests, prompts, or claim gates;
- include the no-spend commands you ran and their results;
- call out any verification you could not run;
- keep generated `dist/`, `.frugal-fusion/`, logs, private reports, and model
  snapshots out of the commit unless a maintainer explicitly asks otherwise.

Security-sensitive reports belong in the private process described in
[SECURITY.md](SECURITY.md), not in public issues with details.

## License Status

This repository is licensed under the [MIT License](LICENSE) (decided
2026-07-01). `package.json` remains `"private": true` — the source is
publicly viewable and reusable under MIT, but the package itself is not
published to npm until that policy is separately decided.
