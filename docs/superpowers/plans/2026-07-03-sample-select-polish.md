# Sample-Select-Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ssp` (sample-select-polish) and `ss` (sample-select) arms to the eval harness, with latency instrumentation and answer dumping, plus an agent-side skill — per `docs/superpowers/specs/2026-07-03-sample-select-polish-design.md`.

**Architecture:** Pure, network-free logic (draft personas, tournament bracket, flag parsing) lives in `src/sampleSelect.ts` (typechecked and vitest-covered like `src/envFile.ts`). The live harness `scripts/review-eval.mts` imports it and adds the two arms, per-arm wall-clock capture, and `--dump-answers`. A new skill documents the same pipeline as agent operation.

**Tech Stack:** TypeScript (strict, NodeNext), vitest, tsx-run .mts script hitting OpenRouter chat completions.

## Global Constraints

- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; new src/tests code must compile under `pnpm typecheck`.
- Default harness behavior must reproduce unchanged: without `--arms`, the existing 4 arms and existing 3 judged pairs run exactly as before.
- No new npm dependencies.
- All files must pass `pnpm run format:check` (prettier), `pnpm run public-release:audit`, `pnpm run public-release:secrets`.
- Never treat an EMPTY model response as an explicit "NONE"/verdict (reasoning-token starvation lesson) — warn on stderr instead.
- Live smoke run budget ≤ ~$0.5; the full 48-task A/B is out of scope (needs user budget sign-off).

---

### Task 1: Pure sample-select logic in src/

**Files:**

- Create: `src/sampleSelect.ts`
- Test: `tests/sampleSelect.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces (used by Task 2):
  - `interface DraftPersona { key: string; stance: string }`
  - `const DRAFT_PERSONAS: DraftPersona[]` (6 entries: correctness, edge-cases, requirements, security, neutral, simplicity)
  - `interface Match { a: number; b: number }`
  - `function pairRound(pool: number[], roundIndex: number): { matches: Match[]; bye: number | null }`
  - `async function runTournament(n: number, judge: (a: number, b: number) => Promise<number>): Promise<{ winner: number; matchCount: number; depth: number }>`
  - `function parseArms(raw: string | undefined, fallback: string[]): string[]`
  - `function parsePairs(raw: string | undefined, fallback: [string, string][]): [string, string][]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sampleSelect.test.ts
import { describe, expect, it } from "vitest";
import {
  DRAFT_PERSONAS,
  pairRound,
  parseArms,
  parsePairs,
  runTournament,
} from "../src/sampleSelect.js";

describe("DRAFT_PERSONAS", () => {
  it("has 6 personas with unique keys", () => {
    expect(DRAFT_PERSONAS).toHaveLength(6);
    expect(new Set(DRAFT_PERSONAS.map((p) => p.key)).size).toBe(6);
  });

  it("includes a neutral persona with an empty stance", () => {
    const neutral = DRAFT_PERSONAS.find((p) => p.key === "neutral");
    expect(neutral?.stance).toBe("");
  });
});

describe("pairRound", () => {
  it("pairs an even pool into adjacent matches with no bye", () => {
    const { matches, bye } = pairRound([0, 1, 2, 3, 4, 5], 0);
    expect(matches).toHaveLength(3);
    expect(bye).toBeNull();
  });

  it("gives the last entry a bye in an odd pool", () => {
    const { matches, bye } = pairRound([7, 8, 9], 0);
    expect(matches).toHaveLength(1);
    expect(bye).toBe(9);
  });

  it("alternates A/B presentation by round and match index", () => {
    const r0 = pairRound([0, 1, 2, 3], 0);
    // match 0: (round 0 + match 0) even -> no swap; match 1: odd -> swap
    expect(r0.matches[0]).toEqual({ a: 0, b: 1 });
    expect(r0.matches[1]).toEqual({ a: 3, b: 2 });
    const r1 = pairRound([0, 1, 2, 3], 1);
    expect(r1.matches[0]).toEqual({ a: 1, b: 0 });
    expect(r1.matches[1]).toEqual({ a: 2, b: 3 });
  });

  it("handles a two-entry pool", () => {
    const { matches, bye } = pairRound([4, 2], 0);
    expect(matches).toEqual([{ a: 4, b: 2 }]);
    expect(bye).toBeNull();
  });
});

describe("runTournament", () => {
  it("returns the sole entrant without judging when n=1", async () => {
    const result = await runTournament(1, async () => {
      throw new Error("judge must not be called");
    });
    expect(result).toEqual({ winner: 0, matchCount: 0, depth: 0 });
  });

  it("always selects the strongest candidate under a transitive judge", async () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const result = await runTournament(n, async (a, b) => Math.max(a, b));
      expect(result.winner).toBe(n - 1);
    }
  });

  it("uses 5 matches at depth 3 for n=6", async () => {
    const result = await runTournament(6, async (a, b) => Math.max(a, b));
    expect(result.matchCount).toBe(5);
    expect(result.depth).toBe(3);
  });

  it("rejects n < 1", async () => {
    await expect(runTournament(0, async (a) => a)).rejects.toThrow();
  });
});

describe("parseArms", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(parseArms(undefined, ["review"])).toEqual(["review"]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseArms(" review, ssp ,,ss ", ["x"])).toEqual([
      "review",
      "ssp",
      "ss",
    ]);
  });
});

describe("parsePairs", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(parsePairs(undefined, [["a", "b"]])).toEqual([["a", "b"]]);
  });

  it("parses colon-separated pairs", () => {
    expect(parsePairs("ssp:review, ss:review", [])).toEqual([
      ["ssp", "review"],
      ["ss", "review"],
    ]);
  });

  it("throws on a malformed pair", () => {
    expect(() => parsePairs("sspreview", [])).toThrow(/pair/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/sampleSelect.test.ts`
Expected: FAIL — cannot resolve `../src/sampleSelect.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/sampleSelect.ts
// Pure, network-free logic for the sample-select-polish eval arms:
// draft personas, single-elimination tournament bracket, and CLI flag
// parsing. Kept in src/ (not scripts/) so the standard typecheck and
// vitest gates cover it — same pattern as envFile.ts.

export interface DraftPersona {
  key: string;
  stance: string;
}

// Diversity moves from critique-time to draft-time: the four review-lens
// framings become drafting stances, plus a neutral and a simplicity-minded
// persona. Stances are appended to the task system prompt.
export const DRAFT_PERSONAS: DraftPersona[] = [
  {
    key: "correctness",
    stance:
      " Approach the problem as an engineer obsessed with logical correctness: get every invariant, condition, and state transition exactly right.",
  },
  {
    key: "edge-cases",
    stance:
      " Approach the problem as an engineer who designs from the failure modes inward: handle boundary conditions, race conditions, and hostile inputs first.",
  },
  {
    key: "requirements",
    stance:
      " Approach the problem as an engineer who treats the stated requirements as a contract: address every single one explicitly and completely.",
  },
  {
    key: "security",
    stance:
      " Approach the problem as a security-minded engineer: assume inputs are hostile, validate everything, and design for least privilege.",
  },
  { key: "neutral", stance: "" },
  {
    key: "simplicity",
    stance:
      " Approach the problem as an engineer who prizes simplicity: find the most robust design with the fewest moving parts, and say no to overengineering.",
  },
];

export interface Match {
  a: number;
  b: number;
}

// Pair a pool into adjacent matches. Odd pool -> last entry gets a bye.
// Presentation order (which side is shown as "A") alternates with
// (roundIndex + matchIndex) so a systematic first-position bias in the
// selector cannot favor one bracket path. Full counterbalancing is
// reserved for the outer measurement panel; internal selection tolerates
// more noise per comparison.
export function pairRound(
  pool: number[],
  roundIndex: number,
): { matches: Match[]; bye: number | null } {
  const matches: Match[] = [];
  const pairCount = Math.floor(pool.length / 2);
  for (let m = 0; m < pairCount; m += 1) {
    const first = pool[2 * m]!;
    const second = pool[2 * m + 1]!;
    if ((roundIndex + m) % 2 === 0) {
      matches.push({ a: first, b: second });
    } else {
      matches.push({ a: second, b: first });
    }
  }
  const bye = pool.length % 2 === 1 ? pool[pool.length - 1]! : null;
  return { matches, bye };
}

// Single-elimination tournament over candidate indices 0..n-1.
// `judge(a, b)` sees a presented as "A" and b as "B" and must return the
// winning index (either a or b). Matches within a round run concurrently;
// rounds are serial. Returns the winning index plus match/depth counts
// for instrumentation.
export async function runTournament(
  n: number,
  judge: (a: number, b: number) => Promise<number>,
): Promise<{ winner: number; matchCount: number; depth: number }> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`runTournament requires an integer n >= 1, got ${n}`);
  }
  let pool = Array.from({ length: n }, (_, i) => i);
  let matchCount = 0;
  let depth = 0;
  let roundIndex = 0;
  while (pool.length > 1) {
    const { matches, bye } = pairRound(pool, roundIndex);
    const winners = await Promise.all(matches.map((m) => judge(m.a, m.b)));
    matchCount += matches.length;
    depth += 1;
    roundIndex += 1;
    pool = bye === null ? winners : [...winners, bye];
  }
  return { winner: pool[0]!, matchCount, depth };
}

export function parseArms(
  raw: string | undefined,
  fallback: string[],
): string[] {
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePairs(
  raw: string | undefined,
  fallback: [string, string][],
): [string, string][] {
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Malformed pair "${entry}" — expected "challenger:baseline"`,
        );
      }
      return [parts[0], parts[1]] as [string, string];
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/sampleSelect.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run repo gates**

Run: `pnpm typecheck && pnpm test && pnpm exec prettier --write src/sampleSelect.ts tests/sampleSelect.test.ts && pnpm run format:check`
Expected: all pass (full suite 291 + new tests).

- [ ] **Step 6: Commit**

```bash
git add src/sampleSelect.ts tests/sampleSelect.test.ts
git commit -m "Add pure sample-select logic: personas, tournament bracket, flag parsing"
```

---

### Task 2: Harness integration — ssp/ss arms, timing, dump

**Files:**

- Modify: `scripts/review-eval.mts`

**Interfaces:**

- Consumes (from Task 1): `DRAFT_PERSONAS`, `runTournament`, `parseArms`, `parsePairs` via `import { ... } from "../src/sampleSelect.js";`
- Produces: new CLI flags `--arms`, `--pairs`, `--drafts`, `--draft-temp`, `--select-max-tokens`, `--dump-answers`; new arm functions `sampleSelect(t)` and `sampleSelectPolish(t)`; per-arm `elapsedMs` in records/summary/output JSON.

No unit tests here (live script); verification is typecheck + usage banner + unchanged-default review, then the Task 4 smoke run.

- [ ] **Step 1: Add the import and new flags**

After the existing `loadEnvFile` import in `scripts/review-eval.mts`:

```ts
import {
  DRAFT_PERSONAS,
  parseArms,
  parsePairs,
  runTournament,
} from "../src/sampleSelect.js";
```

After the existing token-budget flags:

```ts
// Arms are opt-in: without --arms the harness reproduces the original
// four-arm behavior exactly. "ssp" = sample-select-polish, "ss" =
// sample-select (the ablation control without the polish stage).
const DEFAULT_ARMS = [
  "review",
  "cheap_direct",
  "self_review",
  "premium_direct",
];
const ARMS = parseArms(arg("--arms", "") || undefined, DEFAULT_ARMS);
const KNOWN_ARMS = new Set([...DEFAULT_ARMS, "ssp", "ss"]);
for (const a of ARMS) {
  if (!KNOWN_ARMS.has(a)) {
    console.error(`Unknown arm "${a}" — known: ${[...KNOWN_ARMS].join(", ")}`);
    process.exit(1);
  }
}
const N_DRAFTS = Number(arg("--drafts", "6"));
const DRAFT_TEMP = Number(arg("--draft-temp", "0.7"));
// 800 default absorbs hidden reasoning-token overhead on reasoning-heavy
// cheap models while keeping selection calls short and fast.
const SELECT_MAX_TOKENS = Number(arg("--select-max-tokens", "800"));
const DUMP_DIR = arg("--dump-answers", "");
```

Update the usage banner string to append `" [--arms a,b] [--pairs a:b,c:d] [--drafts n] [--draft-temp t] [--select-max-tokens n] [--dump-answers dir]"`.

- [ ] **Step 2: Make the judged-pair list dynamic**

Replace the hardcoded `const PAIRS: [string, string][] = [...]` with:

```ts
// Judged pairs default to: the original three (when their arms run) plus
// the spec's ssp/ss comparisons (when those arms run). Judge cost
// dominates a run, so pairs stay bounded and overridable via --pairs.
const CANDIDATE_PAIRS: [string, string][] = [
  ["review", "cheap_direct"],
  ["review", "self_review"],
  ["review", "premium_direct"],
  ["ssp", "review"],
  ["ssp", "premium_direct"],
  ["ss", "review"],
];
const armSet = new Set(ARMS);
const PAIRS = parsePairs(
  arg("--pairs", "") || undefined,
  CANDIDATE_PAIRS.filter(([c, b]) => armSet.has(c) && armSet.has(b)),
);
for (const [c, b] of PAIRS) {
  if (!armSet.has(c) || !armSet.has(b)) {
    console.error(`Pair ${c}:${b} references an arm not in --arms`);
    process.exit(1);
  }
}
```

`tally`, `outcomes`, `lenSum`, and `modeCost` are keyed by arm/pair name; initialize them from `ARMS`/`PAIRS` instead of literals (e.g. `const lenSum: Record<string, number> = Object.fromEntries(ARMS.map((a) => [a, 0]));` and same pattern for `modeCost`, plus `elapsedSum` identically).

- [ ] **Step 3: Add the ssp/ss arm functions**

Insert after `reviewLoop` (reusing its building blocks — `gen`, `TASK_SYSTEM`, `cList`, `LENSES`, `isNone`, `isEmpty`):

```ts
type Task = { id: string; task: string; constraints?: string[] };

async function sampleDrafts(
  t: Task,
): Promise<{ drafts: string[]; cost: number }> {
  const personas = Array.from(
    { length: N_DRAFTS },
    (_, i) => DRAFT_PERSONAS[i % DRAFT_PERSONAS.length]!,
  );
  const results = await Promise.all(
    personas.map((p) =>
      gen(CHEAP, TASK_SYSTEM + p.stance, t.task, DRAFT_TEMP, CHEAP_MAX_TOKENS),
    ),
  );
  results.forEach((r, i) => {
    if (isEmpty(r.text)) {
      console.error(
        `WARNING: draft[${personas[i]!.key}] for ${CHEAP} returned an EMPTY response — likely reasoning-token truncation. Consider raising --cheap-max-tokens (currently ${CHEAP_MAX_TOKENS}).`,
      );
    }
  });
  return {
    drafts: results.map((r) => r.text),
    cost: results.reduce((s, r) => s + r.cost, 0),
  };
}

const SELECT_SYSTEM =
  "You are an impartial senior software engineer selecting which of two responses better answers an engineering task. " +
  "Weigh, in order: correctness, completeness against the stated requirements, handling of edge cases and failure modes, " +
  "absence of fabrication, and clarity. Do not favor a response merely for being longer or more detailed than necessary. " +
  'Reply with exactly one character: "A" or "B".';

async function selectWinner(
  t: Task,
  drafts: string[],
): Promise<{ winner: string; cost: number; matchCount: number }> {
  // Drop empty drafts up front — a starved draft must not win by judge
  // confusion, and must not silently count as a real candidate.
  const alive = drafts
    .map((text, i) => ({ text, i }))
    .filter((d) => !isEmpty(d.text));
  if (alive.length === 0) return { winner: "", cost: 0, matchCount: 0 };
  let cost = 0;
  const { winner, matchCount } = await runTournament(
    alive.length,
    async (a, b) => {
      const r = await gen(
        CHEAP,
        SELECT_SYSTEM,
        `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nRESPONSE A:\n${alive[a]!.text}\n\nRESPONSE B:\n${alive[b]!.text}\n\nWhich response is better? Reply "A" or "B".`,
        0,
        SELECT_MAX_TOKENS,
      );
      cost += r.cost;
      const verdict = r.text.trim().toUpperCase();
      if (verdict.startsWith("B")) return b;
      if (verdict.startsWith("A")) return a;
      console.error(
        `WARNING: tournament verdict unparseable ("${r.text.slice(0, 40)}") — defaulting to the A side.`,
      );
      return a;
    },
  );
  return { winner: alive[winner]!.text, cost, matchCount };
}

async function sampleSelect(
  t: Task,
): Promise<{ answer: string; rounds: number; cost: number }> {
  const { drafts, cost: draftCost } = await sampleDrafts(t);
  const sel = await selectWinner(t, drafts);
  return { answer: sel.winner, rounds: 0, cost: draftCost + sel.cost };
}

async function sampleSelectPolish(
  t: Task,
): Promise<{ answer: string; rounds: number; cost: number }> {
  const { drafts, cost: draftCost } = await sampleDrafts(t);
  const sel = await selectWinner(t, drafts);
  let cost = draftCost + sel.cost;
  let answer = sel.winner;
  if (isEmpty(answer)) return { answer, rounds: 0, cost };
  // Exactly ONE polish round: 4 lenses -> skeptic -> revise. Mirrors one
  // iteration of reviewLoop's body with the same prompts.
  const critiques = await Promise.all(
    LENSES.map((L) =>
      gen(
        CHEAP,
        `You are an adversarial reviewer focusing ONLY on ${L.focus}. Find concrete, specific flaws in the response under review. If you genuinely find none, reply exactly NONE.`,
        `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nRESPONSE UNDER REVIEW:\n${answer}\n\nList specific ${L.name} flaws as concise bullets, or NONE.`,
        0.4,
        CRITIQUE_MAX_TOKENS,
      ),
    ),
  );
  for (const c of critiques) cost += c.cost;
  const combined = critiques
    .map((r, i) =>
      isNone(r.text) || isEmpty(r.text)
        ? ""
        : `[${LENSES[i]!.name}]\n${r.text}`,
    )
    .filter(Boolean)
    .join("\n\n");
  if (!combined) return { answer, rounds: 0, cost };
  const skeptic = await gen(
    CHEAP,
    "You are a skeptical lead reviewer. Given a draft and alleged issues, KEEP only issues that are real, specific, and material to correctness or requirements; discard vague, stylistic, or false-positive items. If none survive, reply exactly NONE.",
    `TASK:\n${t.task}\n\nDRAFT:\n${answer}\n\nALLEGED ISSUES:\n${combined}\n\nReturn only the surviving real issues as concise bullets, or NONE.`,
    0,
    CRITIQUE_MAX_TOKENS,
  );
  cost += skeptic.cost;
  if (isNone(skeptic.text) || isEmpty(skeptic.text))
    return { answer, rounds: 0, cost };
  const revised = await gen(
    WRITER,
    TASK_SYSTEM +
      " You are revising a draft to fix specific reviewer-identified issues. Keep what is correct; fix the listed issues; write cleanly and do not narrate your reasoning process — output only the final polished answer.",
    `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nCURRENT DRAFT:\n${answer}\n\nISSUES TO FIX:\n${skeptic.text}\n\nOutput the improved final answer.`,
    0.2,
    WRITER_MAX_TOKENS,
  );
  cost += revised.cost;
  if (!isEmpty(revised.text)) answer = revised.text;
  return { answer, rounds: 1, cost };
}
```

- [ ] **Step 4: Rework runTask to be arm-driven with timing and dump**

Replace the fixed 4-way `Promise.all` in `runTask` with:

```ts
const ARM_FNS: Record<
  string,
  (t: Task) => Promise<{ answer: string; rounds: number; cost: number }>
> = {
  review: async (t) => reviewLoop(t),
  cheap_direct: async (t) => {
    const r = await cheapDirect(t);
    return { answer: r.text, rounds: 0, cost: r.cost };
  },
  self_review: async (t) => {
    const r = await selfReview(t);
    return { answer: r.text, rounds: 0, cost: r.cost };
  },
  premium_direct: async (t) => {
    const r = await premiumDirect(t);
    return { answer: r.text, rounds: 0, cost: r.cost };
  },
  ssp: sampleSelectPolish,
  ss: sampleSelect,
};

async function runTask(t: Task) {
  const results = await Promise.all(
    ARMS.map(async (name) => {
      const started = Date.now();
      const r = await ARM_FNS[name]!(t);
      return { name, ...r, elapsedMs: Date.now() - started };
    }),
  );
  const ans: Record<string, string> = {};
  const elapsed: Record<string, number> = {};
  let reviewRounds = 0;
  for (const r of results) {
    ans[r.name] = r.answer;
    elapsed[r.name] = r.elapsedMs;
    modeCost[r.name] = (modeCost[r.name] ?? 0) + r.cost;
    lenSum[r.name] = (lenSum[r.name] ?? 0) + r.answer.length;
    elapsedSum[r.name] = (elapsedSum[r.name] ?? 0) + r.elapsedMs;
    if (r.name === "review") reviewRounds = r.rounds;
  }
  roundsSum += reviewRounds;
  // ... existing judged-pairs block unchanged (it already iterates PAIRS) ...
  // record gains: rec.elapsedMs = elapsed;
  if (DUMP_DIR) {
    writeFileSync(
      join(DUMP_DIR, `${t.id}.json`),
      JSON.stringify(
        { id: t.id, task: t.task, answers: ans, elapsedMs: elapsed },
        null,
        2,
      ),
    );
  }
}
```

Add `import { join } from "node:path";` and `import { mkdirSync } from "node:fs";` (extend the existing `node:fs` import), and before the worker pool: `if (DUMP_DIR) mkdirSync(DUMP_DIR, { recursive: true });`

Note: `roundsSum`/"mean review rounds" only makes sense when the `review` arm runs; guard the summary line with `armSet.has("review")`.

- [ ] **Step 5: Extend summary and output JSON**

In the summary printout add a mean-elapsed block mirroring the mean-cost block:

```ts
console.log("\nmean wall-clock per task (seconds):");
for (const m of ARMS) {
  console.log(
    `  ${m.padEnd(16)} ${(elapsedSum[m]! / 1000 / Math.max(1, tasks.length)).toFixed(1)}s`,
  );
}
```

In the `writeFileSync` output object add: `arms: ARMS, elapsedSum,` and keep everything else.

- [ ] **Step 6: Typecheck and default-behavior check**

Run: `pnpm exec tsc --noEmit --target es2022 --module esnext --moduleResolution bundler scripts/review-eval.mts && pnpm typecheck && pnpm test`
Expected: clean.

Run: `pnpm tsx scripts/review-eval.mts` (no args)
Expected: usage banner including the new flags, exit code 1, no network calls.

- [ ] **Step 7: Commit**

```bash
git add scripts/review-eval.mts
git commit -m "Add ssp/ss arms, per-arm wall-clock timing, and --dump-answers to review-eval"
```

---

### Task 3: Agent-side skill + docs

**Files:**

- Create: `skills/sample-select-polish/SKILL.md`
- Modify: `skills/README.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the skill**

```markdown
---
name: sample-select-polish
description: Produce a hard artifact (design doc, plan, tricky implementation, API spec) by generating N candidate drafts IN PARALLEL from fresh-context subagents with different engineering stances, selecting the best via a pairwise knockout tournament judged by fresh-context subagents, then running ONE fresh-eyes review round on the winner and fixing what survives. Use this when the task is to CREATE something hard and you want premium-grade output fast — the generation-side complement to fresh-eyes-review (which reviews an existing artifact). Trigger when the user asks for a hard design/implementation "done well", wants alternatives explored, or when a single-pass draft on a hard problem would likely embed your own blind spots.
---

# Sample-Select-Polish

## Why width beats depth

Equal-compute studies of LLM refinement converge on one result: most of the
gain from long serial critique/revise chains is the ensemble effect in
disguise. Spending the same budget on parallel diverse drafts plus a reliable
pairwise selector matches or beats serial refinement at a fraction of the
wall-clock time. Serial depth still pays — but only for ONE round, on the
best candidate, not as the whole strategy.

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

## Cost and when to use

~N+log2(N) subagent calls plus one review round: heavier than a single
draft, far lighter and much faster than iterated review loops. Worth it for
high-stakes artifacts; skip it for routine edits (a single draft + one
review round is enough there).
```

- [ ] **Step 2: Add to skills/README.md**

Append a bullet under the existing fresh-eyes-review entry:

```markdown
- **[sample-select-polish](sample-select-polish/SKILL.md)** — the
  generation-side complement: N parallel stance-diverse drafts → pairwise
  knockout selection → one fresh-eyes round on the winner. Backed by the
  same benchmark harness (`ssp` arm in `scripts/review-eval.mts`).
```

- [ ] **Step 3: Format and commit**

Run: `pnpm exec prettier --write skills/ && pnpm run format:check`
Expected: pass.

```bash
git add skills/
git commit -m "Add sample-select-polish agent skill"
```

---

### Task 4: Gates + live smoke run

**Files:**

- None created; produces `/tmp`-side smoke artifacts and a verified pipeline.

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Full gate suite**

Run: `pnpm typecheck && pnpm test && pnpm run format:check && pnpm run public-release:audit && pnpm run public-release:secrets && pnpm build`
Expected: all pass.

- [ ] **Step 2: Live smoke (2 tasks, ~$0.3-0.5)**

```bash
head -2 examples/tasks.hard.all.jsonl > /tmp/smoke-2.jsonl
pnpm tsx scripts/review-eval.mts /tmp/smoke-2.jsonl \
  --cheap deepseek/deepseek-v4-flash --writer anthropic/claude-haiku-4.5 \
  --arms review,ssp,ss --pairs ssp:review,ss:review \
  --rounds 2 --cheap-max-tokens 10000 --critique-max-tokens 6000 --writer-max-tokens 6000 \
  --concurrency 2 --dump-answers /tmp/smoke-dump \
  --out /tmp/smoke-ssp.json
```

Expected:

- exits 0; summary shows 3 arms with mean cost AND mean wall-clock seconds;
- `ssp` wall-clock < `review` wall-clock;
- `/tmp/smoke-dump/*.json` exist with non-empty `answers.ssp`, `answers.ss`;
- judged pairs `ssp vs review` and `ss vs review` each have 2 judged.

- [ ] **Step 3: Report**

Summarize measured wall-clock/cost per arm vs the spec's success criteria (ssp ≤ 0.5x review wall clock target) and state that the 48-task A/B awaits budget sign-off.
