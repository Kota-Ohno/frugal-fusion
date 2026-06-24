# Frugal Fusion

Cost-aware multi-model deliberation over OpenRouter. The current implementation is a Phase 1 vertical slice: direct baseline, self-review baseline, same-model repeated-sampling baseline, two-candidate fusion, one aggregator, typed traces, hard budgets, deterministic tests, and a small CLI.

This is a cheap fixed-panel evaluation harness, not a Fugu clone or a claim that fusion is better. Treat model-output determinism as best-effort even when seeds are configured.

## Setup

```bash
pnpm install
export OPENROUTER_API_KEY="..."
```

Fetch a current OpenRouter price snapshot:

```bash
pnpm tsx src/cli.ts models --out .frugal-fusion/models.json
```

Use `pnpm tsx src/cli.ts --help` or `pnpm tsx src/cli.ts <command> --help` for command help. Help paths do not require an API key, model snapshot, case file, or network access.

Run one request:

```bash
pnpm tsx src/cli.ts ask "Give a concise migration plan for a small TypeScript service" --mode fusion --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json
```

`--mode auto` is currently a direct-only MVP placeholder, not adaptive routing. It records `metadata.autoRouting.strategy: "direct_only_mvp"` so runs are distinguishable from explicit `direct` requests without spending extra calls.

Run the sample evaluation:

```bash
pnpm tsx src/cli.ts eval examples/cases.jsonl --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json --out .frugal-fusion/eval-result.json --public-out .frugal-fusion/eval-public.json --trials 3
```

Preview the whole-run evaluation shape before any model spend or API-key requirement:

```bash
pnpm tsx src/cli.ts eval examples/cases.jsonl --preflight --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json --trials 3 --preflight-out .frugal-fusion/eval-preflight.json
```

The preflight JSON is a local aggregate planning artifact, not a public report. It omits case IDs, category labels, task text, manifest digests, model IDs, and price rows by default. It reports maximum planned call attempts, configured run budget ceiling, completion-token cost upper bound from the loaded price snapshot, and a partial prompt-cost estimate for known initial request prompts only; self-review final and aggregation prompt costs depend on generated outputs and remain authoritative only after provider usage is validated. Use `--max-planned-call-attempts N` and `--max-planned-completion-cost-usd N` to make CI fail before spend when a run is larger than intended.

Bind an evaluation to a frozen case manifest before any model calls:

```bash
pnpm tsx src/cli.ts eval private-holdout.jsonl --models .frugal-fusion/models.json --config pinned-public-config.json --out .frugal-fusion/eval-result.json --public-out .frugal-fusion/eval-public.json --case-manifest private-holdout.manifest.json --case-manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY
```

For `holdout` manifests, evaluation binding requires HMAC mode. Manifest-bound public reports also require static public-readiness checks before spend: the config must pin exactly one full `provider.order` endpoint with `allow_fallbacks: false`, and `--bootstrap-samples` must be at least 500. A verified HMAC binding is stored only in the private report; public reports disclose that the private report was bound, but omit case-set digests, row hashes, manifest paths, and HMAC key details.

Validate the larger public sample case set without an API key, model snapshot, or network calls:

```bash
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl
```

Refresh its manifest when intentionally changing the public sample:

```bash
pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl --manifest-out examples/cases.public.manifest.json --intended-use public_sample --source-label examples/cases.public.jsonl --public-category-labels --public-case-ids
```

For a private-audit manifest that should be reproducible only by auditors who share a secret, use HMAC mode:

```bash
export FRUGAL_FUSION_MANIFEST_HMAC_KEY="$(openssl rand -base64 32)"
pnpm tsx src/cli.ts validate-cases private-holdout.jsonl --manifest-out private-holdout.manifest.json --intended-use holdout --manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY
```

To make CI fail when a case set is not even eligible for public cost-performance claims, add the no-spend claim gate:

```bash
export FRUGAL_FUSION_MANIFEST_HMAC_KEY="$(openssl rand -base64 32)"
pnpm tsx src/cli.ts validate-cases private-holdout.jsonl --manifest-out private-holdout.manifest.json --intended-use holdout --manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY --claim-gate public_cost_performance
```

When validation and claim-gate assessment run successfully, stdout contains parseable public JSON. Exit code 2 means `claimGate.blockers` are present; in that case manifest output is skipped so a blocked gate does not leave a disclosure artifact behind. Exit code 0 means only that the case-set constraints were met; `claimGate.overallClaimStatus` remains `external_evidence_required`. The gate blocks exact duplicate scored case content, computed over task, constraints, smoke flag, and grader while ignoring case IDs, categories, and difficulty labels, because duplicated scored evidence can inflate denominators and confidence intervals. It also blocks high-confidence lexical near duplicates over scored task and constraint text only, with aggregate count-only public evidence. It also requires every scored case to carry closed-enum difficulty metadata (`easy`, `medium`, or `hard`), at least 30 scored cases in each difficulty bucket, at least five scored cases in each difficulty bucket within every claim-eligible category, and at least five non-surface grader-evidence scored cases in each difficulty bucket. These are coverage floors, not proof of semantic difficulty calibration, semantic near-duplicate detection, or tuning-contamination detection. In claim-gate mode, parse and validation failures are reported as generic public JSON so CI logs do not expose case IDs, taxonomy, grader values, source IDs, or claim snippets. Private holdout claim gates require HMAC manifests; unsalted SHA-256 manifests remain usable for intentionally public samples but do not pass private holdout claim gates.

`examples/cases.public.jsonl` is an equal-count public harness sample across nine coarse categories, including a synthetic `citation_mechanics` category that exercises bracket citation discipline without claiming semantic source entailment and a small number of strict `choice` cases that exercise closed-label grading behavior. Each category has six cases with author-supplied closed-enum difficulty coverage metadata of two `easy`, two `medium`, and two `hard` cases. It is not a locked benchmark or holdout; those labels are coverage metadata, not calibrated benchmark difficulty. `examples/cases.public.manifest.json` uses schema `frugal-fusion-case-set-manifest-v4` and freezes its current identity with raw-file and canonical case-set fingerprints, row hashes, grader mix, grader evidence tiers, aggregate difficulty coverage, and explicit claim-readiness warnings. Manifest row hashes are unsalted and include grader values and difficulty metadata, including choice labels, citation source IDs/claim snippets, and schema-subset literals such as enum values and property names, so default manifests are linkability artifacts: publish them only for intentionally public or frozen case sets. HMAC manifests replace raw SHA-256 digests with keyed `*HmacSha256` digests and reject source labels, public category labels, public case IDs, and `--private` summaries; they still expose structural metadata such as row count, line numbers, row order, generated row IDs, smoke flags, grader families, grader evidence tiers, aggregate difficulty coverage, and aggregate balance. The default validation summary and manifest omit raw category labels, case IDs, and source paths; opt into those only with `--public-category-labels`, `--public-case-ids`, and `--source-label` on non-HMAC manifests. Claim gates reject source labels, public category labels, and public case IDs so CI logs and blocked artifacts stay public-safe. Use `--private` only for local taxonomy checks, and do not combine it with `--claim-gate`. Use `--allow-smoke-only` only when intentionally validating smoke-only files.

Use `--public-out` to write a shareable allowlisted projection. Public reports use `schemaVersion: "frugal-fusion-public-eval-v11"` and include a machine-readable `claimGate` over public evidence plus no-digest private-report attestations. Public cost-performance claim gates require the exact fixed MVP evaluation matrix (`direct`, `self_review`, `repeated`, and `fusion`) with no unknown, duplicate, or extra config IDs, one scored attempt for every scored case-trial in each required configuration, case-cluster bootstrap task pass-rate intervals at the 95% level with at least 500 resamples, cost-per-pass intervals for each required configuration, and private run-provenance evidence that OpenRouter routing used one exact provider endpoint with fallbacks disabled; direct-vs-fusion pairing and top-level delta intervals remain the directional comparison basis. Published category rows now include within-category task pass-rate and pass-rate-delta intervals using the same case-cluster bootstrap metadata, but category-level cost intervals remain omitted and category deltas are descriptive only. The public disclosure includes no-digest status for the private report's case-set claim gate, manifest binding, and run provenance when the persisted private report carries those fields; v11 also requires the current top-level public schema, known case-manifest and run-provenance schema/fingerprint/canonicalization/content labels, and exact no-digest disclosure shapes for the disclosure root, case-manifest binding, case-set claim gate, run-provenance root, resolved config, model-price snapshot, fixed OpenRouter request policy, and provider endpoint routing. The private report stores provider routing evidence, including `allowFallbacks`, ordered provider slugs, slug count, and full-endpoint count; the public report exposes only the closed pinning status. The claim gate blocks malformed public disclosure contracts that fail to keep model, price, prompt, trace, manifest digest, run-provenance digest/path, OpenRouter request-policy digest/details, case-set gate details, or provider routing details redacted or omitted. The no-digest run-provenance evaluated-config count must match the public report and fixed MVP matrix, and the provider endpoint pinning status must be `single_provider_endpoint_pinned`; these are consistency checks, not public proof of config identity or account routing custody. The private run provenance can also include self-reported normalized `cli eval` invocation context. Public reports omit config/model digests, request-policy digests/details, provider routing slugs/details, source paths, normalized invocation details, model IDs, prices, commands, and environment details. If `--public-out` is supplied without `--out`, the CLI writes only the public report and does not create the default private report unless `--case-manifest` is also supplied; in that public-only mode, run provenance and case-set gate attestations are not marked present and public cost-performance claim gates remain blocked. Manifest-bound public reports always keep a private report because the public binding and case-set gate disclosures are assertions from that private artifact. When `--public-out` and `--case-manifest` are combined, a blocked no-spend case-set claim gate, missing exact provider endpoint pinning, or fewer than 500 bootstrap resamples fails before model calls, model-snapshot loading, or output writes.

Use `verify-public-report` to re-check a saved public report without an API key, model snapshot, private report, manifest, case file, network call, or model spend:

```bash
pnpm tsx src/cli.ts verify-public-report .frugal-fusion/eval-public.json
```

The verifier recomputes the current public claim gate from the public `schemaVersion`, `configs`, `disclosure`, and `metrics`, checks that the embedded `claimGate` matches, checks that public row-level outcomes support aggregate case, scored-attempt, pass-rate, direct-vs-fusion pairing, and fusion-harm metrics, and rejects malformed or extra top-level and nested allowlisted public artifact fields. Exit code 0 means the public artifact shape is current, the public cases match the published aggregate metrics, the embedded gate is consistent, and the recomputed gate has no blockers. Exit code 2 emits public-safe JSON when the report is stale, malformed, blocked, or mismatched. It is not a private reproduction verifier and does not prove holdout isolation, model/provider custody, price provenance, or account routing settings.

The evaluation runner compares:

- `direct`: one inexpensive model call.
- `self_review`: the direct model drafts, then reviews/repairs once.
- `repeated`: the same inexpensive model generates two independent candidates, then the aggregator selects/synthesizes.
- `fusion`: two distinct configured inexpensive candidates generate independently, then the aggregator selects/synthesizes.
- `auto`: currently resolves to `direct` with explicit direct-only routing metadata; adaptive routing is deferred until fixed-mode traces justify it.

Evaluation reports include trial-aware metrics: pass rate, cost per pass, mean cost per scored attempt, direct-paired win/loss/tie counts, fusion harm, execution-position counts, grader evidence tiers, descriptive category breakdowns, and case-cluster bootstrap confidence intervals. Smoke-only cases are excluded from scored metrics and reported through smoke completion rate.

Use `--bootstrap-samples N` to change the confidence-interval resample count. The default is 500, and public cost-performance report gates require at least 500 resamples.

Metrics that were not actually measured, such as direct-paired deltas in a fusion-only run, are reported as `null` rather than zero.

Evaluation cases can use optional closed-enum difficulty metadata (`easy`, `medium`, or `hard`) plus text, strict choice, strict JSON path/schema-subset, finite numeric, and citation-mechanics graders. Choice graders require the model to return exactly one allowed label after normalization; `choice_valid` checks the label is allowed and `choice_expected` checks it is the expected label. JSON graders parse the answer as strict JSON only. `json.schemaSubset` uses Frugal Fusion's internal schema subset, not full JSON Schema; supported keywords are `type`, object `properties`/`required`/explicit `additionalProperties`, array `items`, string `enum`, and numeric `minimum`/`maximum`. Numeric graders use a finite number with absolute tolerance and optional bounds. Citation graders only verify bracketed source IDs such as `[S1]`, required cited sources, minimum cited-source counts, and literal claim snippets followed by the required citation within a bounded window, with optional immediate placement for required literal claims; they are not semantic source-entailment judges. Grader evidence tiers are derived before model calls from configured grader families: `structured_or_exact`, `surface_text`, `mixed`, `smoke_only`, or `ungraded`. They describe the shape of deterministic evidence, not task difficulty, holdout quality, or semantic grading strength.

Public reports omit prompts, answers, traces, raw case IDs, raw category labels, model/provider IDs, provider routing slugs, price snapshots, usage rows, raw failure details, per-case costs, private report hashes, case-set digests, row hashes, manifest paths, config/model provenance digests, command lines, and HMAC key details. They still include generated row labels, generated category labels when category breakdowns meet the disclosure floor, per-case pass/fail outcomes, grader check kinds, top-level and category-level grader evidence tier counts, configuration IDs, failure status categories, a no-digest case-manifest binding disclosure, no-digest private case-set claim-gate status, no-digest private run-provenance status, and no-digest provider endpoint pinning status. If the evaluated case file or manifest is public and ordered, row-level and generated-category outcomes can be linked back to that public artifact. The private report is required for full reproduction.

Do not treat the public sample case set as proof that fusion is better. Public cost-performance claims need a frozen case version, a holdout split that was not used while tuning prompts/models, the fixed MVP matrix (`direct`, `self_review`, `repeated`, and `fusion`) on the same cases, enough category-level evidence to explain where fusion helps or harms, confidence intervals, and a private reproduction package with model/provider, price, OpenRouter request-policy provenance, and exact provider endpoint routing evidence. The case-set and public-report claim gates can block missing or underpowered evidence, including scored evidence with fewer than five non-surface grader-evidence cases overall or in any claim-eligible category; the no-spend case-set gate also blocks exact duplicate and high-confidence lexical near-duplicate scored case content plus missing or underpowered difficulty, category-by-difficulty coverage, and non-surface grader-evidence coverage by difficulty. Public-report gates require the exact holdout's no-digest passing case-set gate attestation, all required matrix cells, and no-digest private evidence that `provider.order` selected one full endpoint slug with `allow_fallbacks: false`, but they do not expose or independently re-check the case-set gate's detailed blockers or private account routing settings. They cannot approve the public claim by themselves; public-report `claimGate.directionalComparison` is descriptive, not a leaderboard verdict. Public category breakdowns are descriptive only: they use pseudonymous generated labels, suppress any category with fewer than five scored cases, include category-level grader evidence tier counts, warn on small tier cells, and recommend at least 30 scored cases per category before making category-level claims.

## Verification

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

## Safety Defaults

- Prices come from a model snapshot or OpenRouter's model endpoint, not hard-coded rates.
- Missing or stale model pricing fails closed.
- Fixed-baseline model roles reject managed OpenRouter router slugs such as `openrouter/fusion`, `openrouter/auto`, `openrouter/free`, `openrouter/pareto-code`, and `openrouter/bodybuilder`, latest-resolution aliases beginning with `~`, and model variant suffixes such as `:online`, `:nitro`, and `:exacto`. Managed Fusion/search/router comparisons belong in separately labeled external-reference runs.
- OpenRouter calls explicitly disable default web-search, response-healing, context-compression, Fusion, and Pareto Router plugins, request router metadata, and fail closed unless successful responses report `strategy: "direct"` and no pipeline stages. Metadata omissions from response-cache hits, organization-enforced plugin defaults, or future unknown pipeline stages are expected fixed-baseline blockers; diagnose them by checking the private failure status and OpenRouter account/plugin settings. The private run provenance binds this request policy; public reports disclose only that the private field exists, not the digest or detailed policy.
- Optional `provider.order` entries must be lowercase OpenRouter provider slugs. A public cost-performance claim gate passes only when private run provenance reports one full provider endpoint slug, such as `deepinfra/turbo`, with `allow_fallbacks: false`; base slugs, multiple ordered providers, and missing order remain valid for exploratory runs but block public claims.
- Prompt and answer text retention is off by default in evaluation reports; reports keep prompt hash/length plus cost and metadata unless explicitly configured otherwise.
- Public evaluation reports are built from an allowlist, not by redacting internal reports.
- Provider routing defaults to no fallback, required parameters, and `data_collection: "deny"`.
- Candidate outputs are supplied to the aggregator as untrusted data.
- Candidate identities and configured model identifiers are scrubbed before aggregation; model mapping stays in result metadata.
- The `frugal-fusion-prompts-v2` aggregation ledger records compact coverage gaps and unique adopted claim IDs for private audit, not public claim approval.
- Aggregator ledger claim IDs are validated against blinded candidate claims; stale, unblinded, or invented IDs fail as invalid aggregator output.
- One failed candidate marks fusion as degraded only if the aggregator still produces a final answer.
- Paid usage from failed calls is counted only after passing the same usage validation as successful calls.
- Raw failure messages are not retained in evaluation reports by default; reports keep bounded status-derived messages.
- Grader diagnostics are symbolic by default and do not include answer snippets, extracted values, or expected values.
- Citation grader diagnostics are symbolic and do not include source IDs, required claim text, or source text.
- Explicitly retained outputs are capped and include truncation/hash metadata.
- Sampling parameters are explicit in config and call metadata. Seeds are not sent by default; when enabled, they are sent only for models whose snapshot reports seed support.
- Evaluation trials include trial identity in seed material and order rotation metadata. Seeds remain best-effort provider hints, not a determinism guarantee.
- Repeated sampling uses the same candidate prompt twice; diversity comes from configured sampling, not role-prompt differences.
- Configured `promptVersion` must match the active prompt/schema contract, so stale configs cannot label v2 aggregation runs as v1.
