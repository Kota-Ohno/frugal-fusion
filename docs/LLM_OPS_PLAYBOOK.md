<!-- LLM-OPS.md — model-operations rules distilled from live benchmarking (frugal-fusion rounds 1-7, 2026-06/07) -->

# LLM Operations Rules

## Reasoning-model traps

- Reasoning models spend hidden thinking tokens INSIDE max_tokens: a small cap returns an EMPTY answer that is still billed. On empty output, suspect token starvation first; raise the cap 2-6x rather than retrying unchanged.
- Never treat an empty response as an explicit "NONE" / verdict / refusal — warn and count it separately. Treating empty as a valid answer silently corrupts loops (a starved skeptic call reads as "converged"; a starved judge reads as "tie").
- Catalog token price is not effective cost: hidden reasoning multiplies both billed tokens and per-call latency. Judge cheapness only by measured cost per COMPLETED task.
- Provider-side reasoning-budget controls (reasoning.max_tokens and the like) are often silently ignored. Verify with a small probe before trusting them.

## Judged comparisons (LLM-as-judge)

- A pairwise quality claim needs all four: blind sources, order counterbalancing (a side wins only if it wins both orders), an explicit "do not reward length" instruction, and a majority panel from model families disjoint from every system under test.
- Verbosity is the default confound. Always track answer lengths; a large length gap invalidates the comparison until controlled — a "significant win" flipped to a significant LOSS once length bias was removed, in practice.
- n=1-2 pilots detect plumbing errors, not quality differences: the same setup produced opposite conclusions at n=1 and n=48. State no quality conclusion without a bootstrap CI over ~30+ items.

## Subagent model routing

- Use the least capable model that can do the role, and name the model explicitly on every dispatch — an omitted model silently inherits the session's most expensive one.
- Transcription/mechanical work (the complete code is in the brief): cheapest tier. Multi-file integration: mid tier. Review gates: mid tier minimum. Whole-branch/final review and architecture: strongest available.
- Turn count beats token price: cheap models that take 3x the turns cost more overall. Mid tier is the floor for implementers working from prose.

## Loops and retries

- Retry only transient failures (provider overload, truncated response bodies). Never retry a deterministic call unchanged, and never retry schema-invalid output without a corrective repair prompt.
- APIs may report upstream errors as HTTP 200 with an error body — check the body, not just the status, or failures become $0-cost empty answers that corrupt results silently.
- Serial refinement gains die after the first round. Prefer parallel width + selection, then exactly ONE review round (see @SSP.md).
