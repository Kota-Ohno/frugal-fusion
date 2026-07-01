#!/usr/bin/env node
// One-off generator for docs/results-summary-{en,ja}.pdf and
// docs/results-card-{en,ja}.png (not part of the public-release claim-gate
// pipeline — a plain visual summary of already-published numbers in
// docs/PUBLICATION.md / docs/EXPERIMENT_RESULTS.md).
//
// Design: instead of a CI-axis chart (reads well to a stats-literate
// audience, poorly to a general one), each comparison is a single row —
// a colored WIN/TIE pill, a big point-estimate number, and the CI + W-T-L
// record as small supporting text. The hero stat (0.66x cost at parity)
// gets its own oversized callout, since it's the one number the whole
// finding hinges on.
//
// pdf = full one-pager, linked from the tweet thread
// png = compact 1200x675 landscape card, attached directly to the tweet
//       (X does not accept PDF as tweet media)
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

const COLOR_WIN = "#0f7b4a";
const COLOR_WIN_BG = "#e6f4ec";
const COLOR_TIE = "#a06a00";
const COLOR_TIE_BG = "#fdf1de";

const COPY = {
  en: {
    eyebrow:
      "FRUGAL FUSION EXPERIMENT — 48 hard engineering tasks, 3-judge blind panel",
    title: "Depth beats breadth: cheap model + adversarial review",
    heroNumber: "0.66×",
    heroText: "the cost of a premium model — for the same quality",
    heroSub:
      "A cheap model (qwen3-235b) run through an adversarial multi-perspective review loop, judged against GPT-5.1's one-shot answer.",
    rows: [
      {
        verdict: "WIN",
        label: "vs. its own one-shot answer",
        value: "+85%",
        detail: "usually +73…+96%  ·  record 42W–5T–1L",
      },
      {
        verdict: "WIN",
        label: "vs. simple self-review",
        value: "+74%",
        detail: "usually +60…+88%  ·  record 37W–10T–1L",
      },
      {
        verdict: "TIE",
        label: "vs. premium model (GPT-5.1)",
        value: "+12%",
        detail:
          "range −4…+27% — essentially even, could be a slight loss  ·  record 11W–32T–5L",
      },
    ],
    legend:
      "Ranges reflect measurement uncertainty across 48 tasks, judged blind by a 3-model panel (order-counterbalanced).",
    claimsTitle: "What is and isn't claimed",
    claims:
      "Adversarial review on one cheap model reaches premium-quality parity at ~2/3 cost on hard tasks, and massively beats single-shot / simple self-review. It is <b>not</b> claimed that review beats premium (the range includes a small loss) — nor that multi-model ensembles help (a separate test found they didn't) — nor that this holds on easy tasks (no headroom to show a difference) or across all future model generations.",
    footer:
      "Method, every experimental round, and raw numbers: docs/EXPERIMENT_RESULTS.md and docs/PUBLICATION.md — github.com/Kota-Ohno/frugal-fusion",
    cardFooter: "Full method & data: github.com/Kota-Ohno/frugal-fusion",
  },
  ja: {
    eyebrow:
      "FRUGAL FUSION 実験 — 難しいエンジニアリングタスク48件・3モデル判定パネル",
    title: "幅より深さ: 安いモデル + 敵対的レビュー",
    heroNumber: "0.66×",
    heroText: "のコストで、プレミアムモデルと同等品質に到達",
    heroSub:
      "安いモデル(qwen3-235b)に多角的な敵対的レビューループを適用し、GPT-5.1の一発回答と比較しました。",
    rows: [
      {
        verdict: "勝利",
        label: "自分自身の一発回答比",
        value: "+85%",
        detail: "だいたい+73〜96%  ·  成績 42勝–5引–1敗",
      },
      {
        verdict: "勝利",
        label: "単純なself-review比",
        value: "+74%",
        detail: "だいたい+60〜88%  ·  成績 37勝–10引–1敗",
      },
      {
        verdict: "引き分け",
        label: "プレミアムモデル(GPT-5.1)比",
        value: "+12%",
        detail:
          "幅は-4〜+27% — ほぼ互角、僅差で負けの可能性も残る  ·  成績 11勝–32引–5敗",
      },
    ],
    legend:
      "数値の幅は48タスクでの測定のブレを表す。ブラインド・順序入替の3モデル判定パネルによる。",
    claimsTitle: "主張していること・いないこと",
    claims:
      "1つの安いモデルに敵対的レビューを適用すれば、難しいタスクで約²⁄₃のコストでプレミアムモデルと同等の品質に到達し、単純な一発回答・セルフレビューを圧倒する。<b>しかし</b>「プレミアムに勝つ」とは主張していない(数値の幅にわずかな負けも含まれる) — 複数モデルのアンサンブルが効くとも主張していない(別途検証で効かないことが判明) — これが簡単なタスクや、今後の全モデル世代でも成立するともいえない(簡単タスクでは差を示す余地がない)。",
    footer:
      "手法・全ラウンドの記録・生データ: docs/EXPERIMENT_RESULTS.md 、docs/PUBLICATION.md — github.com/Kota-Ohno/frugal-fusion",
    cardFooter: "全手法・データ: github.com/Kota-Ohno/frugal-fusion",
  },
};

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rowsHtml(
  rows,
  { pillFontSize, labelFontSize, valueFontSize, detailFontSize, rowGap },
) {
  return rows
    .map((row) => {
      const isWin = row.verdict === "WIN" || row.verdict === "勝利";
      const pillColor = isWin ? COLOR_WIN : COLOR_TIE;
      const pillBg = isWin ? COLOR_WIN_BG : COLOR_TIE_BG;
      return `
        <div class="row" style="margin-bottom:${rowGap}px;">
          <span class="pill" style="background:${pillBg}; color:${pillColor}; font-size:${pillFontSize}px;">${escapeHtml(row.verdict)}</span>
          <span class="row-label" style="font-size:${labelFontSize}px;">${escapeHtml(row.label)}</span>
          <span class="row-value" style="font-size:${valueFontSize}px; color:${pillColor};">${escapeHtml(row.value)}</span>
          <div class="row-detail" style="font-size:${detailFontSize}px;">${escapeHtml(row.detail)}</div>
        </div>
      `;
    })
    .join("");
}

async function runChrome(args) {
  const result = spawnSync(chromeBin, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    process.exit(1);
  }
}

// ---- PDF: full one-pager --------------------------------------------------

async function buildPdf(locale) {
  const c = COPY[locale];
  const htmlPath = join(workDir, `results-summary-${locale}.html`);
  const pdfPath = join(repoRoot, "docs", `results-summary-${locale}.pdf`);

  const rows = rowsHtml(c.rows, {
    pillFontSize: 12,
    labelFontSize: 14,
    valueFontSize: 22,
    detailFontSize: 11,
    rowGap: 16,
  });

  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 26mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Hiragino Sans", "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; padding: 0; }
  .eyebrow { font-size: 11px; letter-spacing: 0.04em; color: #777; text-transform: uppercase; margin: 0 0 8px; }
  h1 { font-size: 23px; margin: 0 0 20px; line-height: 1.3; }
  .hero { display: flex; align-items: baseline; gap: 14px; margin: 0 0 8px; }
  .hero-number { font-size: 56px; font-weight: 800; color: ${COLOR_WIN}; line-height: 1; }
  .hero-text { font-size: 17px; font-weight: 600; }
  .hero-sub { font-size: 12.5px; color: #555; line-height: 1.5; margin: 0 0 28px; max-width: 480px; }
  .rows { margin: 0 0 22px; }
  .row { display: grid; grid-template-columns: 62px 1fr auto; align-items: center; column-gap: 12px; }
  .pill { font-weight: 700; letter-spacing: 0.03em; padding: 3px 0; border-radius: 5px; text-align: center; }
  .row-label { font-weight: 600; color: #222; }
  .row-value { font-weight: 800; text-align: right; }
  .row-detail { grid-column: 2 / 4; color: #777; margin-top: 2px; }
  .legend { font-size: 11px; color: #999; margin: 0 0 26px; }
  .claims-title { font-size: 12.5px; font-weight: 700; margin: 0 0 6px; }
  .claims { font-size: 11.5px; color: #444; line-height: 1.55; border-top: 1px solid #ddd; padding-top: 12px; max-width: 560px; }
  .footer { font-size: 10px; color: #999; margin-top: 20px; }
</style>
</head>
<body>
  <p class="eyebrow">${escapeHtml(c.eyebrow)}</p>
  <h1>${escapeHtml(c.title)}</h1>

  <div class="hero">
    <span class="hero-number">${escapeHtml(c.heroNumber)}</span>
    <span class="hero-text">${escapeHtml(c.heroText)}</span>
  </div>
  <p class="hero-sub">${escapeHtml(c.heroSub)}</p>

  <div class="rows">${rows}</div>
  <p class="legend">${escapeHtml(c.legend)}</p>

  <p class="claims-title">${escapeHtml(c.claimsTitle)}</p>
  <p class="claims">${c.claims}</p>

  <p class="footer">${escapeHtml(c.footer)}</p>
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

async function buildPng(locale) {
  const c = COPY[locale];
  const htmlPath = join(workDir, `results-card-${locale}.html`);
  const pngPath = join(repoRoot, "docs", `results-card-${locale}.png`);
  const cardWidth = 1200;
  const cardHeight = 675;

  const rows = rowsHtml(c.rows, {
    pillFontSize: 15,
    labelFontSize: 19,
    valueFontSize: 30,
    detailFontSize: 14,
    rowGap: 20,
  });

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
  .card { width: ${cardWidth}px; height: ${cardHeight}px; padding: 48px 64px; }
  .eyebrow { font-size: 14px; letter-spacing: 0.04em; color: #777; text-transform: uppercase; margin: 0 0 14px; }
  .hero { display: flex; align-items: baseline; gap: 20px; margin: 0 0 10px; }
  .hero-number { font-size: 96px; font-weight: 800; color: ${COLOR_WIN}; line-height: 1; }
  .hero-text { font-size: 26px; font-weight: 600; max-width: 560px; line-height: 1.3; }
  .hero-sub { font-size: 15px; color: #555; line-height: 1.5; margin: 0 0 30px; max-width: 1040px; }
  .rows { }
  .row { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; column-gap: 18px; }
  .pill { font-weight: 700; letter-spacing: 0.03em; padding: 5px 0; border-radius: 7px; text-align: center; }
  .row-label { font-weight: 600; color: #222; }
  .row-value { font-weight: 800; text-align: right; }
  .row-detail { grid-column: 2 / 4; color: #888; margin-top: 3px; }
  .card-footer { font-size: 13px; color: #999; margin-top: 22px; }
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
    <div class="rows">${rows}</div>
    <p class="card-footer">${escapeHtml(c.cardFooter)}</p>
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

for (const locale of ["en", "ja"]) {
  await buildPdf(locale);
  await buildPng(locale);
}
