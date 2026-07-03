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
//
// Optional hybrid finder/writer mode: --writer <model> routes only the
// per-round revise/synthesis call to a different (typically higher
// language-quality) model, while draft/critiques/skeptic stay on --cheap.
// This matters for reasoning-heavy cheap models: their raw revise output can
// read as unpolished (visible deliberation leaking into prose) even when the
// underlying critique/fix content is sound. Omit --writer to keep the
// original single-model loop.
//
// Reasoning models (DeepSeek V4 Flash, GPT-5.5, GPT-5.4-pro, MiniMax M2.7,
// etc.) can spend most or all of a small max_tokens budget on hidden
// reasoning tokens before emitting any visible content, returning an EMPTY
// answer that still gets billed. Use --cheap-max-tokens / --premium-max-tokens
// / --writer-max-tokens to give reasoning-heavy models enough headroom; watch
// stderr for "(EMPTY)" answers as a sign the budget is still too small.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "../src/envFile.js";
import {
  DRAFT_PERSONAS,
  parseArms,
  parsePairs,
  parseVerdict,
  runTournament,
} from "../src/sampleSelect.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const tasksPath = process.argv[2];
if (!tasksPath || tasksPath.startsWith("--")) {
  console.error(
    "usage: review-eval.mts <tasks.jsonl> [--cheap id] [--premium id] [--writer id] [--judge id] [--rounds n]" +
      " [--cheap-max-tokens n] [--critique-max-tokens n] [--writer-max-tokens n] [--premium-max-tokens n]" +
      " [--concurrency n] [--out p] [--arms a,b,c] [--pairs c:b,c:b] [--drafts n] [--draft-temp t]" +
      " [--select-max-tokens n] [--dump-answers dir]",
  );
  process.exit(1);
}
const CHEAP = arg("--cheap", "google/gemini-2.5-flash");
const PREMIUM = arg("--premium", "google/gemini-3-flash-preview");

// Arms opt-in: without --arms harness reproduces original four-arm behavior
// exactly. "ssp" = sample-select-polish, "ss" = sample-select ablation
// control without the polish stage.
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
// Optional writer model for the revise/synthesis step only (hybrid mode).
// Falls back to CHEAP, reproducing the original single-model loop.
const WRITER = arg("--writer", CHEAP);
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
// Per-role token budgets. Defaults match the original non-reasoning-model
// tuning (qwen3-235b-2507); raise these for reasoning-heavy models.
const CHEAP_MAX_TOKENS = Number(arg("--cheap-max-tokens", "1500"));
const CRITIQUE_MAX_TOKENS = Number(arg("--critique-max-tokens", "600"));
const WRITER_MAX_TOKENS = Number(
  arg("--writer-max-tokens", String(CHEAP_MAX_TOKENS)),
);
const PREMIUM_MAX_TOKENS = Number(arg("--premium-max-tokens", "1500"));
const outPath = arg("--out", ".frugal-fusion/review-result.json");
// sample-select-polish (ssp/ss) tuning.
const N_DRAFTS = Number(arg("--drafts", "6"));
const DRAFT_TEMP = Number(arg("--draft-temp", "0.7"));
// 800 default absorbs hidden reasoning-token overhead on reasoning-heavy
// cheap models while keeping selection calls short and fast.
const SELECT_MAX_TOKENS = Number(arg("--select-max-tokens", "800"));
const DUMP_DIR = arg("--dump-answers", "");

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
const modeCost: Record<string, number> = Object.fromEntries(
  ARMS.map((a) => [a, 0]),
);
let judgeCost = 0;

const GEN_RETRY_ATTEMPTS = 2;
const GEN_RETRY_BACKOFF_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gen(
  model: string,
  system: string,
  user: string,
  temperature: number,
  maxTokens: number,
): Promise<{ text: string; cost: number }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= GEN_RETRY_ATTEMPTS; attempt++) {
    let body: any;
    try {
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
      body = await res.json();
    } catch (err) {
      // Network errors and malformed/empty response bodies (res.json()
      // throwing SyntaxError on a truncated stream) must not crash the
      // whole multi-task run — a single flaky call would otherwise discard
      // every already-billed task processed so far.
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < GEN_RETRY_ATTEMPTS) {
        await sleep(GEN_RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      console.error(`gen(${model}) failed after retries: ${lastError}`);
      return { text: "", cost: 0 };
    }
    // OpenRouter reports transient upstream errors (provider overload, etc.)
    // as a 200 response with a top-level `error`, not an HTTP error status —
    // the original version of this function treated that as an empty answer
    // billed at $0, silently corrupting results instead of retrying.
    if (body.error) {
      lastError = `${body.error.code ?? "?"} ${body.error.message ?? ""}`;
      if (attempt < GEN_RETRY_ATTEMPTS) {
        await sleep(GEN_RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      console.error(`gen(${model}) failed after retries: ${lastError}`);
      return { text: "", cost: 0 };
    }
    const text: string = body.choices?.[0]?.message?.content ?? "";
    return { text, cost: body.usage?.cost ?? 0 };
  }
  return { text: "", cost: 0 };
}

const TASK_SYSTEM =
  "You are a senior software engineer. Answer the engineering task directly, correctly, and concisely (a few hundred words). Address every stated requirement.";

const cList = (cs?: string[]) => (cs ?? []).map((c) => `- ${c}`).join("\n");

async function cheapDirect(t: {
  task: string;
}): Promise<{ text: string; cost: number }> {
  return gen(CHEAP, TASK_SYSTEM, t.task, 0.3, CHEAP_MAX_TOKENS);
}

async function premiumDirect(t: {
  task: string;
}): Promise<{ text: string; cost: number }> {
  return gen(PREMIUM, TASK_SYSTEM, t.task, 0.3, PREMIUM_MAX_TOKENS);
}

async function selfReview(t: {
  task: string;
  constraints?: string[];
}): Promise<{ text: string; cost: number }> {
  const draft = await gen(CHEAP, TASK_SYSTEM, t.task, 0.3, CHEAP_MAX_TOKENS);
  const rev = await gen(
    CHEAP,
    TASK_SYSTEM +
      " Review your own answer for errors, omissions, and edge cases, then output an improved final answer.",
    `TASK:\n${t.task}\n\nYOUR DRAFT:\n${draft.text}\n\nOutput the improved final answer only.`,
    0.2,
    CHEAP_MAX_TOKENS,
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
    .replace(/[^A-Z]/g, "") === "NONE";
// An empty response is NOT the same claim as an explicit "NONE" — it usually
// means a reasoning-heavy model burned its whole token budget on hidden
// reasoning before writing anything (see gen()'s header comment). Treating
// it as "no issues found" would silently converge the loop on a starved
// call instead of a genuine clean verdict, corrupting results without any
// visible signal. Callers must check isEmpty separately and log a warning.
const isEmpty = (s: string) => s.trim() === "";

async function reviewLoop(t: {
  task: string;
  constraints?: string[];
}): Promise<{ answer: string; rounds: number; cost: number }> {
  const draft0 = await gen(CHEAP, TASK_SYSTEM, t.task, 0.3, CHEAP_MAX_TOKENS);
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
          CRITIQUE_MAX_TOKENS,
        );
        return r;
      }),
    );
    for (const c of critiques) cost += c.cost;
    critiques.forEach((r, i) => {
      if (isEmpty(r.text)) {
        console.error(
          `WARNING: critique[${LENSES[i]!.name}] for ${CHEAP} returned an EMPTY response (not an explicit NONE) — likely reasoning-token truncation. Consider raising --critique-max-tokens (currently ${CRITIQUE_MAX_TOKENS}).`,
        );
      }
    });
    const combined = critiques
      .map((r, i) =>
        isNone(r.text) || isEmpty(r.text)
          ? ""
          : `[${LENSES[i]!.name}]\n${r.text}`,
      )
      .filter(Boolean)
      .join("\n\n");
    if (!combined) break; // all lenses clean (or empty) -> converged
    const skeptic = await gen(
      CHEAP,
      "You are a skeptical lead reviewer. Given a draft and alleged issues, KEEP only issues that are real, specific, and material to correctness or requirements; discard vague, stylistic, or false-positive items. If none survive, reply exactly NONE.",
      `TASK:\n${t.task}\n\nDRAFT:\n${draft}\n\nALLEGED ISSUES:\n${combined}\n\nReturn only the surviving real issues as concise bullets, or NONE.`,
      0,
      CRITIQUE_MAX_TOKENS,
    );
    cost += skeptic.cost;
    if (isEmpty(skeptic.text)) {
      console.error(
        `WARNING: skeptic for ${CHEAP} returned an EMPTY response (not an explicit NONE) — likely reasoning-token truncation. Consider raising --critique-max-tokens (currently ${CRITIQUE_MAX_TOKENS}).`,
      );
    }
    if (isNone(skeptic.text) || isEmpty(skeptic.text)) break; // every issue was a false positive (or skeptic call was starved) -> converged
    rounds = round + 1;
    // Writer step: hybrid mode routes this to WRITER (a different, typically
    // higher language-quality model) instead of CHEAP. See header comment.
    //
    // Deliberately NOT forcing a target length here. An earlier version
    // anchored the writer to ~1.15x the first draft's length, but that
    // conflates two different interventions in one change: "tell the judge
    // not to reward length" (a legitimate bias correction — see JUDGE_SYSTEM)
    // vs. "force the generator to be short" (which can cut real, necessary
    // content along with padding, silently handicapping review's quality
    // rather than correcting a measurement bias). Keep length free; let the
    // judge instruction do the bias-correction work, so a length effect (if
    // any survives) can be attributed to one isolated variable.
    const revised = await gen(
      WRITER,
      TASK_SYSTEM +
        " You are revising a draft to fix specific reviewer-identified issues. Keep what is correct; fix the listed issues; write cleanly and do not narrate your reasoning process — output only the final polished answer.",
      `TASK:\n${t.task}\nREQUIREMENTS:\n${cList(t.constraints)}\n\nCURRENT DRAFT:\n${draft}\n\nISSUES TO FIX:\n${skeptic.text}\n\nOutput the improved final answer.`,
      0.2,
      WRITER_MAX_TOKENS,
    );
    cost += revised.cost;
    draft = revised.text;
  }
  return { answer: draft, rounds, cost };
}

type Task = { id: string; task: string; constraints?: string[] };

const SELECT_SYSTEM =
  "You are an impartial senior software engineer selecting which of two responses better answers an engineering task. " +
  "Weigh, in order: correctness, completeness against the stated requirements, handling of edge cases and failure modes, " +
  "absence of fabrication, and clarity. Do not favor a response merely for being longer or more detailed than necessary. " +
  'Reply with exactly one character: "A" or "B".';

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

async function selectWinner(
  t: Task,
  drafts: string[],
): Promise<{
  winner: string;
  cost: number;
  matchCount: number;
  aliveCount: number;
  unparseable: number;
}> {
  // Drop empty drafts up front — a starved draft must not win by judge
  // confusion, and must not silently count as a real candidate.
  const alive = drafts
    .map((text, i) => ({ text, i }))
    .filter((d) => !isEmpty(d.text));
  if (alive.length === 0)
    return {
      winner: "",
      cost: 0,
      matchCount: 0,
      aliveCount: 0,
      unparseable: 0,
    };
  let cost = 0;
  let unparseable = 0;
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
      const verdict = parseVerdict(r.text);
      if (verdict === "B") return b;
      if (verdict === "A") return a;
      unparseable++;
      console.error(
        `WARNING: tournament verdict unparseable ("${r.text.slice(0, 40)}") — defaulting to the A side.`,
      );
      return a;
    },
  );
  return {
    winner: alive[winner]!.text,
    cost,
    matchCount,
    aliveCount: alive.length,
    unparseable,
  };
}

type TournamentStats = {
  matchCount: number;
  aliveCount: number;
  unparseable: number;
};

async function sampleSelect(t: Task): Promise<{
  answer: string;
  rounds: number;
  cost: number;
  tournament: TournamentStats;
}> {
  const { drafts, cost: draftCost } = await sampleDrafts(t);
  const sel = await selectWinner(t, drafts);
  return {
    answer: sel.winner,
    rounds: 0,
    cost: draftCost + sel.cost,
    tournament: {
      matchCount: sel.matchCount,
      aliveCount: sel.aliveCount,
      unparseable: sel.unparseable,
    },
  };
}

async function sampleSelectPolish(t: Task): Promise<{
  answer: string;
  rounds: number;
  cost: number;
  tournament: TournamentStats;
}> {
  const { drafts, cost: draftCost } = await sampleDrafts(t);
  const sel = await selectWinner(t, drafts);
  const tournament: TournamentStats = {
    matchCount: sel.matchCount,
    aliveCount: sel.aliveCount,
    unparseable: sel.unparseable,
  };
  let cost = draftCost + sel.cost;
  let answer = sel.winner;
  if (isEmpty(answer)) return { answer, rounds: 0, cost, tournament };
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
  critiques.forEach((r, i) => {
    if (isEmpty(r.text)) {
      console.error(
        `WARNING: critique[${LENSES[i]!.name}] for ${CHEAP} returned an EMPTY response (not an explicit NONE) — likely reasoning-token truncation. Consider raising --critique-max-tokens (currently ${CRITIQUE_MAX_TOKENS}).`,
      );
    }
  });
  const combined = critiques
    .map((r, i) =>
      isNone(r.text) || isEmpty(r.text)
        ? ""
        : `[${LENSES[i]!.name}]\n${r.text}`,
    )
    .filter(Boolean)
    .join("\n\n");
  if (!combined) return { answer, rounds: 0, cost, tournament };
  const skeptic = await gen(
    CHEAP,
    "You are a skeptical lead reviewer. Given a draft and alleged issues, KEEP only issues that are real, specific, and material to correctness or requirements; discard vague, stylistic, or false-positive items. If none survive, reply exactly NONE.",
    `TASK:\n${t.task}\n\nDRAFT:\n${answer}\n\nALLEGED ISSUES:\n${combined}\n\nReturn only the surviving real issues as concise bullets, or NONE.`,
    0,
    CRITIQUE_MAX_TOKENS,
  );
  cost += skeptic.cost;
  if (isEmpty(skeptic.text)) {
    console.error(
      `WARNING: skeptic for ${CHEAP} returned an EMPTY response (not an explicit NONE) — likely reasoning-token truncation. Consider raising --critique-max-tokens (currently ${CRITIQUE_MAX_TOKENS}).`,
    );
  }
  if (isNone(skeptic.text) || isEmpty(skeptic.text))
    return { answer, rounds: 0, cost, tournament };
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
  return { answer, rounds: 1, cost, tournament };
}

const JUDGE_SYSTEM =
  "You are an impartial senior software engineer judging which of two responses better answers an engineering task. " +
  "Weigh, in order: correctness, completeness against the stated requirements, handling of edge cases and failure modes, " +
  "absence of fabrication, and clarity. Be discriminating; do not default to a tie when one is clearly better. " +
  "Do not favor a response merely for being longer or more detailed than necessary — length and thoroughness are not " +
  "the same thing. A concise response that fully and correctly satisfies the requirements should beat, or at least " +
  "tie, a longer one that pads with repetition, restates the obvious, or over-explains without adding substance.";

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
const tally: Record<
  string,
  { win: number; loss: number; tie: number; judged: number }
> = {};
for (const [c, b] of PAIRS)
  tally[`${c} vs ${b}`] = { win: 0, loss: 0, tie: 0, judged: 0 };
let roundsSum = 0;
// Global tournament observability accumulators across all ssp/ss task runs.
let tournamentMatchesTotal = 0;
let tournamentUnparseableTotal = 0;
const records: any[] = [];
// Per-pair per-task outcomes (+1 challenger win, -1 baseline win, 0 tie) for
// task-level bootstrap confidence intervals.
const outcomes: Record<string, number[]> = {};
for (const [c, b] of PAIRS) outcomes[`${c} vs ${b}`] = [];
// Mean answer length per mode (chars) — a verbosity-bias check.
const lenSum: Record<string, number> = Object.fromEntries(
  ARMS.map((a) => [a, 0]),
);
// Mean wall-clock per mode (ms).
const elapsedSum: Record<string, number> = Object.fromEntries(
  ARMS.map((a) => [a, 0]),
);

// Run at most CONCURRENCY tasks at once. Tasks are fully independent (each
// only touches its own local state), so this changes wall-clock time only —
// not results. Kept modest (not "run all 48 at once") because concurrent
// requests hitting the SAME model previously caused intermittent
// provider_error responses in this project's orchestrator (see runRepeated
// in src/orchestrator.ts); gen()'s retry logic now absorbs transient errors,
// but a large fan-out still multiplies retry risk across a run. Override
// with --concurrency.
const CONCURRENCY = Number(arg("--concurrency", "4"));

const ARM_FNS: Record<
  string,
  (t: Task) => Promise<{
    answer: string;
    rounds: number;
    cost: number;
    tournament?: TournamentStats;
  }>
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
  const tournamentByArm: Record<string, TournamentStats> = {};
  for (const r of results) {
    ans[r.name] = r.answer;
    elapsed[r.name] = r.elapsedMs;
    modeCost[r.name] = (modeCost[r.name] ?? 0) + r.cost;
    lenSum[r.name] = (lenSum[r.name] ?? 0) + r.answer.length;
    elapsedSum[r.name] = (elapsedSum[r.name] ?? 0) + r.elapsedMs;
    if (r.name === "review") reviewRounds = r.rounds;
    if (r.tournament) {
      tournamentByArm[r.name] = r.tournament;
      tournamentMatchesTotal += r.tournament.matchCount;
      tournamentUnparseableTotal += r.tournament.unparseable;
    }
  }
  roundsSum += reviewRounds;
  const rec: any = {
    id: t.id,
    rounds: reviewRounds,
    tournament: tournamentByArm,
    pairs: {},
    elapsedMs: elapsed,
  };
  // The judged pairs are independent judgments — run them concurrently
  // instead of one after another (each internally already fans out N
  // judges x 2 orders).
  const judged = await Promise.all(
    PAIRS.filter(([c, b]) => ans[c] && ans[b]).map(async ([c, b]) => {
      const o = await panelPair(t.task, t.constraints ?? [], ans[c]!, ans[b]!);
      return { c, b, o };
    }),
  );
  for (const { c, b, o } of judged) {
    const key = `${c} vs ${b}`;
    tally[key].judged++;
    if (o === "challenger") tally[key].win++;
    else if (o === "baseline") tally[key].loss++;
    else tally[key].tie++;
    outcomes[key]!.push(o === "challenger" ? 1 : o === "baseline" ? -1 : 0);
    rec.pairs[key] = o;
  }
  records.push(rec);
  console.error(`${t.id} rounds=${reviewRounds} ${JSON.stringify(rec.pairs)}`);
  if (DUMP_DIR) {
    writeFileSync(
      join(DUMP_DIR, `${t.id}.json`),
      JSON.stringify(
        {
          id: t.id,
          task: t.task,
          answers: ans,
          elapsedMs: elapsed,
          tournament: tournamentByArm,
        },
        null,
        2,
      ),
    );
  }
}

if (DUMP_DIR) mkdirSync(DUMP_DIR, { recursive: true });

{
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const t = tasks[nextIndex++]!;
      await runTask(t);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker),
  );
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
  `\n==== adversarial review (cheap=${CHEAP}, writer=${WRITER}, premium=${PREMIUM}, judges=[${JUDGES.join(", ")}], maxRounds=${MAX_ROUNDS}) ====`,
);
console.log(
  `token budgets: cheap=${CHEAP_MAX_TOKENS} critique=${CRITIQUE_MAX_TOKENS} writer=${WRITER_MAX_TOKENS} premium=${PREMIUM_MAX_TOKENS}`,
);
if (armSet.has("review")) {
  console.log(
    `mean review rounds: ${(roundsSum / Math.max(1, tasks.length)).toFixed(2)} | tasks: ${tasks.length}`,
  );
} else {
  console.log(`tasks: ${tasks.length}`);
}
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
for (const m of ARMS) {
  console.log(
    `  ${m.padEnd(16)} ${Math.round(lenSum[m]! / Math.max(1, tasks.length))}`,
  );
}
const perTask = (c: number) => c / Math.max(1, tasks.length);
console.log("\nmean cost per task (USD):");
for (const m of ARMS) {
  console.log(`  ${m.padEnd(16)} $${perTask(modeCost[m]!).toFixed(6)}`);
}
console.log("\nmean wall-clock per task (seconds):");
for (const m of ARMS) {
  console.log(
    `  ${m.padEnd(16)} ${(elapsedSum[m]! / 1000 / Math.max(1, tasks.length)).toFixed(1)}s`,
  );
}
const ratio =
  modeCost.premium_direct > 0
    ? (modeCost.review / modeCost.premium_direct).toFixed(2)
    : "n/a";
console.log(
  `\nreview-loop cost / premium-one-shot cost = ${ratio}x  (frugal only if review wins/ties at <1x)`,
);
console.log(`judge spend ~$${judgeCost.toFixed(4)}`);
if (armSet.has("ssp") || armSet.has("ss")) {
  console.log(
    `tournament: ${tournamentMatchesTotal} matches, ${tournamentUnparseableTotal} unparseable verdicts (${pct(tournamentUnparseableTotal, tournamentMatchesTotal)})`,
  );
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      cheap: CHEAP,
      writer: WRITER,
      premium: PREMIUM,
      judges: JUDGES,
      maxRounds: MAX_ROUNDS,
      tokenBudgets: {
        cheap: CHEAP_MAX_TOKENS,
        critique: CRITIQUE_MAX_TOKENS,
        writer: WRITER_MAX_TOKENS,
        premium: PREMIUM_MAX_TOKENS,
      },
      arms: ARMS,
      tally,
      outcomes,
      lenSum,
      elapsedSum,
      roundsSum,
      taskCount: tasks.length,
      modeCost,
      judgeCost,
      tournamentMatchesTotal,
      tournamentUnparseableTotal,
      records,
    },
    null,
    2,
  ),
);
console.error(`\nwrote ${outPath}`);
