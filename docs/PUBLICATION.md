# Publication draft — "Depth beats breadth: cheap model + adversarial review"

Honest, ready-to-share summary of the Frugal Fusion experiments. Claims are
scoped to what the evidence supports (see `docs/EXPERIMENT_RESULTS.md` for the
full method and every round). Nothing here is gated public cost-performance
"claim evidence" in the formal sense of `docs/PUBLIC_RELEASE_CHECKLIST.md` — it
is an informal write-up of an internal experiment, stated with its limits.

## One-paragraph summary

I tested whether a selectively-invoked ensemble of cheap LLMs ("frugal fusion")
beats a strong cheap single model per dollar. It does not — across 126
deterministically graded cases and open-ended LLM-judged tasks, fixed
two-candidate fusion never won. But a different, cheaper lever does: keep ONE
cheap model and spend on _depth_. A fresh-eyes adversarial review loop (draft →
multi-lens critics → skeptic filter → revise, to convergence) on a cheap model
(`qwen3-235b`) **matches a premium model (`gpt-5.1`) on hard engineering tasks at
0.66× the cost**, and decisively beats naive single-shot and simple self-review.
Measured with a 3-family blind judge panel, order-counterbalanced, bootstrap CIs.

## Numbers (48 hard tasks, panel majority, net win-rate 95% CI)

- review vs cheap one-shot: +73% to +96% (42 win–1 loss–5 tie) — significant
- review vs simple self-review: +60% to +88% (37 win–1 loss–10 tie) — significant
- review vs premium one-shot: −4% to +27% (11 win–5 loss–32 tie) — tie (parity)
- cost: review 0.66× the premium one-shot; answer lengths comparable (not a
  verbosity artifact).

## What is and isn't claimed

- CLAIMED: depth (adversarial review on one cheap model) reaches premium-quality
  parity at ~2/3 cost on hard tasks, and massively beats single-shot / simple
  self-review.
- NOT claimed: that review _beats_ premium (it's a statistical tie); that fusion
  helps (it didn't); that this holds on easy tasks (no headroom) or across all
  model generations (re-run as models change).

## X thread (ready to post — pending your approval)

1/ I spent a few dollars testing a frugal-LLM idea to destruction. Question: can
a cheap _ensemble_ of models beat one strong cheap model per dollar? Answer: no.
But the experiment turned up something that does work — and it's cheaper. 🧵

2/ Setup: 4 modes — direct (1 cheap call), self-review (draft+revise), repeated
(same model ×2 + aggregator), fusion (2 different cheap models + aggregator).
Judged on deterministic tasks AND open-ended ones by a neutral LLM, blind +
order-counterbalanced.

3/ Fusion lost everywhere. On deterministic tasks a strong cheap model already
hits 100% (no headroom). On open-ended tasks, plain "direct" beat fusion 66% to
10% in blind pairwise. Mixing models mostly buys cost + a reliability tax, not
quality.

4/ So I flipped the axis: keep ONE cheap model, spend on DEPTH instead of
breadth. A fresh-eyes loop: draft → 4 adversarial reviewers (correctness,
edge-cases, requirements, security) → a skeptic that kills false positives →
revise → repeat to convergence.

5/ On 48 hard engineering tasks (race conditions, TOCTOU, idempotency, cache
invalidation…), judged by a 3-model panel (Gemini + Grok + DeepSeek, majority
vote, blind, counterbalanced):

6/ Results (net win-rate, 95% bootstrap CI):
• review vs the same model's one-shot: +73…+96%
• review vs simple self-review: +60…+88%
• review vs a PREMIUM model (GPT-5.1) one-shot: −4…+27% (a tie)

7/ The punchline: a cheap model + adversarial review reaches **premium-quality
parity at 0.66× the cost** on hard tasks — and crushes naive single-shot output.
The frugal win is depth on one model, not an ensemble of models.

8/ Honest limits: "parity," not "beats" (the premium CI crosses zero). It's for
this model generation, on LLM-judged tasks; the gain isn't a verbosity artifact
(lengths comparable, 3 independent judges agree). Re-run as models get cheaper.

9/ Takeaway for building cheap agents: don't pay for model diversity; pay for
structured adversarial self-criticism on hard steps, and skip it on easy ones.
Method + every round documented. /end
