#!/usr/bin/env -S pnpm tsx
// Single-model adversarial-review experiment (dev tool; not part of the frozen
// public-report layer). Research question: on HARD engineering tasks, does ONE
// cheap model run through a fresh-eyes iterate-to-convergence review loop
// (draft -> multi-lens adversarial critics -> skeptic false-positive filter ->
// revise, repeated until a round surfaces nothing real) win BLIND PAIRWISE vs
//   (a) the same cheap model, one shot      -> does depth help at all?
//   (b) the same cheap model + one self-review -> beats the simple review?
//   (c) a PREMIUM model, one shot           -> can cheap+depth replace premium?
//
// Everything is a raw chat-completions call (no orchestrator schema coupling).
// Judging uses a PANEL of strong NEUTRAL models (families disjoint from both the
// cheap and premium system models), each blind to source and order-
// counterbalanced (a side wins an order only if it wins both); the panel takes a
// majority vote. Reports task-level bootstrap CIs and mean answer length (a
// verbosity-bias check).
//
// Usage:
//   pnpm tsx scripts/review-eval.mts examples/tasks.hard.all.jsonl \
//     --cheap qwen/qwen3-235b-a22b-2507 --premium openai/gpt-5.1 \
//     --judges google/gemini-3-flash-preview,x-ai/grok-4.3,deepseek/deepseek-r1 \
//     --rounds 3 --out .frugal-fusion/review-powered.json

import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/envFile.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const tasksPath = process.argv[2];
if (!tasksPath || tasksPath.startsWith("--")) {
  console.error(
    "usage: review-eval.mts <tasks.jsonl> [--cheap id] [--premium id] [--judge id] [--rounds n] [--out p]",
  );
  process.exit(1);
}
const CHEAP = arg("--cheap", "google/gemini-2.5-flash");
const PREMIUM = arg("--premium", "google/gemini-3-flash-preview");
// Judge PANEL: three strong, NEUTRAL models from families disjoint from both
// system models (cheap=qwen, premium=openai). Majority vote kills single-judge
// and verbosity bias. Override with --judges a,b,c.
const JUDGES = arg(
  "--judges",
  "google/gemini-3-flash-preview,x-ai/grok-4.3,deepseek/deepseek-r1",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_ROUNDS = Number(arg("--rounds", "3"));
const outPath = arg("--out", ".frugal-fusion/review-result.json");

loadEnvFile();
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const tasks = readFileSync(tasksPath, "utf8")
  .trim()
  .split("\n")
  .map(
    (l) =>
      JSON.parse(l) as { id: string; task: string; constraints?: string[] },
  );

// Per-mode cost buckets so the per-dollar comparison (review loop vs premium
// one-shot) is exact.
const modeCost: Record<string, number> = {
  review: 0,
  cheap_direct: 0,
  self_review: 0,
  premium_direct: 0,
};
let judgeCost = 0;

async function gen(
  model: string,
  system: string,
  user: string,
  temperature: number,
  maxTokens: number,
): Promise<{ text: string; cost: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
      usage: { include: true },
    }),
  });
  const body: any = await res.json();
  const text: string = body.choices?.[0]?.message?.content ?? "";
  return { text, cost: body.usage?.cost ?? 0 };
}

const TASK_SYSTEM =
  "You are a senior software engineer. Answer the engineering task directly, correctly, and concisely (a few hundred words). Address every stated requirement.";

const cList = (cs?: string[]) => (cs ?? []).map((c) => `- ${c}`).join("\n");

async function cheapDirect(t: {
  task: string;
}): Promise<{ text: string; cost: number }> {
  return gen(CHEAP, TASK_SYSTEM, t.task, 0.3, 1500);
}

async function premiumDirect(t: {
  task: string;
}): Promise<{ text: string; cost: number }> {
  return gen(PREMIUM, TASK_SYSTEM, t.task, 0.3, 1500);
}

async function selfReview(t: {
  task: string;
  constraints?: string[];
}): Promise<{ text: string; cost: number }> {
  const draft = await gen(CHEAP, TASK_SYSTEM, t.task, 0.3, 1500);
  const rev = await gen(
    CHEAP,
    TASK_SYSTEM +
      " Review your own answer for errors, omissions, and edge cases, then output an improved final answer.",
    `TASK:\n${t.task}\n\nYOUR DRAFT:\n${draft.text}\n\nOutput the improved final answer only.`,
    0.2,
    1500,
  );
  return { text: rev.text, cost: draft.cost + rev.cost };
}

const LENSES = [
  { name: "correctness", focus: "correctness bugs and logical errors" },
  {
    name: "edge-cases",
    focus:
      "edge cases, boundary conditions, race conditions, and failure modes",
  },
  {
    name: "requirements",
    focus:
      "requirements coverage — anything in the task or constraints not fully addressed",
  },
  {
    name: "security",
    focus:
      "security vulnerabilities, unsafe assumptions, and missing validation",
  },
];

const isNone = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "") === "NONE" || s.trim() === "";

async function reviewLoop(t: {
  task: string;
  constraints?: string[];
}): Promise<{ answer: string; rounds: number; cost: number }> {
  const draft0 = await gen(CHEAP, TASK_SYSTEM, t.task, 0.3, 1500);
  let draft = draft0.text;
  let cost = draft0.cost;
  let rounds = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const critiques = await Promise.all(
      LENSES.map(async (L) => {
        const r = await gen(
          CHEAP,
          `You are an adversarial reviewer focusing ONLY on ${L.focus}. Find concrete, specific flaws in the response under review. If you genuinely find none, reply exactly NONE.`,
          `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nRESPONSE UNDER REVIEW:\n${draft}\n\nList specific ${L.name} flaws as concise bullets, or NONE.`,
          0.4,
          600,
        );
        return r;
      }),
    );
    for (const c of critiques) cost += c.cost;
    const combined = critiques
      .map((r, i) => (isNone(r.text) ? "" : `[${LENSES[i]!.name}]\n${r.text}`))
      .filter(Boolean)
      .join("\n\n");
    if (!combined) break; // all lenses clean -> converged
    const skeptic = await gen(
      CHEAP,
      "You are a skeptical lead reviewer. Given a draft and alleged issues, KEEP only issues that are real, specific, and material to correctness or requirements; discard vague, stylistic, or false-positive items. If none survive, reply exactly NONE.",
      `TASK:\n${t.task}\n\nDRAFT:\n${draft}\n\nALLEGED ISSUES:\n${combined}\n\nReturn only the surviving real issues as concise bullets, or NONE.`,
      0,
      600,
    );
    cost += skeptic.cost;
    if (isNone(skeptic.text)) break; // every issue was a false positive -> converged
    rounds = round + 1;
    const revised = await gen(
      CHEAP,
      TASK_SYSTEM +
        " You are revising a draft to fix specific reviewer-identified issues. Keep what is correct; fix the listed issues. Output only the improved final answer.",
      `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nCURRENT DRAFT:\n${draft}\n\nISSUES TO FIX:\n${skeptic.text}\n\nOutput the improved final answer.`,
      0.2,
      1500,
    );
    cost += revised.cost;
    draft = revised.text;
  }
  return { answer: draft, rounds, cost };
}

const JUDGE_SYSTEM =
  "You are an impartial senior software engineer judging which of two responses better answers an engineering task. " +
  "Weigh, in order: correctness, completeness against the stated requirements, handling of edge cases and failure modes, " +
  "absence of fabrication, and clarity. Be discriminating; do not default to a tie when one is clearly better.";

async function judgeOne(
  model: string,
  task: string,
  constraints: string[],
  a: string,
  b: string,
): Promise<"A" | "B" | "TIE"> {
  const r = await gen(
    model,
    JUDGE_SYSTEM,
    `TASK:\n${task}\n\nREQUIREMENTS:\n${cList(constraints)}\n\n=== RESPONSE A ===\n${a}\n\n=== RESPONSE B ===\n${b}\n\nWhich is better? Reply with ONLY one token on the first line: A, B, or TIE.`,
    0,
    50,
  );
  judgeCost += r.cost;
  const m = r.text
    .trim()
    .toUpperCase()
    .match(/\b(A|B|TIE)\b/);
  return (m?.[1] as "A" | "B" | "TIE") ?? "TIE";
}

// One judge, order-counterbalanced: a side wins only if it wins in both orders.
async function judgeCounterbalanced(
  model: string,
  task: string,
  cs: string[],
  challenger: string,
  baseline: string,
): Promise<"challenger" | "baseline" | "tie"> {
  const [v1, v2] = await Promise.all([
    judgeOne(model, task, cs, challenger, baseline), // A = challenger
    judgeOne(model, task, cs, baseline, challenger), // A = baseline
  ]);
  if (v1 === "A" && v2 === "B") return "challenger";
  if (v1 === "B" && v2 === "A") return "baseline";
  return "tie";
}

// Panel majority across judges (no strict majority -> tie).
async function panelPair(
  task: string,
  cs: string[],
  challenger: string,
  baseline: string,
): Promise<"challenger" | "baseline" | "tie"> {
  const votes = await Promise.all(
    JUDGES.map((j) => judgeCounterbalanced(j, task, cs, challenger, baseline)),
  );
  const count = (o: string) => votes.filter((v) => v === o).length;
  if (count("challenger") > votes.length / 2) return "challenger";
  if (count("baseline") > votes.length / 2) return "baseline";
  return "tie";
}

const PAIRS: [string, string][] = [
  ["review", "cheap_direct"],
  ["review", "self_review"],
  ["review", "premium_direct"],
];
const tally: Record<
  string,
  { win: number; loss: number; tie: number; judged: number }
> = {};
for (const [c, b] of PAIRS)
  tally[`${c} vs ${b}`] = { win: 0, loss: 0, tie: 0, judged: 0 };
let roundsSum = 0;
const records: any[] = [];
// Per-pair per-task outcomes (+1 challenger win, -1 baseline win, 0 tie) for
// task-level bootstrap confidence intervals.
const outcomes: Record<string, number[]> = {};
for (const [c, b] of PAIRS) outcomes[`${c} vs ${b}`] = [];
// Mean answer length per mode (chars) — a verbosity-bias check.
const lenSum: Record<string, number> = {
  review: 0,
  cheap_direct: 0,
  self_review: 0,
  premium_direct: 0,
};

for (const t of tasks) {
  const [rev, cd, sr, pd] = await Promise.all([
    reviewLoop(t),
    cheapDirect(t),
    selfReview(t),
    premiumDirect(t),
  ]);
  roundsSum += rev.rounds;
  modeCost.review += rev.cost;
  modeCost.cheap_direct += cd.cost;
  modeCost.self_review += sr.cost;
  modeCost.premium_direct += pd.cost;
  const ans: Record<string, string> = {
    review: rev.answer,
    cheap_direct: cd.text,
    self_review: sr.text,
    premium_direct: pd.text,
  };
  for (const m of Object.keys(lenSum)) lenSum[m]! += (ans[m] ?? "").length;
  const rec: any = { id: t.id, rounds: rev.rounds, pairs: {} };
  for (const [c, b] of PAIRS) {
    if (!ans[c] || !ans[b]) continue;
    const o = await panelPair(t.task, t.constraints ?? [], ans[c]!, ans[b]!);
    const key = `${c} vs ${b}`;
    tally[key].judged++;
    if (o === "challenger") tally[key].win++;
    else if (o === "baseline") tally[key].loss++;
    else tally[key].tie++;
    outcomes[key]!.push(o === "challenger" ? 1 : o === "baseline" ? -1 : 0);
    rec.pairs[key] = o;
  }
  records.push(rec);
  console.error(`${t.id} rounds=${rev.rounds} ${JSON.stringify(rec.pairs)}`);
}

// Deterministic bootstrap (seeded LCG; Math.random unavailable) over tasks:
// returns a 95% CI for net win-rate = (wins - losses) / judged.
function bootstrapNetCI(vals: number[]): [number, number] {
  if (vals.length === 0) return [NaN, NaN];
  let seed = 987654321;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const means: number[] = [];
  for (let s = 0; s < 2000; s++) {
    let sum = 0;
    for (let i = 0; i < vals.length; i++)
      sum += vals[Math.floor(rnd() * vals.length)]!;
    means.push(sum / vals.length);
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.floor(0.025 * means.length)]!,
    means[Math.floor(0.975 * means.length)]!,
  ];
}

const pct = (a: number, b: number) =>
  b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`;
console.log(
  `\n==== adversarial review (cheap=${CHEAP}, premium=${PREMIUM}, judges=[${JUDGES.join(", ")}], maxRounds=${MAX_ROUNDS}) ====`,
);
console.log(
  `mean review rounds: ${(roundsSum / Math.max(1, tasks.length)).toFixed(2)} | tasks: ${tasks.length}`,
);
console.log(
  "\nblind pairwise (panel majority, order-counterbalanced), review (challenger) vs baseline:",
);
console.log(
  "pair".padEnd(26) +
    "judged".padStart(7) +
    "win".padStart(11) +
    "loss".padStart(11) +
    "tie".padStart(5) +
    "  net winrate 95% CI",
);
for (const [c, b] of PAIRS) {
  const key = `${c} vs ${b}`;
  const x = tally[key]!;
  const [lo, hi] = bootstrapNetCI(outcomes[key]!);
  const fmt = (v: number) => (v >= 0 ? "+" : "") + (100 * v).toFixed(0) + "%";
  console.log(
    key.padEnd(26) +
      String(x.judged).padStart(7) +
      `${x.win} (${pct(x.win, x.judged)})`.padStart(11) +
      `${x.loss} (${pct(x.loss, x.judged)})`.padStart(11) +
      String(x.tie).padStart(5) +
      `   [${fmt(lo)}, ${fmt(hi)}]`,
  );
}
console.log("\nmean answer length (chars) — verbosity check:");
for (const m of ["review", "cheap_direct", "self_review", "premium_direct"]) {
  console.log(
    `  ${m.padEnd(16)} ${Math.round(lenSum[m]! / Math.max(1, tasks.length))}`,
  );
}
const perTask = (c: number) => c / Math.max(1, tasks.length);
console.log("\nmean cost per task (USD):");
for (const m of ["review", "cheap_direct", "self_review", "premium_direct"]) {
  console.log(`  ${m.padEnd(16)} $${perTask(modeCost[m]!).toFixed(6)}`);
}
const ratio =
  modeCost.premium_direct > 0
    ? (modeCost.review / modeCost.premium_direct).toFixed(2)
    : "n/a";
console.log(
  `\nreview-loop cost / premium-one-shot cost = ${ratio}x  (frugal only if review wins/ties at <1x)`,
);
console.log(`judge spend ~$${judgeCost.toFixed(4)}`);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      cheap: CHEAP,
      premium: PREMIUM,
      judges: JUDGES,
      maxRounds: MAX_ROUNDS,
      tally,
      outcomes,
      lenSum,
      roundsSum,
      taskCount: tasks.length,
      modeCost,
      judgeCost,
      records,
    },
    null,
    2,
  ),
);
console.error(`\nwrote ${outPath}`);
