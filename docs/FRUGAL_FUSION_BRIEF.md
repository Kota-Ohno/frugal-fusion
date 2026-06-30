# Frugal Fusion Brief

Frugal Fusion asks whether a selectively invoked ensemble of inexpensive models can deliver better task success per dollar than a strong inexpensive single model, self-review, or equal-cost repeated sampling.

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
