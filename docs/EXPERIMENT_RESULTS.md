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

## Round 2 — headroom hunt, completion/quality split, repair (2026-06-30)

All three next steps were carried out. Tooling: `scripts/analyze-eval.mjs`
(separates completion rate from answer quality, with a `--headroom` view);
aggregator repair round added (`budget.maxRepairRounds`); two new case pools.

### Completion vs answer quality

Re-reading every run through the completion/quality split is decisive:
**`quality | completed` is 100% for every mode (including fusion) on every
pool.** Fusion's entire apparent deficit is completion failure, not reasoning —
when the cheap ensemble emits valid structure, its answer is correct.

### The headroom hunt failed — three times

To give fusion room to help, the strong baseline must sometimes be wrong. It
never was:

| pool               | cases | what they test                                 | direct (gemini-2.5-flash) pass | headroom cases |
| ------------------ | ----: | ---------------------------------------------- | -----------------------------: | -------------: |
| `cases.experiment` |    36 | arithmetic / classification / JSON             |                           100% |              0 |
| `cases.candidates` |    50 | hard: 4-6 digit mult, modular, dates, Big-O    |                           100% |              0 |
| `cases.longform`   |    40 | code-generated long sums/counts/op-chains/sort |                           100% |              0 |

Across **126 distinct deterministic cases**, `gemini-2.5-flash` was at ceiling.
**Deterministically-checkable AND hard-for-a-strong-cheap-model is, empirically,
the empty set** for these task families. Finding fusion headroom would require
leaving deterministic grading for semantic tasks + an LLM judge — a project
non-goal.

### Fusion carries a structured-output reliability tax

Fusion completion _fell_ as tasks got harder (invalid*output 23% → 42% → 58%),
and the single aggregator repair round did **not** remove it. The cost is the
cheap models failing to emit the elaborate v2 deliberation schema (blinded
claims + ledger), i.e. a tax intrinsic to the fusion \_mechanism*, worst exactly
when tasks are non-trivial. `repeated` (simpler schema, same model) stayed far
more reliable (14-21% invalid).

### Strengthened conclusion

In the regime this project can measure (cheap, deterministic grading), a strong
cheap single model already saturates, so a cheap ensemble cannot win on
success-per-dollar: no quality headroom, 5-16× the cost per pass, and a
mechanism-intrinsic completion tax. `self_review` remains free quality
insurance. The frugal-fusion hypothesis is not supported, and cannot be tested
favorably without abandoning deterministic grading.

Spend across all live runs: ~$0.87.

## Round 3 — open-ended tasks + neutral LLM judge (2026-06-30)

Non-goal revised (`docs/FRUGAL_FUSION_BRIEF.md`): a second research question on
24 open-ended engineering tasks (design critique, migration, code review,
debugging, tradeoffs, API design), judged by a single strong **neutral** model
(`anthropic/claude-sonnet-4.6`, disjoint family from gemini/qwen/minimax), blind
to mode, order-counterbalanced (a side wins a pair only if it wins in both
orders). Harness: `scripts/judge-eval.mts`. Mechanism unchanged.

### Blind pairwise: fusion vs each baseline (strong config, trials=1)

| comparison            | judged | fusion win | baseline win | tie |
| --------------------- | -----: | ---------: | -----------: | --: |
| fusion vs direct      |     16 |    2 (13%) |     10 (63%) |   4 |
| fusion vs self_review |     12 |    3 (25%) |      8 (67%) |   1 |
| fusion vs repeated    |      9 |    2 (22%) |      2 (22%) |   5 |

Completion: direct 100%, self_review 75%, fusion 67%, repeated 63%.

### Findings

1. **Fusion loses on judged quality even where headroom exists.** A strong cheap
   single model wins 63% of decisive pairs vs fusion's 13% (direct 10 / fusion 2
   among decisive; binomial p ≈ 0.02). `self_review` also beats fusion (67%).
2. **The comparison flatters fusion and it still loses.** Only fusion's 67% that
   completed are judged at all; among those survivors it is still beaten.
3. **Cross-model diversity does not beat same-model resampling** (fusion vs
   repeated 2-2-5) — diversity per se is not the missing ingredient.
4. Likely mechanism: aggregate-to-mediocrity — the aggregator regresses two
   candidates toward a safe middle, blunting the single strong model's edge.
   Consistent with `self_review` (sharpen one model) being the steady winner.
5. Caveat: small n (16/12/9 judged pairs, single judge). Direction is clear and
   matches every prior result; tightening the intervals needs more trials.

### Overall conclusion (both research questions)

Across deterministic grading (126 cases, baseline saturated) and open-ended
judged quality (headroom present, fusion still beaten), fixed two-candidate
fusion does not deliver better task success per dollar than a strong cheap
single model. `self_review` is the consistent low-cost winner. The frugal-fusion
hypothesis is not supported by the evidence collected. Total live spend across
all rounds: ~$1.3.
