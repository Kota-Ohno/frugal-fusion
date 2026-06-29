# Frugal Fusion Guardrails

Project-specific constraints for Frugal Fusion. These are HARD rules; treat a
violation as a blocking issue, not a preference.

## No live model spend

- NEVER make live OpenRouter / model / provider API calls during a task.
- Do not require `OPENROUTER_API_KEY` or any network access to verify work.
- All verification must use the no-spend path: `--help`, `--preflight`,
  `validate-cases`, unit tests, typecheck, lint, and the public-release audit
  scripts. If a change cannot be verified without spend, say so explicitly and
  stop rather than spending.

## Keep generated / private artifacts out of commits

- Never stage or commit `dist/`, `node_modules/`, `.frugal-fusion/`, model or
  price snapshots, eval outputs, private reports, raw prompts/answers, private
  holdouts, extra manifests, logs, or any `.serena/` / `.takt/runs/` tool
  output. Commit only intended source, tests, docs, and config.
- After `pnpm build`, remove `dist/` again before committing.
- `examples/cases.public.jsonl` is a harness example, NOT a benchmark or
  holdout. Do not present it as evidence of a cost-performance claim.

## Public-claim safety

- The repo must stay `"private": true` and must not be described as
  open-source. Do not add public cost-performance claims; those remain blocked
  until the private-holdout / HMAC-manifest / report-verification requirements
  in `docs/PUBLIC_RELEASE_CHECKLIST.md` are satisfied.

## Style & structure

- Preserve the existing hand-rolled CLI argument-parsing style in `src/cli.ts`;
  do not introduce `commander` or other arg-parsing dependencies.
- Prefer no new runtime dependencies. If one seems necessary, justify it
  explicitly in the plan.
- Keep changes minimally scoped; mirror surrounding code (async `readFile`
  patterns, colocated `tests/**/*.test.ts`, TypeScript strictness).
