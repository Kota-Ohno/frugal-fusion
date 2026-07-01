#!/usr/bin/env node
// One-off generator for docs/results-summary.{pdf,png} (not part of the public-release
// claim-gate pipeline — a plain visual summary of already-published numbers in
// docs/PUBLICATION.md / docs/EXPERIMENT_RESULTS.md).
//
// pdf  = full one-pager, linked from the tweet thread
// png  = compact 1200x675 landscape card, attached directly to the tweet
//        (X does not accept PDF as tweet media)
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const chromeBin =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workDir = await mkdtemp(join(tmpdir(), "frugal-fusion-results-summary-"));

const bars = [
  { label: "vs cheap one-shot", lo: 73, hi: 96, mid: 84.5, record: "42-1-5" },
  {
    label: "vs simple self-review",
    lo: 60,
    hi: 88,
    mid: 74,
    record: "37-1-10",
  },
  {
    label: "vs premium one-shot (GPT-5.1)",
    lo: -4,
    hi: 27,
    mid: 11.5,
    record: "11-5-32",
  },
];

function renderChart({
  chartWidth,
  chartHeight,
  plotLeft,
  plotRight,
  plotTop,
  plotBottom,
  labelFontSize,
  valueFontSize,
}) {
  const axisMin = -20;
  const axisMax = 100;
  const barGap = (plotBottom - plotTop) / bars.length;

  function xForValue(v) {
    return (
      plotLeft + ((v - axisMin) / (axisMax - axisMin)) * (plotRight - plotLeft)
    );
  }

  const zeroX = xForValue(0);

  const gridLines = [-20, 0, 20, 40, 60, 80, 100]
    .map((v) => {
      const x = xForValue(v);
      return `
        <line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="#e2e2e2" stroke-width="1" />
        <text x="${x}" y="${plotBottom + 18}" font-size="${valueFontSize}" fill="#666" text-anchor="middle">${v}%</text>
      `;
    })
    .join("");

  const barsSvg = bars
    .map((bar, i) => {
      const yCenter = plotTop + barGap * i + barGap / 2;
      const x1 = xForValue(bar.lo);
      const x2 = xForValue(bar.hi);
      const xMid = xForValue(bar.mid);
      const tie = bar.lo < 0 && bar.hi > 0;
      const color = tie ? "#9b8f00" : "#1a6b3c";
      return `
        <line x1="${x1}" y1="${yCenter}" x2="${x2}" y2="${yCenter}" stroke="${color}" stroke-width="7" stroke-linecap="round" />
        <circle cx="${xMid}" cy="${yCenter}" r="5.5" fill="${color}" />
        <text x="${plotLeft - 12}" y="${yCenter - 6}" font-size="${labelFontSize}" fill="#111" text-anchor="end" font-weight="600">${bar.label}</text>
        <text x="${plotLeft - 12}" y="${yCenter + 13}" font-size="${valueFontSize}" fill="#666" text-anchor="end">${tie ? "tie" : "win"} · ${bar.record}</text>
        <text x="${x2 + 8}" y="${yCenter + 4}" font-size="${valueFontSize}" fill="#333" font-weight="600">${bar.lo > 0 ? "+" : ""}${bar.lo}…${bar.hi > 0 ? "+" : ""}${bar.hi}%</text>
      `;
    })
    .join("");

  return `<svg width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">
    ${gridLines}
    <line x1="${zeroX}" y1="${plotTop}" x2="${zeroX}" y2="${plotBottom}" stroke="#999" stroke-width="1.5" />
    ${barsSvg}
  </svg>`;
}

async function runChrome(args) {
  const result = spawnSync(chromeBin, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    process.exit(1);
  }
}

// ---- PDF: full one-pager --------------------------------------------------

async function buildPdf() {
  const htmlPath = join(workDir, "results-summary.html");
  const pdfPath = join(repoRoot, "docs", "results-summary.pdf");

  const chart = renderChart({
    chartWidth: 700,
    chartHeight: 260,
    plotLeft: 210,
    plotRight: 620,
    plotTop: 10,
    plotBottom: 230,
    labelFontSize: 13,
    valueFontSize: 11,
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 28mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; padding: 0; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { font-size: 13px; color: #555; margin: 0 0 22px; }
  .summary { font-size: 13px; line-height: 1.55; margin: 0 0 22px; }
  .summary b { background: #fff4c2; padding: 0 2px; }
  .chart-title { font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  .chart-caption { font-size: 11px; color: #666; margin: 6px 0 24px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 22px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f4f4f4; }
  .limits { font-size: 11.5px; color: #444; line-height: 1.5; border-top: 1px solid #ddd; padding-top: 10px; }
  .limits b { color: #111; }
  .footer { font-size: 10px; color: #999; margin-top: 18px; }
</style>
</head>
<body>
  <h1>Depth beats breadth: cheap model + adversarial review</h1>
  <p class="subtitle">Frugal Fusion experiment — 48 hard engineering tasks, 3-model blind judge panel, 95% bootstrap CIs</p>

  <p class="summary">
    A fresh-eyes adversarial review loop (draft &rarr; multi-lens critics &rarr; skeptic filter &rarr; revise, to convergence)
    run on a <b>single cheap model</b> (qwen3-235b) reaches <b>premium-model (GPT-5.1) quality parity at 0.66&times; the cost</b>
    on hard engineering tasks, and decisively beats its own single-shot and simple self-review baselines.
    A separate multi-model ensemble ("fusion") approach was tested first and did <b>not</b> beat a single strong cheap model — it lost on both
    deterministic and open-ended tasks.
  </p>

  <p class="chart-title">Net win-rate vs. baseline (95% bootstrap CI)</p>
  ${chart}
  <p class="chart-caption">Dot = point estimate, bar = 95% CI. CI crossing 0% = statistical tie. Record format is win-tie-loss out of 48 tasks.</p>

  <table>
    <tr><th>Comparison</th><th>Net win-rate 95% CI</th><th>Record (W-T-L)</th><th>Verdict</th></tr>
    <tr><td>Review vs. cheap one-shot</td><td>+73% to +96%</td><td>42-1-5</td><td>Significant win</td></tr>
    <tr><td>Review vs. simple self-review</td><td>+60% to +88%</td><td>37-1-10</td><td>Significant win</td></tr>
    <tr><td>Review vs. premium one-shot (GPT-5.1)</td><td>&minus;4% to +27%</td><td>11-5-32</td><td>Statistical tie</td></tr>
    <tr><td>Cost (review vs. premium one-shot)</td><td colspan="3">0.66&times; — answer lengths comparable, not a verbosity artifact</td></tr>
  </table>

  <p class="limits">
    <b>What is and isn't claimed:</b> depth (adversarial review on one cheap model) reaches premium-quality parity at
    ~2/3 cost on hard tasks, and massively beats single-shot / simple self-review. It is <b>not</b> claimed that review
    beats premium (the CI crosses zero) &mdash; nor that multi-model fusion helps (it didn't) &mdash; nor that this holds on
    easy tasks (no headroom to show a difference) or across all future model generations.
  </p>

  <p class="footer">Method, every experimental round, and raw numbers: docs/EXPERIMENT_RESULTS.md and docs/PUBLICATION.md in the source repository.</p>
</body>
</html>
`;

  await writeFile(htmlPath, html, "utf8");
  await runChrome([
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ]);
  console.log(`Wrote ${pdfPath}`);
}

// ---- PNG: compact 1200x675 tweet card -------------------------------------

async function buildPng() {
  const htmlPath = join(workDir, "results-card.html");
  const pngPath = join(repoRoot, "docs", "results-card.png");
  const cardWidth = 1200;
  const cardHeight = 675;

  const chart = renderChart({
    chartWidth: 1080,
    chartHeight: 330,
    plotLeft: 330,
    plotRight: 960,
    plotTop: 10,
    plotBottom: 300,
    labelFontSize: 19,
    valueFontSize: 16,
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: ${cardWidth}px; height: ${cardHeight}px;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; background: #ffffff;
  }
  .card { width: ${cardWidth}px; height: ${cardHeight}px; padding: 44px 60px; }
  h1 { font-size: 34px; margin: 0 0 8px; }
  .subtitle { font-size: 17px; color: #555; margin: 0 0 22px; }
  .headline { font-size: 19px; line-height: 1.5; margin: 0 0 26px; max-width: 1080px; }
  .headline b { background: #fff4c2; padding: 0 3px; }
  .chart-caption { font-size: 14px; color: #777; margin: 8px 0 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>Depth beats breadth: cheap model + adversarial review</h1>
    <p class="subtitle">48 hard engineering tasks · 3-model blind judge panel · 95% bootstrap CI</p>
    <p class="headline">Cheap model + adversarial review reaches <b>premium (GPT-5.1) quality parity at 0.66&times; cost</b>, and crushes its own single-shot / self-review baselines.</p>
    ${chart}
    <p class="chart-caption">Net win-rate vs. baseline, 95% bootstrap CI. CI crossing 0% = statistical tie.</p>
  </div>
</body>
</html>
`;

  await writeFile(htmlPath, html, "utf8");
  await runChrome([
    "--headless",
    "--disable-gpu",
    `--window-size=${cardWidth},${cardHeight}`,
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ]);
  console.log(`Wrote ${pngPath}`);
}

await buildPdf();
await buildPng();
