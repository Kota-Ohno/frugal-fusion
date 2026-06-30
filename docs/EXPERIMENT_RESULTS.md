# Experiment Results — First Live Run (2026-06-29)

First live cost-performance run of the four deliberation modes against a frozen,
deterministically graded case set. Private reports live under `.frugal-fusion/`
(gitignored); this note records the findings, not reproducible claim evidence.

## Setup

- Cases: `examples/cases.experiment.jsonl` — 36 deterministic cases (12 number,
  12 choice, 12 json), balanced 4 per difficulty per type.
- Trials: 3 per case. Graders: deterministic only (no LLM judge, no substring).
- Two baselines, identical fusion candidates + aggregator:
  - `exp-strong`: direct/self_review/repeated = `google/gemini-2.5-flash`.
  - `exp-equalprice`: same roles = `google/gemini-2.5-flash-lite`.
  - Fusion candidates = `qwen/qwen3-235b-a22b-2507` + `minimax/minimax-m2.5`;
    aggregator = `google/gemini-2.5-flash`.
- Budget: maxCompletionTokens 3000, maxLatencyMs 120000, allow_fallbacks false.

## Pass rate by difficulty × mode (n = 12 per cell)

exp-strong:

| difficulty | direct | self_review | repeated | fusion |
| ---------- | -----: | ----------: | -------: | -----: |
| easy       |   100% |        100% |      86% |    75% |
| medium     |   100% |        100% |      81% |    78% |
| hard       |   100% |        100% |      75% |    72% |
| overall    |   100% |        100% |      81% |    75% |

exp-equalprice:

| difficulty | direct | self_review | repeated | fusion |
| ---------- | -----: | ----------: | -------: | -----: |
| easy       |   100% |        100% |      75% |    72% |
| medium     |    83% |         83% |      64% |    69% |
| hard       |    83% |         83% |      61% |    61% |
| overall    |    89% |         89% |      67% |    68% |

## Cost per pass (USD)

| mode        | exp-strong | exp-equalprice |
| ----------- | ---------: | -------------: |
| direct      |    0.00006 |        0.00001 |
| self_review |    0.00013 |              — |
| repeated    |    0.00247 |              — |
| fusion      |    0.00087 |        0.00098 |

(fusion ≈ 14× the cost per pass of direct in exp-strong; ≈ 98× in exp-equalprice.)

## Findings

1. **The frugal-fusion hypothesis is not supported in this regime.** A strong
   cheap single model beats the cheap ensemble on both task success and cost per
   pass, across both baselines and every difficulty bucket. The decision rule
   (fusion's cost-per-pass 95% CI below direct's, non-overlapping, in some
   bucket) is satisfied in zero buckets; the inequality runs the other way.
2. **Fusion's deficit is dominated by pipeline reliability, not reasoning.**
   Fusion's invalid_output rate is ~23% (repeated ~17%) — the cheap candidates /
   aggregator intermittently emit schema-invalid structured output, and with
   response-healing disabled (required for clean provenance) those attempts fail
   outright. Completed fusion attempts are usually correct.
3. **`self_review` is the quiet winner.** It matches direct's quality at
   near-zero extra cost and never regressed a result. Cheap quality insurance.

## Caveats / threats to validity

- **Baseline saturation.** `gemini-2.5-flash` scored 100% on every bucket, so
  this case set has no headroom to reveal a fusion benefit even if one existed.
  The "hard" bucket was not hard for the strong baseline. This is the
  deterministic-grading ⊥ headroom tension flagged before the run.
- Fusion was penalized by structured-output unreliability rather than reasoning
  quality; a fairer test would harden aggregator/candidate schema compliance
  first (e.g. aggregator repair round) or measure quality-given-completion
  separately from completion rate.

## Suggested next steps

1. Build a case set that the strong baseline does NOT saturate (calibrate
   difficulty against `gemini-2.5-flash` itself; keep only cases it fails some
   of the time but that remain deterministically checkable).
2. Separate "completion reliability" from "answer quality" in the metrics so the
   ensemble's reasoning is not conflated with its JSON robustness.
3. Optionally add a single aggregator repair round to remove the invalid_output
   penalty before re-judging fusion.
