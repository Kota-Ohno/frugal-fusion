#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const maxContextLength = 160;
const findings = [];
let scannedHistoryRevisionCount = 0;

const historyGrepPattern = [
  "sk-or-v1-[A-Za-z0-9_-]{24,}",
  "Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{24,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  "gh[pousr]_[A-Za-z0-9]{32,}",
  "sk-proj-[A-Za-z0-9_-]{20,}",
  "sk-[A-Za-z0-9]{40,}",
  "-----BEGIN (RSA |EC |OPENSSH |DSA |PRIVATE )?PRIVATE KEY-----",
  "(OPENROUTER_API_KEY|FRUGAL_FUSION_MANIFEST_HMAC_KEY)[\"']?[[:space:]]*[:=]",
].join("|");

function runGit(args, description, options = {}) {
  const { allowNoMatches = false, includeFailureOutput = true } = options;
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (allowNoMatches && result.status === 1) {
    return result;
  }

  if (result.error || result.status !== 0) {
    const output = includeFailureOutput
      ? [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n")
          .trim()
          .split("\n")
          .slice(-20)
          .join("\n")
      : "";
    throw new Error(
      `${description} failed${
        result.status === null ? "" : ` with exit code ${result.status}`
      }${result.error ? `: ${result.error.message}` : ""}${
        output ? `\n${output}` : ""
      }`,
    );
  }

  return result;
}

function redact(value) {
  if (value.length <= 12) return "[REDACTED]";
  return `${value.slice(0, 6)}...[REDACTED]...${value.slice(-4)}`;
}

function resolveSpans(spans) {
  const resolved = [];
  for (const span of [...spans].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return right.end - left.end;
  })) {
    const previous = resolved.at(-1);
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.redaction = "[REDACTED]";
      continue;
    }
    resolved.push({ ...span });
  }
  return resolved;
}

function sanitizeWithSpans(text, spans) {
  const resolved = resolveSpans(spans);
  let sanitized = "";
  let cursor = 0;
  for (const span of resolved) {
    sanitized += text.slice(cursor, span.start);
    sanitized += span.redaction;
    cursor = span.end;
  }
  sanitized += text.slice(cursor);
  return sanitized.length <= maxContextLength
    ? sanitized
    : `${sanitized.slice(0, maxContextLength - 3)}...`;
}

function isPlaceholderValue(rawValue) {
  const value = rawValue.trim().replace(/^["']|["']$/g, "");
  return (
    value === "" ||
    value === "..." ||
    value === "[REDACTED]" ||
    value === "REDACTED" ||
    value === "example" ||
    value === "placeholder" ||
    value.startsWith("<") ||
    value.startsWith("${") ||
    value.startsWith("$(") ||
    value.startsWith("$") ||
    value.startsWith("process.env.") ||
    value.startsWith("original")
  );
}

function hasEnoughEntropy(value) {
  const uniqueChars = new Set(value).size;
  const hasLetters = /[A-Za-z]/.test(value);
  const hasNumbers = /\d/.test(value);
  return value.length >= 20 && uniqueChars >= 10 && hasLetters && hasNumbers;
}

function hasSecretLikeValue(value) {
  const uniqueChars = new Set(value).size;
  return value.length >= 24 && uniqueChars >= 10 && !/^[A-Za-z]+$/.test(value);
}

const detectors = [
  {
    id: "openrouter_api_key",
    regex: /sk-or-v1-[A-Za-z0-9_-]{24,}/g,
    shouldReport: () => true,
    redact: (args) => redact(args[0]),
  },
  {
    id: "concrete_bearer_token",
    regex: /Bearer\s+([A-Za-z0-9._~+/=-]{24,})/gi,
    shouldReport: (args) => hasEnoughEntropy(args[1]),
    redact: (args) => `Bearer ${redact(args[1])}`,
  },
  {
    id: "github_token",
    regex: /\b(?:github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{32,})\b/g,
    shouldReport: () => true,
    redact: (args) => redact(args[0]),
  },
  {
    id: "openai_style_api_key",
    regex: /\b(?:sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,})\b/g,
    shouldReport: (args) => !args[0].startsWith("sk-or-v1-"),
    redact: (args) => redact(args[0]),
  },
  {
    id: "private_key_header",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PRIVATE )?PRIVATE KEY-----/g,
    shouldReport: () => true,
    redact: () => "-----BEGIN [REDACTED] PRIVATE KEY-----",
  },
  {
    id: "concrete_eval_secret_env",
    regex:
      /["']?\b(OPENROUTER_API_KEY|FRUGAL_FUSION_MANIFEST_HMAC_KEY)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/g,
    shouldReport: (args) => {
      const rawValue = args[2];
      const value = rawValue.trim().replace(/^["']|["']$/g, "");
      return !isPlaceholderValue(rawValue) && hasSecretLikeValue(value);
    },
    redact: (args) => `${args[1]}=${redact(args[2])}`,
  },
];

function collectReportableSpans(text) {
  const spans = [];
  for (const detector of detectors) {
    detector.regex.lastIndex = 0;
    let match;
    while ((match = detector.regex.exec(text)) !== null) {
      if (detector.shouldReport(match)) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          detectorId: detector.id,
          redaction: detector.redact(match),
        });
      }
      if (match[0].length === 0) detector.regex.lastIndex += 1;
    }
  }
  return spans;
}

function sanitizedLocation(location) {
  return sanitizeWithSpans(location, collectReportableSpans(location));
}

function addFinding(location, detectorId, context) {
  findings.push({
    location: sanitizedLocation(location),
    detectorId,
    context,
  });
}

function scanLine(line, location) {
  const spans = collectReportableSpans(line);
  if (spans.length === 0) return;
  const context = sanitizeWithSpans(line, spans);
  for (const detectorId of new Set(spans.map((span) => span.detectorId))) {
    addFinding(location, detectorId, context);
  }
}

function scanText(text, locationPrefix) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    scanLine(lines[index], `${locationPrefix}:${index + 1}`);
  }
}

function parseNullList(stdout) {
  return stdout.split("\0").filter(Boolean);
}

function shouldSkipFileContent(buffer) {
  return buffer.includes(0);
}

async function scanCurrentFiles() {
  const tracked = parseNullList(
    runGit(["ls-files", "-z"], "List tracked files").stdout,
  );
  const untracked = parseNullList(
    runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      "List untracked non-ignored files",
    ).stdout,
  );

  const files = [...new Set([...tracked, ...untracked])];
  for (const file of files) {
    scanLine(file, `worktree-path:${file}`);
    const path = join(repoRoot, file);
    const buffer = await readFile(path);
    if (shouldSkipFileContent(buffer)) continue;
    scanText(buffer.toString("utf8"), `worktree:${file}`);
  }
}

function parseGitGrepRecords(stdout, rev) {
  const records = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    const pathEnd = stdout.indexOf("\0", cursor);
    if (pathEnd < 0) break;
    const rawPath = stdout.slice(cursor, pathEnd);
    const lineEnd = stdout.indexOf("\0", pathEnd + 1);
    if (lineEnd < 0) break;
    const lineNumber = stdout.slice(pathEnd + 1, lineEnd);
    const contentEnd = stdout.indexOf("\n", lineEnd + 1);
    const end = contentEnd < 0 ? stdout.length : contentEnd;
    const content = stdout.slice(lineEnd + 1, end);
    const revPrefix = `${rev}:`;
    const path = rawPath.startsWith(revPrefix)
      ? rawPath.slice(revPrefix.length)
      : rawPath;
    records.push({ rev, path, lineNumber, content });
    cursor = contentEnd < 0 ? stdout.length : contentEnd + 1;
  }
  return records;
}

function scanHistory() {
  const revisions = runGit(["rev-list", "--all"], "List commit history")
    .stdout.split("\n")
    .filter(Boolean);
  scannedHistoryRevisionCount = revisions.length;

  for (const rev of revisions) {
    const grepResult = runGit(
      ["grep", "--null", "-nI", "-E", historyGrepPattern, rev, "--", "."],
      `Scan commit ${rev.slice(0, 12)}`,
      { allowNoMatches: true, includeFailureOutput: false },
    );
    if (grepResult.status === 1) continue;

    for (const parsed of parseGitGrepRecords(grepResult.stdout, rev)) {
      scanLine(
        parsed.path,
        `history-path:${parsed.rev.slice(0, 12)}:${parsed.path}`,
      );
      scanLine(
        parsed.content,
        `history:${parsed.rev.slice(0, 12)}:${parsed.path}:${parsed.lineNumber}`,
      );
    }
  }
}

async function main() {
  await scanCurrentFiles();
  scanHistory();

  const uniqueFindings = [
    ...new Map(
      findings.map((finding) => [
        `${finding.location}\0${finding.detectorId}\0${finding.context}`,
        finding,
      ]),
    ).values(),
  ];

  if (uniqueFindings.length > 0) {
    console.error("Public secret scan failed:");
    for (const finding of uniqueFindings) {
      console.error(
        `- ${finding.location} [${finding.detectorId}] ${finding.context}`,
      );
    }
    process.exit(1);
  }

  console.log(
    [
      "Public secret scan passed:",
      "no high-confidence credentials found in the worktree",
      `or ${scannedHistoryRevisionCount} reachable local history revision(s).`,
    ].join(" "),
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `Public secret scan could not complete: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}
