---
name: sample-select-polish
description: Produce a hard artifact (design doc, plan, tricky implementation, API spec) by generating N candidate drafts IN PARALLEL from fresh-context subagents with different engineering stances, selecting the best via a pairwise knockout tournament judged by fresh-context subagents, then running ONE fresh-eyes review round on the winner and fixing what survives. Use this when the task is to CREATE something hard and you want premium-grade output fast — the generation-side complement to fresh-eyes-review (which reviews an existing artifact). Trigger when the user asks for a hard design/implementation "done well", wants alternatives explored, or when a single-pass draft on a hard problem would likely embed your own blind spots.
---

# Sample-Select-Polish

## Why width beats depth

Equal-compute studies of LLM refinement converge on one result: most of the
gain from long serial critique/revise chains is the ensemble effect in
disguise. Spending the same budget on parallel diverse drafts plus a reliable
pairwise selector matches serial refinement's quality. Serial depth still
pays — but only for ONE round, on the best candidate, not as the whole
strategy. This repo's own 48-task benchmark (Round 7 in
`docs/EXPERIMENT_RESULTS.md`) confirmed the shape: the `ssp` arm tied the
2-round review loop's quality at 0.58x cost, and the no-polish ablation lost
badly — the single review round is load-bearing, not optional. One honest
caveat from the same run: the wall-clock win depends on per-call speed
(reasoning-heavy models draft slowly; there it was cost, not time, that
improved).

## The pipeline

1. **Sample (parallel).** Spawn N fresh-context subagents (N=4-6), each
   drafting the artifact with a different stance: correctness-obsessed,
   failure-modes-first, requirements-as-contract, security-minded, neutral,
   simplicity-minded. One stance per agent, no shared context, same task
   statement. Cap all drafts at a similar length so the selector compares
   substance, not volume.
2. **Select (tournament).** Run a single-elimination bracket: each match is a
   fresh-context subagent given the task + two drafts, forced to pick A or B
   ("do not favor length"). Alternate which draft is shown first match to
   match. N=6 needs 5 matches in 3 short serial rounds.
3. **Polish (once).** Run ONE round of fresh-eyes-review on the winner (the
   role fan-out + skeptic from that skill), then fix the surviving findings
   yourself. Do not loop — refinement gains die after the first round;
   if the review still surfaces critical issues after the fix, that is a
   signal to re-sample with the findings folded into the task statement,
   not to keep polishing.

## Division of labor

- Fresh subagents draft (stances make their blind spots differ).
- Fresh subagents judge matches (no authorship attachment).
- YOU fix the winner after review — you hold the full context.

## How to run it

### 1. Sample + Select via the bundled workflow

```
Workflow({
  scriptPath: "<this skill's directory>/scripts/ssp_workflow.js",
  args: {
    task: "<the full task statement — fresh agents see ONLY this, so spell
           out every requirement and acceptance criterion>",
    guidance: "<optional style/length/format constraints for every draft>",
    n: 6  // optional, 2..6 (default 6, one per persona)
  }
})
```

Returns `{ winner, persona, candidates, matches, empty_drafts }` — `winner`
is the selected draft text. The persona bank and tournament bracket are
built into the script.

### 2. Polish (you drive this stage)

Run ONE round of fresh-eyes-review on `winner` (that skill's workflow with
the artifact written to a file, or its Agent-tool fallback), then apply the
surviving findings yourself. Stop after one round. If critical issues
remain after your fix, re-run stage 1 with the findings folded into
`args.task` instead of polishing again.

### If the Workflow tool is unavailable

Same shape with the Agent tool: spawn N parallel draft subagents in one
message (one stance persona each, task statement only, "return only the
artifact"); then run the bracket yourself — each match is one subagent
given the task + two drafts with a forced A/B choice and a "do not favor
length" instruction, alternating which draft is shown as A; matches within
a round go in one parallel message. Then polish as above.

## Cost and when to use

~N+log2(N) subagent calls plus one review round: heavier than a single
draft, materially cheaper than iterated review loops at the same quality
(0.58x in the benchmark), and faster when per-call latency is low (the
drafts and tournament parallelize; slow reasoning-heavy models can eat the
time win). Worth it for high-stakes artifacts; skip it for routine edits (a
single draft + one review round is enough there).

## Making it the default (CLAUDE.md policy)

To make an agent reach for this skill (and fresh-eyes-review) by default,
import `references/claude-md-policy.md` from your global or project
CLAUDE.md — copy it next to CLAUDE.md as `SSP.md` and add a line `@SSP.md`.
It defines the three routing tiers, an escalation rule for ambiguous
stakes, the one-review-round discipline (with a bounded re-sample rule),
and the anti-patterns.
