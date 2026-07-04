// sample-select-polish: the Sample + Select stages as one workflow run.
// Fan out N fresh-context drafting agents (one stance persona each) →
// single-elimination pairwise tournament judged by fresh-context agents →
// return the winning draft.
//
// The CALLING (main) agent then runs the Polish stage itself: ONE round of
// fresh-eyes-review on the winner, fixing surviving findings with its own
// full context. Do not loop the polish — refinement gains die after the
// first round (see SKILL.md).
//
// args = {
//   task:     string — what to produce, with every requirement spelled out
//             (fresh agents see ONLY this; include acceptance criteria)
//   guidance: string — optional style/length/format constraints applied to
//             every draft (e.g. "under 600 words", "TypeScript only")
//   n:        number — draft count, 2..6 (default 6; one per persona)
// }
// returns { winner, persona, candidates, matches, empty_drafts }

export const meta = {
  name: "sample-select",
  description:
    "Sample N stance-diverse drafts in parallel, then select the best via a pairwise knockout tournament — the Sample and Select stages of sample-select-polish.",
  phases: [
    {
      title: "Sample",
      detail: "one fresh-context drafting agent per stance persona",
    },
    {
      title: "Select",
      detail:
        "single-elimination pairwise tournament, matches within a round in parallel",
    },
  ],
};

// Diversity lives at draft time: each agent gets one engineering stance.
// Mirrors DRAFT_PERSONAS in the benchmark harness (src/sampleSelect.ts of
// the frugal-fusion repo), where this pipeline tied a 2-round adversarial
// review loop's quality at 0.58x cost on 48 hard tasks.
const PERSONAS = [
  {
    key: "correctness",
    stance:
      "Approach the problem as an engineer obsessed with logical correctness: get every invariant, condition, and state transition exactly right.",
  },
  {
    key: "edge-cases",
    stance:
      "Approach the problem as an engineer who designs from the failure modes inward: handle boundary conditions, race conditions, and hostile inputs first.",
  },
  {
    key: "requirements",
    stance:
      "Approach the problem as an engineer who treats the stated requirements as a contract: address every single one explicitly and completely.",
  },
  {
    key: "security",
    stance:
      "Approach the problem as a security-minded engineer: assume inputs are hostile, validate everything, and design for least privilege.",
  },
  {
    key: "neutral",
    stance: "Approach the problem as a well-rounded senior engineer.",
  },
  {
    key: "simplicity",
    stance:
      "Approach the problem as an engineer who prizes simplicity: find the most robust design with the fewest moving parts, and say no to overengineering.",
  },
];

const task = (args && args.task) || "";
if (!task)
  throw new Error(
    "args.task is required: the full task statement the drafting agents will work from",
  );
const guidance = (args && args.guidance) || "";
const requested = (args && args.n) || 6;
const n = Math.max(2, Math.min(6, requested));

function draftPrompt(persona) {
  return [
    "You are drafting an artifact from a cold start — no conversation history, no prior drafts. " +
      persona.stance,
    "",
    "## Task",
    task,
    guidance ? "\n## Constraints\n" + guidance : "",
    "",
    'Produce the complete artifact. Keep it focused and tight — cover every requirement, but do not pad: length is not quality, and the selection stage is instructed not to reward it. Commit to concrete mechanisms and name their tradeoffs ("per-key mutex; contention is bounded by the rate limit itself") — hedged generalities ("appropriate locking should be used") lose tournaments. Your final message IS the draft: return only the artifact text, with no meta-commentary about your approach.',
  ].join("\n");
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    winner: { type: "string", enum: ["A", "B"] },
    reason: {
      type: "string",
      description: "one sentence on the deciding difference",
    },
  },
  required: ["winner"],
};

function matchPrompt(draftA, draftB) {
  return [
    "You are an impartial senior engineer selecting which of two responses better answers a task. Weigh, in order: correctness, completeness against the stated requirements, handling of edge cases and failure modes, absence of fabrication, and clarity. Do not favor a response merely for being longer or more detailed than necessary.",
    "",
    "## Task",
    task,
    "",
    "## Response A",
    draftA,
    "",
    "## Response B",
    draftB,
    "",
    'Pick the better response. Decide on concrete substance: a response that commits to specific, correct mechanisms beats one that hedges or pads. Your reason must cite the deciding difference ("A\'s refill math drifts after idle periods"), not overall impressions ("B is more thorough").',
  ].join("\n");
}

phase("Sample");
log(
  "Drafting with " +
    n +
    " personas: " +
    PERSONAS.slice(0, n)
      .map(function (p) {
        return p.key;
      })
      .join(", "),
);
const draftResults = await parallel(
  PERSONAS.slice(0, n).map(function (p) {
    return function () {
      return agent(draftPrompt(p), {
        label: "draft:" + p.key,
        phase: "Sample",
      }).then(function (text) {
        return { key: p.key, text: text };
      });
    };
  }),
);

const alive = draftResults.filter(Boolean).filter(function (d) {
  return typeof d.text === "string" && d.text.trim().length > 0;
});
const emptyDrafts = n - alive.length;
if (alive.length === 0)
  throw new Error("All drafts came back empty — nothing to select from");
if (emptyDrafts > 0)
  log("Dropped " + emptyDrafts + " empty draft(s) before the tournament");

phase("Select");
// Single-elimination bracket over alive[] indices. Adjacent pairing; odd
// pool -> last entry gets a bye. Presentation order (which draft is shown
// as "A") alternates with (round + match) parity so a systematic
// first-position bias in the judge cannot favor one bracket path.
let pool = alive.map(function (_, i) {
  return i;
});
let roundIndex = 0;
let matchCount = 0;
while (pool.length > 1) {
  const matches = [];
  const pairCount = Math.floor(pool.length / 2);
  for (let m = 0; m < pairCount; m += 1) {
    const first = pool[2 * m];
    const second = pool[2 * m + 1];
    matches.push(
      (roundIndex + m) % 2 === 0
        ? { a: first, b: second }
        : { a: second, b: first },
    );
  }
  const bye = pool.length % 2 === 1 ? pool[pool.length - 1] : null;
  const winners = await parallel(
    matches.map(function (match) {
      return function () {
        return agent(matchPrompt(alive[match.a].text, alive[match.b].text), {
          label: "match:" + alive[match.a].key + "-vs-" + alive[match.b].key,
          phase: "Select",
          schema: VERDICT_SCHEMA,
        }).then(function (v) {
          // A skipped/errored judge yields null — default to the A side
          // (presentation alternation keeps this from biasing one draft).
          return v && v.winner === "B" ? match.b : match.a;
        });
      };
    }),
  );
  matchCount += matches.length;
  roundIndex += 1;
  pool = bye === null ? winners : winners.concat([bye]);
}

const winnerIndex = pool[0];
log(
  "Winner: " +
    alive[winnerIndex].key +
    " (" +
    matchCount +
    " matches, " +
    alive.length +
    " candidates)",
);

return {
  winner: alive[winnerIndex].text,
  persona: alive[winnerIndex].key,
  candidates: alive.length,
  matches: matchCount,
  empty_drafts: emptyDrafts,
};
