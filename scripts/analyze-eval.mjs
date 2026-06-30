#!/usr/bin/env node
// Dev analysis helper (not part of the frozen public-report layer).
// Reads a private eval report and separates COMPLETION RELIABILITY from
// ANSWER QUALITY so the cheap ensemble's reasoning is not conflated with its
// structured-output robustness.
//
// Usage: node scripts/analyze-eval.mjs <eval-report.json> [more-reports...]

import { readFileSync } from "node:fs";

const MODES = ["direct", "self_review", "repeated", "fusion"];
const DIFFS = ["easy", "med", "hard"];

function analyze(path) {
  const r = JSON.parse(readFileSync(path, "utf8"));
  // cell key -> { n, completed, passed }
  const cells = new Map();
  const bump = (k, field) => {
    const c = cells.get(k) ?? { n: 0, completed: 0, passed: 0 };
    c[field] += 1;
    cells.set(k, c);
  };
  for (const t of r.traces) {
    const [cid, , mode] = t.id.split(":");
    const diff = cid.split("-")[1];
    const completed = t.outcome.status === "completed";
    const passed = completed && t.outcome.result?.verification?.passed === true;
    for (const k of [`${diff}|${mode}`, `all|${mode}`]) {
      bump(k, "n");
      if (completed) bump(k, "completed");
      if (passed) bump(k, "passed");
    }
  }
  const pct = (a, b) =>
    b === 0 ? "  n/a" : `${((100 * a) / b).toFixed(0).padStart(3)}%`;
  const cell = (k) => cells.get(k) ?? { n: 0, completed: 0, passed: 0 };

  console.log(`\n==================== ${path} ====================`);
  console.log(
    "(pass = passed/total | complete = completed/total | quality = passed/completed)\n",
  );
  for (const metric of [
    ["pass rate (passed / total)", (c) => pct(c.passed, c.n)],
    ["completion rate (completed / total)", (c) => pct(c.completed, c.n)],
    [
      "quality | completed (passed / completed)",
      (c) => pct(c.passed, c.completed),
    ],
  ]) {
    console.log(metric[0]);
    console.log(
      "  " +
        "diff".padEnd(7) +
        MODES.map((m) => m.slice(0, 8).padStart(9)).join(""),
    );
    for (const d of [...DIFFS, "all"]) {
      console.log(
        "  " +
          d.padEnd(7) +
          MODES.map((m) => metric[1](cell(`${d}|${m}`)).padStart(9)).join(""),
      );
    }
    console.log("");
  }
  // cost per pass straight from the report metrics, if present
  if (r.metrics?.cost_per_pass) {
    console.log("cost_per_pass:", JSON.stringify(r.metrics.cost_per_pass));
  }
}

// Headroom view: restrict to cases the direct baseline did NOT ace (passed on
// fewer than all its trials). Only on such cases can an ensemble's reasoning
// possibly beat the strong single model. Reports quality-given-completion so
// structured-output robustness is not conflated with reasoning.
function headroom(path) {
  const r = JSON.parse(readFileSync(path, "utf8"));
  const directTrials = new Map(); // caseId -> { n, passed }
  for (const t of r.traces) {
    const [cid, , mode] = t.id.split(":");
    if (mode !== "direct") continue;
    const d = directTrials.get(cid) ?? { n: 0, passed: 0 };
    d.n += 1;
    if (t.outcome.result?.verification?.passed === true) d.passed += 1;
    directTrials.set(cid, d);
  }
  const headroomCases = new Set(
    [...directTrials.entries()]
      .filter(([, d]) => d.passed < d.n)
      .map(([cid]) => cid),
  );
  const agg = new Map(); // mode -> { n, completed, passed }
  for (const t of r.traces) {
    const [cid, , mode] = t.id.split(":");
    if (!headroomCases.has(cid)) continue;
    const a = agg.get(mode) ?? { n: 0, completed: 0, passed: 0 };
    const completed = t.outcome.status === "completed";
    a.n += 1;
    if (completed) a.completed += 1;
    if (completed && t.outcome.result?.verification?.passed === true)
      a.passed += 1;
    agg.set(mode, a);
  }
  const pct = (a, b) => (b === 0 ? " n/a" : `${((100 * a) / b).toFixed(0)}%`);
  console.log(
    `\n---- HEADROOM subset of ${path}: ${headroomCases.size}/${directTrials.size} cases the direct baseline did not ace ----`,
  );
  console.log(
    "mode".padEnd(13) +
      "pass".padStart(8) +
      "complete".padStart(10) +
      "quality|compl".padStart(15),
  );
  for (const m of MODES) {
    const a = agg.get(m) ?? { n: 0, completed: 0, passed: 0 };
    console.log(
      m.padEnd(13) +
        pct(a.passed, a.n).padStart(8) +
        pct(a.completed, a.n).padStart(10) +
        pct(a.passed, a.completed).padStart(15),
    );
  }
}

const paths = process.argv.slice(2).filter((p) => p !== "--headroom");
const withHeadroom = process.argv.includes("--headroom");
if (paths.length === 0) {
  console.error(
    "usage: node scripts/analyze-eval.mjs <eval-report.json> [...]",
  );
  process.exit(1);
}
for (const p of paths) {
  analyze(p);
  if (withHeadroom) headroom(p);
}
