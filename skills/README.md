# skills/

Claude Code skills referenced by this repo's experiments.

- **[fresh-eyes-review](fresh-eyes-review/SKILL.md)** — the adversarial, multi-perspective review loop
  (draft → per-role fresh-context reviewers → independent skeptic → revise, to convergence) that this
  repo's benchmark evaluates. See [`docs/PUBLICATION.md`](../docs/PUBLICATION.md) and
  [`docs/EXPERIMENT_RESULTS.md`](../docs/EXPERIMENT_RESULTS.md) for the measured results: on a cheap
  model, this technique reaches premium-model quality parity at ~0.66× cost on hard engineering tasks.

  This is a general-purpose Claude Code skill, not specific to LLM evaluation — drop it into
  `~/.claude/skills/` or a project's `.claude/skills/` to use it for reviewing code, diffs, design docs,
  or any other artifact. `scripts/review-eval.mts` in this repo implements the same draft → critique →
  skeptic → revise loop directly against the OpenRouter API (rather than via the Skill/Workflow tools)
  so it could be benchmarked deterministically outside of an interactive Claude Code session.

- **[sample-select-polish](sample-select-polish/SKILL.md)** — the
  generation-side complement: N parallel stance-diverse drafts → pairwise
  knockout selection → one fresh-eyes round on the winner. Backed by the
  same benchmark harness (`ssp` arm in `scripts/review-eval.mts`).
