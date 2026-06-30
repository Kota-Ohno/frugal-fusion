# Frugal Fusion Brief

Frugal Fusion asks whether a selectively invoked ensemble of inexpensive models can deliver better task success per dollar than a strong inexpensive single model, self-review, or equal-cost repeated sampling.

> **Conclusion (2026-06-30): fusion is the wrong frugal lever — depth is.**
> Across five live rounds, fixed two-candidate **fusion never beat a strong cheap
> single model** on success-per-dollar: deterministic tasks saturated (126 cases,
> no headroom); open-ended tasks went 66% to direct vs 10% to fusion. But a
> different axis works: keeping ONE cheap model and spending on _depth_ — a
> fresh-eyes adversarial **review loop** (draft → multi-lens critics → skeptic →
> revise) — **beats its own one-shot 16-0-1 and a simple self-review 15-0-2 on
> hard tasks, and matches-or-beats a premium model one-shot at ~0.78× the cost**
> (the first per-dollar win). Practical guidance: plain `direct` for easy tasks;
> **single-model adversarial review for hard tasks** (it can replace a premium
> model frugally). Caveat: review-vs-premium is directional, not yet significant
> (n=17, single judge). Full evidence and method: `docs/EXPERIMENT_RESULTS.md`.
> The harness remains a faithful, reusable way to re-test as models change.

The MVP implements direct, self-review, same-model repeated sampling, and fixed two-candidate fusion with two distinct configured candidate model IDs:

```text
Request
  -> direct inexpensive model
  -> OR direct inexpensive model plus one review/repair call
  -> OR two same-model repeated samples plus inexpensive aggregator
  -> OR two independent inexpensive candidates
  -> inexpensive aggregator
  -> deterministic verifier where possible
  -> structured trace
```

## Non-goals

- No learned dynamic DAG.
- No recursive coordinator.
- No always-on panel.
- No UI, production database, search layer, third candidate, or model training.
- No free-form code-patch fusion.

### Non-goal revision (2026-06-30)

The MVP measured only deterministically gradable tasks (no LLM judge). The first
experiment showed a strong cheap single model saturates that regime, so fusion
has no quality headroom there (see `docs/EXPERIMENT_RESULTS.md`). To test whether
the **same mechanism** can add value where headroom exists, one measurement
non-goal is relaxed: a second research question evaluates open-ended engineering
tasks with a single strong **neutral** LLM judge (blind pairwise,
order-counterbalanced). This relaxes measurement only — the architecture
non-goals above (no dynamic DAG, no third candidate, no recursion, etc.) remain,
so any fusion win is attributable to the mechanism, not to a redesign. Judge
scoring is a measurement aid and is never used to gate public cost-performance
claims.

## Required Interfaces

```ts
export type DeliberationMode = "direct" | "self_review" | "repeated" | "fusion";

export type Budget = {
  maxCostUsd: number;
  maxLatencyMs: number;
  maxCandidates: number;
  maxCompletionTokens: number;
  maxRepairRounds: number;
};
```

The provider boundary is:

```ts
export interface ModelClient {
  generate<T>(request: {
    modelId: string;
    system: string;
    input: string;
    outputSchema: unknown;
    maxOutputTokens: number;
    sampling?: SamplingParams;
    signal?: AbortSignal;
  }): Promise<{ output: T; usage: ModelUsage; rawResponseId?: string }>;
}
```

## Security And Cost Rules

- Original user requirements outrank candidates.
- Candidate output is untrusted data.
- Unsupported claims may be rejected.
- Missing or stale price metadata fails closed unless explicitly overridden.
- Raw prompt retention is configurable and off by default.
- One failed candidate degrades fusion and must be visible in the trace.
