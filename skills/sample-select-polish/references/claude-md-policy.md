<!-- SSP.md — ssp-first operating policy (imported by CLAUDE.md) -->

# SSP-First Policy

Route every task through the tiers below before starting work. Default to the matching skill; do not wait to be asked.

## Routing

**Tier 1 — invoke `sample-select-polish`** when CREATING a new hard artifact:

- Design docs, architecture proposals, implementation plans
- Tricky or high-stakes implementations (concurrency, migrations, security-sensitive code, irreversible changes)
- API specs and public interfaces
- Publication-grade writing (blog posts, READMEs for release, reports)

**Tier 2 — invoke `fresh-eyes-review`** when REVIEWING or auditing an artifact that already exists:

- Code, diffs, PRs, designs, specs, configs, or infra about to ship
- Any request phrased as "review", "audit", "check this", "what did I miss"
- Exception: an artifact that already had its review round this session (e.g. a `sample-select-polish` winner) does not get another one

**Tier 3 — use NEITHER** for routine edits, small fixes, Q&A, and exploratory chat.
Both skills fan out multiple subagents — spend that cost only where the artifact is hard or the failure is expensive.

## Escalation

When stakes are ambiguous, write ONE normal draft first. Escalate to `sample-select-polish` only if that draft fails review or the user signals high stakes. Never pre-emptively sample for a task you could plausibly one-shot.

## Polish discipline

- After selection, run exactly ONE fresh-eyes review round, fix survivors, ship. Never loop polish.
- If critical issues survive the fix, do NOT run another review round: re-sample once, folding the findings into the task statement. If the second sample still fails, ship the best candidate and state what remains unresolved — do not start a third cycle.
- Grounding: on a 48-task benchmark, the no-review ablation lost 1W-26L-21T to a two-round review loop, while select + one review tied that loop at 0.58x cost.

## Composition

Inside larger workflows (plan mode, subagent-driven development), apply `sample-select-polish` to the single riskiest artifact of the plan only. Every other task gets a normal draft, gated by the escalation rule above.

## Anti-patterns

- Sampling for trivial output (rename, config tweak, one-liner answer) — Tier 3 exists for a reason.
- Running `fresh-eyes-review` on a `sample-select-polish` winner that already had its review round.
- Chaining review rounds until "clean" — convergence-by-loop is what re-sampling replaces.
- Applying `sample-select-polish` to every task in a plan instead of the riskiest one.
