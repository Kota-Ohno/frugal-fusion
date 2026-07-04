#!/usr/bin/env node
// One-off generator for docs/results-card-r7-{ja,en}.png — the Round 7
// (sample-select-polish) tweet card. Same visual language as
// gen-results-summary.mjs: hero stat + verdict-pill rows, numbers from
// docs/EXPERIMENT_RESULTS.md Round 7.
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const chromeBin =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workDir = await mkdtemp(join(tmpdir(), "frugal-fusion-r7-card-"));

const COLOR_WIN = "#0f7b4a";
const COLOR_WIN_BG = "#e6f4ec";
const COLOR_TIE = "#a06a00";
const COLOR_TIE_BG = "#fdf1de";
const COLOR_LOSS = "#a33030";
const COLOR_LOSS_BG = "#fbe9e9";

const COPY = {
  ja: {
    eyebrow:
      "FRUGAL FUSION 実験 ROUND 7 — 難しいエンジニアリングタスク48件・3モデル判定パネル",
    heroNumber: "0.58×",
    heroText: "のコストで、従来の敵対的レビューループと同品質",
    heroSub:
      "「2周の直列レビュー」を「6視点の並列下書き → トーナメント選抜 → レビュー1回」に置き換えて比較しました。",
    rows: [
      {
        kind: "tie",
        verdict: "同等",
        label: "並列選抜+レビュー1回 vs 従来ループ(品質)",
        value: "±0%",
        detail: "だいたい-15〜+13%(誤差の範囲)  ·  48件中37件が引き分け",
      },
      {
        kind: "loss",
        verdict: "大敗",
        label: "レビューを抜いた対照版 vs 従来ループ",
        value: "-52%",
        detail: "だいたい-67〜-33%(1勝26敗) — 敵対的レビュー1回が品質の担い手",
      },
      {
        kind: "tie",
        verdict: "注意",
        label: "実行時間",
        value: "0.95×",
        detail: "速くはならない(推論系モデルは1コール自体が遅いため)",
      },
    ],
    footer: "手法・skill・全実験ログ: github.com/Kota-Ohno/frugal-fusion",
  },
  en: {
    eyebrow:
      "FRUGAL FUSION EXPERIMENT ROUND 7 — 48 hard engineering tasks, 3-judge blind panel",
    heroNumber: "0.58×",
    heroText: "the cost of the serial adversarial-review loop — same quality",
    heroSub:
      "Replaced 2 serial review rounds with: 6 stance-diverse parallel drafts → knockout tournament → ONE review round.",
    rows: [
      {
        kind: "tie",
        verdict: "TIE",
        label: "sample-select-polish vs. the review loop (quality)",
        value: "±0%",
        detail: "usually -15…+13% (within noise)  ·  37 of 48 tasks tied",
      },
      {
        kind: "loss",
        verdict: "LOSS",
        label: "ablation without the review round vs. the loop",
        value: "-52%",
        detail:
          "usually -67…-33% (1W-26L) — the single adversarial review round carries the quality",
      },
      {
        kind: "tie",
        verdict: "NOTE",
        label: "wall-clock time",
        value: "0.95×",
        detail: "not faster (reasoning-heavy models are slow per call)",
      },
    ],
    footer: "Method, skill & full logs: github.com/Kota-Ohno/frugal-fusion",
  },
};

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pillColors(kind) {
  if (kind === "win") return { fg: COLOR_WIN, bg: COLOR_WIN_BG };
  if (kind === "loss") return { fg: COLOR_LOSS, bg: COLOR_LOSS_BG };
  return { fg: COLOR_TIE, bg: COLOR_TIE_BG };
}

async function runChrome(args) {
  const result = spawnSync(chromeBin, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    process.exit(1);
  }
}

async function buildPng(locale) {
  const c = COPY[locale];
  const htmlPath = join(workDir, `results-card-r7-${locale}.html`);
  const pngPath = join(repoRoot, "docs", `results-card-r7-${locale}.png`);
  const cardWidth = 1200;
  const cardHeight = 675;

  const rows = c.rows
    .map((row) => {
      const { fg, bg } = pillColors(row.kind);
      return `
        <div class="row">
          <span class="pill" style="background:${bg}; color:${fg};">${escapeHtml(row.verdict)}</span>
          <span class="row-label">${escapeHtml(row.label)}</span>
          <span class="row-value" style="color:${fg};">${escapeHtml(row.value)}</span>
          <div class="row-detail">${escapeHtml(row.detail)}</div>
        </div>
      `;
    })
    .join("");

  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: ${cardWidth}px; height: ${cardHeight}px;
    font-family: -apple-system, "Hiragino Sans", "Helvetica Neue", Arial, sans-serif; color: #111; background: #ffffff;
  }
  .card { width: ${cardWidth}px; height: ${cardHeight}px; padding: 46px 64px; }
  .eyebrow { font-size: 14px; letter-spacing: 0.04em; color: #777; text-transform: uppercase; margin: 0 0 14px; }
  .hero { display: flex; align-items: baseline; gap: 20px; margin: 0 0 10px; }
  .hero-number { font-size: 92px; font-weight: 800; color: ${COLOR_WIN}; line-height: 1; }
  .hero-text { font-size: 25px; font-weight: 600; max-width: 640px; line-height: 1.35; }
  .hero-sub { font-size: 15px; color: #555; line-height: 1.5; margin: 0 0 28px; max-width: 1040px; }
  .row { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; column-gap: 18px; margin-bottom: 20px; }
  .pill { font-weight: 700; letter-spacing: 0.03em; padding: 5px 0; border-radius: 7px; text-align: center; font-size: 15px; }
  .row-label { font-weight: 600; color: #222; font-size: 18px; }
  .row-value { font-weight: 800; text-align: right; font-size: 28px; }
  .row-detail { grid-column: 2 / 4; color: #888; margin-top: 3px; font-size: 14px; }
  .card-footer { font-size: 13px; color: #999; margin-top: 20px; }
</style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">${escapeHtml(c.eyebrow)}</p>
    <div class="hero">
      <span class="hero-number">${escapeHtml(c.heroNumber)}</span>
      <span class="hero-text">${escapeHtml(c.heroText)}</span>
    </div>
    <p class="hero-sub">${escapeHtml(c.heroSub)}</p>
    ${rows}
    <p class="card-footer">${escapeHtml(c.footer)}</p>
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

for (const locale of ["ja", "en"]) {
  await buildPng(locale);
}
