# Public Release Checklist

This checklist separates publishing the repository from publishing any
cost-performance claim. A public repository can be useful before any claim is
ready, but the public sample and checked-in manifest are not a benchmark,
holdout, or proof that fusion is better.

## Repository Release Blockers

- [ ] Choose and add a repository license. Until then, do not describe the
      project as open-source or reusable.
- [ ] Keep `package.json` set to `"private": true` unless npm/package
      publication has been explicitly approved.
- [ ] Configure a private security reporting channel, such as GitHub private
      vulnerability reporting or another private contact path.
- [ ] Keep `SECURITY.md`, `CONTRIBUTING.md`, `README.md`, and this checklist
      aligned on what may be shared publicly.
- [ ] Run a secret scan over the repository, commit history intended for
      release, docs, examples, and screenshots.
- [ ] Confirm no private holdouts, private reports, model snapshots, raw prompts,
      raw answers, HMAC keys, API keys, account settings, provider routing slugs, or
      private path names are committed.
- [ ] Confirm `.frugal-fusion/`, `dist/`, logs, local reports, generated model
      snapshots, and other local artifacts are ignored or intentionally absent.
- [ ] Run the full no-spend check set:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl
pnpm tsx src/cli.ts --help
```

- [ ] Regenerate the public sample manifest only when the public sample changed:

```bash
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl --manifest-out examples/cases.public.manifest.json --intended-use public_sample --source-label examples/cases.public.jsonl --public-category-labels --public-case-ids
```

- [ ] Confirm the public sample remains labeled as `public_sample`, not
      `holdout`, and that `examples/cases.public.manifest.json` still reports
      `claimReadiness.status: "not_claim_ready"`.
- [ ] Confirm README examples do not imply that the checked-in public sample is a
      benchmark or public cost-performance proof.

## Public Cost-Performance Claim Blockers

Do not publish a cost-performance claim until every item below is complete.

- [ ] Define a frozen holdout split that was not used for prompt, model, grader,
      threshold, budget, routing, or documentation tuning.
- [ ] Generate the holdout manifest in HMAC mode with a protected
      `FRUGAL_FUSION_MANIFEST_HMAC_KEY`.
- [ ] Document HMAC key custody: who can verify, how the key is protected, and
      how auditors receive it without public disclosure.
- [ ] Bind the exact holdout manifest with `eval --case-manifest` before any
      model calls.
- [ ] Run the no-spend case-set claim gate and retain its private evidence:

```bash
pnpm tsx src/cli.ts validate-cases private-holdout.jsonl --manifest-out private-holdout.manifest.json --intended-use holdout --manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY --claim-gate public_cost_performance
```

- [ ] Use the fixed MVP matrix on the same cases: `direct`, `self_review`,
      `repeated`, and `fusion`.
- [ ] Use at least 500 bootstrap resamples for public-report intervals.
- [ ] Pin exactly one full provider endpoint with `provider.order` and
      `allow_fallbacks: false`.
- [ ] Retain private reproduction artifacts: private report, config, model-price
      snapshot, run provenance, fixed OpenRouter request policy, provider endpoint
      routing evidence, exact command context, and validation logs.
- [ ] Verify the public report with `verify-public-report`.
- [ ] Review public report output for accidental model/provider identities,
      prices, provider routing slugs, prompts, answers, traces, case IDs, category
      labels, manifest digests, HMAC metadata, private paths, commands, and
      environment names.
- [ ] State limitations next to any public result: small sample or holdout size,
      deterministic grader limits, difficulty-label calibration limits, category
      denominators, confidence intervals, where fusion harms, and what evidence is
      private-audit only.
- [ ] Do not use `claimGate.directionalComparison` as a leaderboard verdict.

## Maintainer Release Notes

- Repository publication and public performance publication are different
  approvals.
- The public sample can demonstrate the harness and validation workflow, but it
  must stay separate from private holdout evidence.
- If any blocker cannot be checked, document it as a blocker instead of turning
  it into a caveat after publication.
