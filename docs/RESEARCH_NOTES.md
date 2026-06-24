# Research Notes

Last reviewed: 2026-06-24

## What To Borrow

OpenRouter Fusion is a useful product reference because it exposes multi-model deliberation as a single model/tool surface. Its documented pipeline is panel responses in parallel, a judge that compares rather than blindly merges them, structured analysis covering consensus, contradictions, coverage gaps, unique insights, and blind spots, then a final writer step. The current docs also frame Fusion as overkill for short tactical prompts and appropriate when the cost of being wrong outweighs extra completions.

Sakana Fugu is a stronger but intentionally non-MVP reference. Fugu is described as a model-like API that decides whether to solve directly or coordinate a team, handling model selection, delegation, verification, and synthesis internally. The associated Trinity and Conductor work emphasizes adaptive model/role selection, bounded turns, verifier roles, and learned coordination under cost constraints.

Self-consistency is the cheapest nearby baseline family. It samples multiple reasoning paths and aggregates the final answer. Universal Self-Consistency extends that idea to open-ended generation by using an LLM to select among candidates.

LLM-as-judge research shows that judging is itself biased. Position bias, candidate identity leakage, and answer-order effects must be treated as experiment risks, not as theoretical footnotes.

## 2026-06-24 Official Source Refresh

- OpenRouter now documents Fusion through three related surfaces: the `openrouter/fusion` router alias, the Fusion plugin, and the beta `openrouter:fusion` server tool. The documented pipeline enables `openrouter:web_search` and `openrouter:web_fetch` for the panel and judge, then returns structured comparison analysis to the outer model. That means managed Fusion is not just "two cheap model calls plus a judge"; it is a retrieval-enabled, tool-using pipeline unless configured otherwise.
- The Fusion server tool exposes knobs that Frugal Fusion intentionally does not mirror yet: configurable panel models, a configurable judge/outer model, one to eight analysis models, and bounded tool-call loops for the inner panel/judge calls. These are useful reference dimensions for future ablations, but they would make this project less frugal and harder to interpret before fixed baselines are measured.
- OpenRouter structured-output guidance still supports the current boundary choice: use `response_format.type = "json_schema"`, strict schemas for compatible models, and `provider.require_parameters = true` so the request routes only to providers that support the requested parameters.
- OpenRouter provider routing still needs explicit control for reproducible evaluation. Default routing is price-oriented load balancing with fallbacks, while provider preferences can alter sorting and routing. Frugal Fusion keeps `allow_fallbacks: false`, `require_parameters: true`, and `data_collection: "deny"` as evaluation defaults unless a run is explicitly labeled as a provider-routing experiment.
- Those provider defaults reduce accidental routing and privacy drift, but they do not fully pin an exact provider endpoint. Public-grade external comparisons now require private run provenance showing a single full endpoint slug in `provider.order` with fallbacks disabled; public reports disclose only the closed pinning status, not the slug.
- OpenRouter plugin defaults can apply account-wide or organization-wide unless request-level settings override them. Fixed-baseline calls should therefore explicitly disable mutating plugins such as web search, response healing, context compression, Fusion, and Pareto Router, opt into router metadata, and fail closed unless metadata confirms direct routing with no pipeline stages. This conservative rule treats missing strategy, unknown strategy, and unknown pipeline stages as non-comparable rather than assuming they are harmless.
- The model-list endpoint now documents server-side filters and sort options, including supported-parameter filtering, pricing/context/performance sorts, provider filters, zero-data-retention filtering, and region filtering. This supports a future "candidate shortlisting" helper, but public comparisons should still bind the exact model-price snapshot used for a run.
- The current local price snapshot and `eval --preflight` checks are token-price planning tools for ordinary chat completions. They do not model managed Fusion tool loops, web-search/fetch charges, retrieval budgets, or hidden internal deliberation costs, so any future managed Fusion or retrieval reference should use a separate runner/schema with an expanded price and usage snapshot.
- Sakana's current Fugu pages reinforce the "not a clone" line: Fugu is positioned as a learned orchestration model behind one OpenAI-compatible API. It decides when to solve directly, when to coordinate specialists, and how to handle model selection, delegation, verification, and synthesis internally. Fugu and Fugu Ultra differ by latency/depth tradeoff, and Fugu exposes agent/provider opt-out for compliance.

## Frugal Fusion Interpretation

This project should not try to clone Fugu. A learned router, recursive agent pool, or dynamic topology would add complexity before the project has enough traces to justify it.

The public-ready MVP should instead optimize for:

- honest baselines: single cheap model, self-review, repeated sampling, heterogeneous fusion;
- hard cost and latency boundaries before and after calls;
- blinded aggregation that hides model names, prices, and candidate order;
- compact candidate schemas so the aggregator pays for comparison, not candidate prose;
- deterministic graders first, with LLM judges only as labeled weak evidence;
- reproducible traces containing prompt version, model config, price snapshot, usage, failures, latency, and grader result.

## Current Design Implications

- Keep the next local work focused on fixed-panel evaluation quality, not adaptive routing. Fugu-style learned routing is a later research direction once traces show where fixed direct, self-review, repeated, and heterogeneous fusion baselines fail.
- Treat runtime `auto` as a documented direct-only placeholder until those traces exist. A task-shape heuristic router would look product-like but would blur the fixed-mode evaluation question before there is evidence that escalation improves cost per pass.
- Keep Fusion-like comparison structure: candidate answers are untrusted inputs, aggregation should compare consensus, contradictions, coverage gaps, unique adopted claims, and blind spots instead of blindly merging prose.
- Keep search and evidence acquisition out of the fixed-panel MVP. Managed OpenRouter Fusion currently includes web search/fetch in its inner deliberation path, so any future comparison against it must either label Fusion as an external reference condition or introduce a matched shared-evidence budget for all baselines.
- Reject non-concrete model aliases in ordinary fixed-baseline configs. Managed router slugs such as `openrouter/fusion`, `openrouter/auto`, `openrouter/free`, `openrouter/pareto-code`, and `openrouter/bodybuilder`, latest-resolution aliases beginning with `~`, and model variant suffixes such as `:online`, `:nitro`, and `:exacto` introduce routing, tool, retrieval, version-resolution, or provider-sorting conditions that do not belong in direct/self-review/repeated/fusion baseline cells.
- Do not add a third candidate or configurable inner tool loops until fixed direct, self-review, repeated, and two-candidate fusion traces show a marginal-rescue pattern that justifies the added cost and latency.
- Treat prompt/schema changes as new evaluation conditions. The `frugal-fusion-prompts-v2` aggregator ledger adds compact `coverageGaps` and `uniqueAdoptedClaimIds` fields, validates ledger claim IDs against blinded candidate records, rejects duplicate or contradictory claim dispositions, and treats uniqueness as insufficient evidence by itself.
- Treat vendor benchmark claims as directional product evidence, not independent proof. This project needs its own versioned case manifest, private reproducibility data, and public caveats before making cost-performance claims.
- Use manifests as explicit case-set identity artifacts. Public reports should continue omitting private case-set hashes by default; intentionally public samples can carry a separate manifest.
- Do not treat the current keyword-heavy public sample as a benchmark. It exercises the harness, author-supplied difficulty coverage metadata, citation-mechanics checks, and grader mix, while richer graders, calibrated difficulty review, semantic source-entailment evidence, and holdout process evidence remain required.
- Expose grader evidence tiers as disclosure metadata so fixed-panel results can be interpreted against the mechanical shape of the graders without pretending those tiers measure semantic difficulty or benchmark quality.
- Use no-spend category-by-difficulty coverage floors to reduce obvious difficulty/category confounding before model spend. This is a cheap case-set hygiene check, not evidence that difficulty labels are calibrated or that cells are semantically balanced.
- Use no-spend non-surface grader-evidence floors by difficulty to prevent structured/exact/numeric/citation evidence from being concentrated in one difficulty bucket. This is still a cheap evidence-shape hygiene check, not semantic difficulty calibration.
- Use citation-mechanics graders as a cheap intermediate step before any LLM judge or semantic entailment grader. They can validate bracketed source-id discipline and literal claim/citation proximity, but should be described as mechanical citation evidence rather than source grounding.
- Use keyed HMAC manifest digests for private holdouts when unsalted row hashes would make prompts or answer keys linkable. Node's stable `node:crypto` module supports `createHmac("sha256", key).update(...).digest("hex")`; keep the key out of manifests and logs.
- Bind evaluation runs to frozen manifests before model spend, but keep public reports digest-free. The public artifact should disclose that a private report was bound to a manifest and that its no-spend case-set gate passed, while auditors use the private report and HMAC key to verify the exact holdout.

## Sources

- OpenRouter Fusion Router documentation: https://openrouter.ai/docs/guides/routing/routers/fusion-router
- OpenRouter Fusion plugin documentation: https://openrouter.ai/docs/guides/features/plugins/fusion
- OpenRouter Fusion server tool documentation: https://openrouter.ai/docs/guides/features/server-tools/fusion
- OpenRouter plugins overview: https://openrouter.ai/docs/guides/features/plugins/overview
- OpenRouter router metadata documentation: https://openrouter.ai/docs/guides/features/router-metadata
- OpenRouter message transforms documentation: https://openrouter.ai/docs/guides/features/message-transforms
- OpenRouter latest model resolution documentation: https://openrouter.ai/docs/guides/routing/routers/latest-resolution
- OpenRouter Pareto Router documentation: https://openrouter.ai/docs/guides/routing/routers/pareto-router
- OpenRouter Body Builder documentation: https://openrouter.ai/docs/guides/routing/routers/body-builder
- OpenRouter Online variant documentation: https://openrouter.ai/docs/guides/routing/model-variants/online
- OpenRouter Nitro variant documentation: https://openrouter.ai/docs/guides/routing/model-variants/nitro
- OpenRouter Exacto variant documentation: https://openrouter.ai/docs/guides/routing/model-variants/exacto
- OpenRouter structured outputs documentation: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter provider routing documentation: https://openrouter.ai/docs/guides/routing/provider-selection
- OpenRouter model-list API documentation: https://openrouter.ai/docs/api/api-reference/models/get-models
- OpenRouter Fusion launch analysis: https://openrouter.ai/blog/announcements/fusion-beats-frontier/
- Sakana Fugu product page: https://sakana.ai/fugu/
- Sakana Fugu release post: https://sakana.ai/fugu-release/
- Sakana Fugu technical report: https://arxiv.org/abs/2606.21228
- Trinity: An Evolved LLM Coordinator: https://arxiv.org/abs/2512.04695
- Conductor: Learning to Orchestrate Agents in Natural Language: https://arxiv.org/abs/2512.04388
- Self-Consistency paper page: https://research.google/pubs/self-consistency-improves-chain-of-thought-reasoning-in-language-models/
- Universal Self-Consistency: https://openreview.net/forum?id=LjsjHF7nAN
- LLM judge position-bias study: https://arxiv.org/abs/2406.07791
- Node.js `crypto.createHmac` documentation: https://nodejs.org/api/crypto.html
