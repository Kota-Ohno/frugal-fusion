#!/usr/bin/env -S pnpm tsx
// LLM-judge experiment harness (dev tool; not part of the frozen public-report
// layer). Tests the NEW research question: on open-ended engineering tasks,
// does fixed two-candidate fusion win BLIND PAIRWISE quality comparisons vs the
// strong cheap single model (and the self_review / repeated controls), and is
// that worth its extra cost?
//
// System-under-test answers come from the real orchestrator (faithful to the
// mechanism). Judging uses a single strong NEUTRAL model (disjoint family from
// all system models) via raw chat-completions, blind to mode identity, with
// order COUNTERBALANCING: each pair is judged twice with positions swapped, and
// a side only "wins" the pair if it wins in both orders (else tie).
//
// Usage:
//   pnpm tsx scripts/judge-eval.mts examples/tasks.openended.jsonl \
//     --config examples/exp-strong-baseline.config.json \
//     --judge anthropic/claude-sonnet-4.6 --trials 1 \
//     --out .frugal-fusion/judge-strong.json

import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { loadEnvFile } from "../src/envFile.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { OpenRouterClient } from "../src/openRouterClient.js";
import { FrugalFusionOrchestrator } from "../src/orchestrator.js";

type Mode = "direct" | "self_review" | "repeated" | "fusion";
const MODES: Mode[] = ["direct", "self_review", "repeated", "fusion"];
const BASELINES: Mode[] = ["direct", "self_review", "repeated"];

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tasksPath = process.argv[2];
if (!tasksPath || tasksPath.startsWith("--")) {
  console.error(
    "usage: judge-eval.mts <tasks.jsonl> [--config p] [--models p] [--judge id] [--trials n] [--out p]",
  );
  process.exit(1);
}
const configPath = arg("--config", "examples/exp-strong-baseline.config.json")!;
const modelsPath = arg("--models", ".frugal-fusion/models.json")!;
const judgeModel = arg("--judge", "anthropic/claude-sonnet-4.6")!;
const trials = Number(arg("--trials", "1"));
const outPath = arg("--out", ".frugal-fusion/judge-result.json")!;

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

const config = await loadConfig(configPath);
const registry = ModelRegistry.fromJson(readFileSync(modelsPath, "utf8"));
const client = new OpenRouterClient({
  apiKey,
  registry,
  title: "Frugal Fusion judge experiment",
  provider: config.provider,
});
const orchestrator = new FrugalFusionOrchestrator({
  client,
  models: config.models,
  sampling: config.sampling,
  configId: config.configId,
  promptVersion: config.promptVersion,
  priceSnapshot: (ids) => registry.snapshot(ids),
});

async function runMode(
  task: string,
): Promise<Record<Mode, { answer: string | null; cost: number }>> {
  const out = {} as Record<Mode, { answer: string | null; cost: number }>;
  for (const mode of MODES) {
    try {
      const r = await orchestrator.run({
        task,
        mode,
        verification: "none",
        budget: config.budget,
      });
      out[mode] = { answer: r.answer, cost: r.totalCostUsd };
    } catch (e) {
      out[mode] = { answer: null, cost: 0 };
    }
  }
  return out;
}

const JUDGE_SYSTEM =
  "You are an impartial senior software engineer judging which of two responses better answers an engineering task. " +
  "Weigh, in order: correctness, completeness against the stated requirements, quality of risk/tradeoff reasoning, " +
  "absence of fabrication, and clarity. Be discriminating and do not default to a tie when one answer is clearly better.";

async function judge(
  task: string,
  constraints: string[],
  answerA: string,
  answerB: string,
): Promise<{ verdict: "A" | "B" | "TIE"; cost: number }> {
  const user =
    `TASK:\n${task}\n\nREQUIREMENTS THE ANSWER SHOULD ADDRESS:\n` +
    constraints.map((c) => `- ${c}`).join("\n") +
    `\n\n=== RESPONSE A ===\n${answerA}\n\n=== RESPONSE B ===\n${answerB}\n\n` +
    "Which response is better? Reply with ONLY one token on the first line: A, B, or TIE.";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: judgeModel,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 60,
      usage: { include: true },
    }),
  });
  const body: any = await res.json();
  const text: string = body.choices?.[0]?.message?.content ?? "";
  const m = text
    .trim()
    .toUpperCase()
    .match(/\b(A|B|TIE)\b/);
  return {
    verdict: (m?.[1] as "A" | "B" | "TIE") ?? "TIE",
    cost: body.usage?.cost ?? 0,
  };
}

// Counterbalanced pair: fusion (F) vs baseline (X). Returns winner from
// fusion's perspective; only consistent across both orders counts as a win.
async function judgePair(
  task: string,
  constraints: string[],
  fusionAns: string,
  baselineAns: string,
): Promise<{ outcome: "fusion" | "baseline" | "tie"; cost: number }> {
  const v1 = await judge(task, constraints, fusionAns, baselineAns); // A = fusion
  const v2 = await judge(task, constraints, baselineAns, fusionAns); // A = baseline
  let outcome: "fusion" | "baseline" | "tie" = "tie";
  if (v1.verdict === "A" && v2.verdict === "B") outcome = "fusion";
  else if (v1.verdict === "B" && v2.verdict === "A") outcome = "baseline";
  return { outcome, cost: v1.cost + v2.cost };
}

const modeCost: Record<Mode, number> = {
  direct: 0,
  self_review: 0,
  repeated: 0,
  fusion: 0,
};
const modeCompleted: Record<Mode, number> = {
  direct: 0,
  self_review: 0,
  repeated: 0,
  fusion: 0,
};
const modeAttempts: Record<Mode, number> = {
  direct: 0,
  self_review: 0,
  repeated: 0,
  fusion: 0,
};
const tally: Record<
  string,
  { fusionWins: number; baselineWins: number; ties: number; judged: number }
> = {};
for (const b of BASELINES)
  tally[b] = { fusionWins: 0, baselineWins: 0, ties: 0, judged: 0 };
let judgeCost = 0;
const records: any[] = [];

for (const t of tasks) {
  for (let trial = 0; trial < trials; trial++) {
    const ans = await runMode(t.task);
    for (const mode of MODES) {
      modeAttempts[mode]++;
      modeCost[mode] += ans[mode].cost;
      if (ans[mode].answer !== null) modeCompleted[mode]++;
    }
    const fusion = ans.fusion.answer;
    const rec: any = { id: t.id, trial, pairs: {} };
    if (fusion !== null) {
      for (const b of BASELINES) {
        const base = ans[b].answer;
        if (base === null) continue;
        const { outcome, cost } = await judgePair(
          t.task,
          t.constraints ?? [],
          fusion,
          base,
        );
        judgeCost += cost;
        tally[b].judged++;
        if (outcome === "fusion") tally[b].fusionWins++;
        else if (outcome === "baseline") tally[b].baselineWins++;
        else tally[b].ties++;
        rec.pairs[b] = outcome;
      }
    }
    records.push(rec);
    console.error(
      `judged ${t.id} (trial ${trial}) ${JSON.stringify(rec.pairs)}`,
    );
  }
}

const pct = (a: number, b: number) =>
  b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`;
console.log(
  `\n==== LLM-judge result (judge=${judgeModel}, config=${config.configId}, trials=${trials}) ====`,
);
console.log("\nfusion vs baseline (blind pairwise, order-counterbalanced):");
console.log(
  "baseline".padEnd(13) +
    "judged".padStart(8) +
    "fusionWin".padStart(11) +
    "baselineWin".padStart(13) +
    "tie".padStart(7),
);
for (const b of BASELINES) {
  const x = tally[b];
  console.log(
    b.padEnd(13) +
      String(x.judged).padStart(8) +
      `${x.fusionWins} (${pct(x.fusionWins, x.judged)})`.padStart(11) +
      `${x.baselineWins} (${pct(x.baselineWins, x.judged)})`.padStart(13) +
      String(x.ties).padStart(7),
  );
}
console.log("\nmean cost per attempt (USD) and completion rate:");
for (const m of MODES) {
  console.log(
    "  " +
      m.padEnd(13) +
      `$${(modeCost[m] / Math.max(1, modeAttempts[m])).toFixed(6)}` +
      `  completed ${pct(modeCompleted[m], modeAttempts[m])}`,
  );
}
console.log(
  `\njudge spend ~$${judgeCost.toFixed(4)} | system spend ~$${Object.values(
    modeCost,
  )
    .reduce((a, b) => a + b, 0)
    .toFixed(4)}`,
);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      judgeModel,
      configId: config.configId,
      trials,
      tally,
      modeCost,
      modeCompleted,
      modeAttempts,
      judgeCost,
      records,
    },
    null,
    2,
  ),
);
console.error(`\nwrote ${outPath}`);
