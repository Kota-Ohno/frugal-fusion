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

## Round 4 — does self_review actually beat direct? (2026-06-30)

`self_review` was the steady winner against fusion, but it had never been judged
head-to-head against plain `direct` (they tie at 100% on saturated deterministic
cases). The judge harness was generalized to arbitrary `[challenger, baseline]`
pairs and re-run on the 24 open-ended tasks at trials=2.

| pair                  | judged | challenger win | baseline win | tie |
| --------------------- | -----: | -------------: | -----------: | --: |
| self_review vs direct |     40 |       17 (43%) |     13 (33%) |  10 |
| fusion vs direct      |     29 |        3 (10%) |     19 (66%) |   7 |
| fusion vs self_review |     27 |         2 (7%) |     22 (81%) |   3 |
| fusion vs repeated    |     20 |       12 (60%) |      5 (25%) |   3 |
| repeated vs direct    |     28 |        3 (11%) |     19 (68%) |   6 |

Completion: direct 100%, self_review 83%, fusion 60%, repeated 58%.
Cost/attempt: direct $0.0019, self_review $0.0028 (~1.5×).

### Findings

1. **`self_review` beats `direct` only weakly and not significantly.** 43% vs
   33% with 25% ties; among decisive pairs 17 vs 13 (binomial p ≈ 0.58). It also
   costs ~1.5× and completes only 83% vs direct's 100%. This is a cost/quality/
   reliability **tradeoff, not a clear win** — "self_review is strongest" is not
   established.
2. **`direct` remains the robust practical baseline**: the only mode that always
   completes, cheapest, and within noise of the best on quality.
3. **Cross-model diversity does beat same-model resampling** (fusion vs repeated
   60% vs 25%, reversing the under-powered Round 3 read) — but both lose badly to
   the single-model modes (fusion/repeated vs direct ≈ 10% win).
4. self_review and fusion both pay a structured-output completion tax (83% / 60%
   vs direct 100%); direct avoids it entirely.

### Recommendation on a "self_review pivot"

The edge is too small and uncertain to justify a pivot on this evidence. To
decide it properly would need a **powered** test: an external benchmark with
headroom, many more judged pairs (~100+), and ideally a judge panel, scored on
quality-per-dollar **and** completion reliability — not quality alone. Absent
that, the frugal default is plain `direct`; `self_review` is an optional,
unproven upgrade.

## Round 5 — single-model adversarial review (the positive result, 2026-06-30)

A different frugal axis: keep ONE cheap model but spend on _depth_ instead of
model diversity. A fresh-eyes iterate-to-convergence loop (draft → 4 adversarial
lens-critics → skeptic false-positive filter → revise, ≤3 rounds) on
`qwen/qwen3-235b-a22b-2507`, judged blind (neutral `claude-sonnet-4.6`,
order-counterbalanced) on 17 hard engineering tasks with review-catchable traps
(lost-update races, DNS-rebinding TOCTOU, idempotency dup, cursor tie-breaks).
Premium baseline: `openai/gpt-5.1` one-shot (three disjoint families).

| pair (review = challenger) | judged | review win | baseline win | tie |
| -------------------------- | -----: | ---------: | -----------: | --: |
| review vs cheap_direct     |     17 |   16 (94%) |       0 (0%) |   1 |
| review vs self_review      |     17 |   15 (88%) |       0 (0%) |   2 |
| review vs premium one-shot |     17 |    7 (41%) |      4 (24%) |   6 |

Mean review rounds 2.88. Cost/task: review $0.00756, premium $0.00972 →
**review = 0.78× premium cost**. (cheap_direct $0.0003, self_review $0.0007.)

### Findings

1. **Adversarial review massively improves a cheap model on hard tasks** — it
   beats its own one-shot 16-0-1 and simple self-review 15-0-2 (decisive, clearly
   significant). Depth helps exactly where the deterministic regime had no room.
2. **It reaches premium parity-or-better at lower cost.** review beats `gpt-5.1`
   one-shot directionally (41% vs 24%) while costing **0.78×** — the first
   per-dollar win in the whole investigation. A cheap model + adversarial review
   can frugally substitute for a premium model on hard tasks.
3. Caveats: review-vs-premium decisive is 7 vs 4 (n=17, single judge,
   p≈0.55) — "matches premium cheaper" is solid; "strictly beats" is directional.
   LLM-judge verbosity bias is a residual confound, though self_review is also a
   two-pass answer and still loses 0-15, so length alone does not explain it.

### Revised overall conclusion

The frugal win is **depth, not breadth**. Fixed multi-model fusion never paid
off; a single cheap model run through adversarial multi-lens review does — it
dominates its own one-shot and simple self-review on hard tasks and matches a
premium model at ~0.78× the cost. Practical guidance: plain `direct` for easy
tasks (no headroom to recover), and **single-model adversarial review for hard
tasks**, where it earns its extra calls and can replace a premium model. Total
live spend across all rounds: ~$3.

## Round 6 — powered confirmation (panel + CIs, 2026-07-01)

Round 5 scaled up for publication: 48 hard tasks, a 3-model neutral judge PANEL
(majority vote: `google/gemini-3-flash-preview`, `x-ai/grok-4.3`,
`deepseek/deepseek-r1` — all disjoint from cheap=qwen and premium=openai),
task-level bootstrap 95% CIs on net win-rate, and an explicit answer-length
(verbosity) check.

| pair (review = challenger)   | win | loss | tie | net win-rate 95% CI |
| ---------------------------- | --: | ---: | --: | ------------------- |
| review vs cheap one-shot     |  42 |    1 |   5 | **[+73%, +96%]**    |
| review vs simple self-review |  37 |    1 |  10 | **[+60%, +88%]**    |
| review vs premium one-shot   |  11 |    5 |  32 | [−4%, +27%]         |

Cost/task: review $0.0071 vs premium $0.0108 → **review = 0.66× premium cost**.
Mean answer length (chars): review 4702, premium 4277, self_review 3055,
cheap_direct 2795.

### Findings (publication-grade)

1. **Adversarial review massively and significantly improves a cheap model on
   hard tasks**: it beats its own one-shot (net +73 to +96%) and a simple
   self-review (+60 to +88%). The CIs are far from zero.
2. **It matches a premium model at 0.66× the cost.** review vs `gpt-5.1` is a
   statistical tie (net win-rate CI [−4%, +27%] crosses zero; 11-5-32), so the
   defensible claim is _quality parity with the premium model at two-thirds the
   cost_ — a frugal substitution — not "beats."
3. **The gain is not a verbosity artifact.** review answers are about as long as
   the premium's and not much longer than self-review's, yet review beats
   self-review 37-1; three independent-family judges agree by majority.

This supersedes Round 5's smaller single-judge read (which had directionally
suggested "beats"): with power and a panel, it is _parity at lower cost_.

### Final headline

On hard engineering tasks, **one cheap model run through an adversarial
multi-lens review-to-convergence loop matches a premium model's quality at ~0.66×
the cost, and decisively beats naive single-shot and simple self-review.** The
frugal win is depth on one model, not breadth across models. Limits: result is
for this cheap/premium/judge generation on LLM-judged engineering tasks; re-run
the harness as models change. Total live spend across all rounds: ~$6.

## Round 7 — sample-select-polish vs the serial review loop (2026-07-03)

A 6-family literature survey (equal-compute studies of sampling, debate,
verification, routing, pipelines, test-time compute) predicted that parallel
draft width + pairwise tournament selection should match the serial review
loop's quality at a fraction of the wall clock. PR #10 added two arms to test
it: `ssp` (6 persona-diverse parallel drafts → knockout tournament → ONE
critique+skeptic+revise round) and `ss` (drafts + tournament only — the
ablation isolating what the critique stage buys). Setup: 48 hard tasks,
cheap=deepseek/deepseek-v4-flash, writer=claude-haiku-4.5, premium=gpt-5.5,
the standard disjoint 3-judge panel, order-counterbalanced, bootstrap CIs;
tournament health instrumented (480 matches, 3% unparseable verdicts after
raising --select-max-tokens to 2500 — 800 gave 40% on this reasoning model).

| pair (challenger first) | win | loss | tie | net win-rate 95% CI |
| ----------------------- | --: | ---: | --: | ------------------- |
| ssp vs review           |   5 |    6 |  37 | [-15%, +13%] (tie)  |
| ssp vs premium one-shot |   3 |   12 |  33 | [-33%, -2%]         |
| ss vs review            |   1 |   26 |  21 | **[-67%, -33%]**    |

Cost/task: ssp $0.0247 vs review $0.0422 → **ssp = 0.58x review cost at
statistically tied quality**. Wall-clock/task under concurrency-4: ssp 310s vs
review 325s (0.95x) — the survey's latency prediction did NOT materialize
here: parallel drafts on a reasoning-heavy cheap model are individually slow,
and ssp's serial depth (draft→3 tournament rounds→critique→skeptic→revise)
is not materially shallower than the 1.85-round review loop's.

### Findings

1. **ssp replaces the review loop at 0.58x cost, same quality** (CI crosses
   zero, 37/48 ties). The frugal lever improved from "depth on one model" to
   "width, then one round of depth."
2. **The critique stage is load-bearing**: the ss ablation loses to review
   [-67%, -33%]. Sampling + selection alone cannot fix what no draft got
   right — on trap-style tasks the adversarial lenses earn their keep. This
   cleanly kills the strongest form of the "it's all just ensembling" claim
   for this benchmark, while confirming its weaker form (one polish round on
   a tournament winner suffices; the second serial round bought nothing).
3. **No latency win in practice** (0.95x): reasoning-model call time, not
   chain depth, dominated. The survey's wall-clock predictions assumed
   fast-per-call models.
4. ssp sits slightly behind GPT-5.5 one-shot ([-33%, -2%]), consistent with
   review's own gap ([-38%, -6%] in the prior round) — the cheap/premium
   capability gap is unchanged; ssp just reaches the same ceiling cheaper.

Run spend: ~$10.5 (judge $4.24). Cumulative project spend: ~$40.
