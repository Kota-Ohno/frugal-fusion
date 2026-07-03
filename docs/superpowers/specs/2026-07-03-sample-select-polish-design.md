# Sample-Select-Polish: parallel-width alternative to the serial adversarial review loop

Date: 2026-07-03
Status: approved for implementation (goal-directed autonomous session)

## Problem

The current `review` arm in `scripts/review-eval.mts` (draft → 4 adversarial
lenses → skeptic → revise, up to 2 rounds) beats the cheap model's own one-shot
by +70–90% net win rate, but it is a ~7-layer serial chain of large-token calls
(~10 min/task even with task-level concurrency), and whether it reaches premium
parity depends on the cheap/premium capability gap. A 6-family literature survey
(2026-07-03, workflow `wf_ab9b68c8-d3f`) converged on one finding: under
equal-compute comparisons, serial critique/refinement gains are mostly the
ensemble effect in disguise; parallel diverse drafts + pairwise selection match
or beat serial refinement at a fraction of the wall clock. The repo's own data
agrees: aggregation-style fusion was falsified (Rounds 1–4), refinement gains
front-load in round 1, and post-generation signals are the only reliable gates.

## Design

### New arms in `scripts/review-eval.mts`

Two new modes, judged alongside the existing four:

**`ssp` (sample-select-polish)** — the main candidate:

1. **Sample**: N parallel drafts (default 6, flag `--drafts`) from the cheap
   model at temperature 0.7. Each draft is seeded with a distinct persona from a
   fixed bank of 6 reusing the existing lens framings: correctness-minded,
   edge-case-minded, requirements-minded, security-minded, plus neutral and
   simplicity-minded. Diversity moves from critique-time to draft-time.
2. **Select**: single-elimination pairwise tournament judged by the cheap model
   (temp 0, short `--select-max-tokens` budget, default 800 to absorb
   reasoning-token overhead; forced A/B choice with the same anti-verbosity
   instruction as `JUDGE_SYSTEM`). Bracket for N=6: 3 parallel matches → winner
   pool of 3 (+0 byes) → 1 match + 1 bye → final. Serial depth 3, but these are
   short fast calls. Match order alternates A/B assignment by index to avoid a
   systematic position bias (full counterbalancing is reserved for the outer
   measurement panel; internal selection tolerates more noise).
3. **Polish**: exactly ONE critique round on the tournament winner — the
   existing 4 parallel lenses + skeptic + 1 revise (WRITER model, hybrid
   supported) — then stop. No round 2.

**`ss` (sample-select)** — the ablation control: stages 1–2 only, winner
returned untouched. If `ss` ties `review`, the entire critique apparatus is
dispensable; if it loses only on trap-heavy tasks, that isolates exactly what
the polish stage buys.

### Instrumentation (fixes today's measurement gaps)

- Per-arm wall-clock milliseconds recorded per task and reported in the summary
  (mean per arm) and in the output JSON. Latency claims become measured, not
  estimated.
- `--dump-answers <dir>`: writes one JSON file per task containing every arm's
  final answer text, so future re-judging (e.g. with a different judge panel or
  bias instruction) does not require regeneration. This directly fixes the gap
  that blocked re-judging the verbosity-bias question earlier today.
- Empty-answer warnings (existing) extended to tournament calls.

### Judged pairs

Default pair set when the new arms run: `ssp vs review`,
`ssp vs premium_direct`, `ss vs review`. The full pair matrix is opt-in
(`--pairs a:b,c:d`) to keep judge cost bounded — judging already dominates cost
(~$3 of ~$7.3/run).

Arms are opt-in via `--arms review,ssp,ss` (default remains the current four
arms with the current pairs, so existing runs reproduce unchanged).

### Self-application: agent-side skill

New skill `skills/sample-select-polish/SKILL.md`: the same pipeline expressed as
agent operation — spawn N parallel subagent drafts (lens personas), a
tournament-select subagent pass, then one fresh-eyes-review round on the winner.
Cross-references `skills/fresh-eyes-review` for the polish stage and its role
bank. Marked as the generation-side complement: fresh-eyes-review is for
reviewing an existing artifact; sample-select-polish is for producing a new hard
artifact fast.

## What is deliberately NOT in scope

- Heterogeneous draft pools (Self-MoA evidence cuts against; retest later as an
  ablation of `ssp` only if `ssp` underperforms).
- Premium-writer cascade (violates the <1x frugal cost criterion ungated).
- Convergence gating of the old loop (superseded: `ssp` already caps at 1
  polish round; `--dump-answers` enables the measurement pass later).
- Debate, MCTS/LATS, aggregation fusion, PRMs, verbalized-confidence routing —
  all anti-recommended by the survey with equal-compute evidence.

## Testing

- Unit tests (vitest, no live calls): tournament bracket pairing/advancement as
  a pure function (odd pools, byes, N=2..8), persona bank integrity, arm/pair
  flag parsing, dump-file shape.
- Refactor: extract bracket logic and persona bank into
  `scripts/lib/sampleSelect.ts` (imported by the .mts script) so they are
  testable without network. `gen()` stays in the script.
- Live smoke: 2 tasks with `--arms review,ssp,ss`, verifying answers non-empty,
  elapsed logged, dump files written, judge pairs recorded. Budget ≤ ~$0.5.
- Full 48-task A/B run: requires explicit budget sign-off (≈$8–10 with judge
  panel); NOT run autonomously.

## Success criteria

1. Smoke run passes with no crashes and no systematic empty-answer warnings.
2. Measured `ssp` wall clock ≤ 0.5x `review` wall clock on the smoke tasks.
3. (Full run, later) `ssp vs review` net win-rate CI crosses zero or is
   positive, at cost ratio ≤ 1.1x review and measured latency ≤ 0.6x — i.e.
   same quality, materially faster, for the same money.
