#!/usr/bin/env node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const failures = [];
const expectedPackageScripts = {
  build: "tsc -p tsconfig.json",
  typecheck: "tsc -p tsconfig.json --noEmit",
  test: "vitest run",
  lint: "tsc -p tsconfig.json --noEmit",
  format: "prettier --write .",
  "format:check": "prettier --check .",
  "public-release:audit": "node scripts/public-release-audit.mjs",
  "public-release:secrets": "node scripts/public-secret-scan.mjs",
};

function fail(message) {
  failures.push(message);
}

function compactOutput(result) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
    .split("\n")
    .slice(-30)
    .join("\n");
}

function runCommand(command, args, description) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    fail(`${description} could not start: ${result.error.message}`);
    return result;
  }

  if (result.status !== 0) {
    const output = compactOutput(result);
    fail(
      `${description} failed with exit code ${result.status ?? "unknown"}${
        output ? `\n${output}` : ""
      }`,
    );
  }

  return result;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(repoRoot, relativePath), "utf8"));
}

function normalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(normalizeJson(value));
}

function parseNullList(stdout) {
  return stdout.split("\0").filter(Boolean);
}

function gitPathList(args, description) {
  const result = runCommand("git", args, description);
  if (result.status !== 0) return [];
  return args.includes("-z")
    ? parseNullList(result.stdout)
    : result.stdout.split("\n").filter(Boolean);
}

async function checkPackagePublicationGuard() {
  const packageJson = await readJson("package.json");
  if (packageJson.private !== true) {
    fail(
      'package.json must keep "private": true before publication is approved',
    );
  }
  if (Object.hasOwn(packageJson, "license")) {
    fail(
      "package.json must not add a license field before repository licensing is decided",
    );
  }

  const rootEntries = await readdir(repoRoot);
  const licenseEntry = rootEntries.find((entry) => /^LICENSE/i.test(entry));
  if (licenseEntry) {
    fail(`Root ${licenseEntry} exists before repository licensing is decided`);
  }

  for (const [scriptName, expectedCommand] of Object.entries(
    expectedPackageScripts,
  )) {
    if (packageJson.scripts?.[scriptName] !== expectedCommand) {
      fail(
        `package.json script ${scriptName} must remain ${JSON.stringify(
          expectedCommand,
        )}`,
      );
    }
  }

  for (const scriptName of Object.keys(packageJson.scripts ?? {})) {
    if (/^(?:pre|post)/.test(scriptName)) {
      fail(
        `package.json lifecycle script ${scriptName} is not allowed in the no-spend public audit path`,
      );
    }
  }
}

function gitPathIsIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "--quiet", path], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }

  const output = compactOutput(result);
  fail(
    `Check ignore status for ${path} failed with exit code ${
      result.status ?? "unknown"
    }${output ? `\n${output}` : ""}`,
  );
  return false;
}

function isPrivateEnvFileSegment(segment) {
  return (
    segment === ".env" ||
    segment === ".envrc" ||
    (segment.startsWith(".env.") && segment !== ".env.example")
  );
}

async function checkIgnoredLocalArtifacts() {
  const requiredIgnoredPaths = [
    [".frugal-fusion/audit-smoke.json", ".frugal-fusion local artifacts"],
    ["dist/audit-smoke.js", "dist build artifacts"],
    ["audit-smoke.log", "log files"],
    [".env", "root environment files"],
    [".env.local", "root local environment files"],
    [".envrc", "direnv environment files"],
    ["nested/.env.local", "nested local environment files"],
  ];

  for (const [path, label] of requiredIgnoredPaths) {
    if (!gitPathIsIgnored(path)) {
      fail(`.gitignore must ignore ${label} (${path})`);
    }
  }

  if (gitPathIsIgnored(".env.example")) {
    fail(
      ".gitignore must allow .env.example so sanitized templates can be tracked",
    );
  }

  const releaseCandidateFiles = [
    ...new Set([
      ...gitPathList(["ls-files", "-z"], "List tracked files"),
      ...gitPathList(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        "List untracked non-ignored files",
      ),
    ]),
  ];

  for (const file of releaseCandidateFiles) {
    if (file.startsWith(".frugal-fusion/")) {
      fail(
        `Release-candidate local artifact path is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
    if (file.startsWith("dist/")) {
      fail(
        `Release-candidate build artifact path is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
    if (file.split("/").some(isPrivateEnvFileSegment)) {
      fail(
        `Release-candidate environment file is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
    if (file.endsWith(".log")) {
      fail(
        `Release-candidate log file is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
  }
}

function normalizedPathToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function pathTokens(file) {
  return normalizedPathToken(file).split("-").filter(Boolean);
}

function hasTokenSequence(tokens, sequence) {
  if (sequence.length === 0 || tokens.length < sequence.length) return false;
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

function summarizeArtifactPath(file) {
  const parts = file.split("/");
  const basename = parts.at(-1) ?? file;
  if (parts.length <= 2) return file;
  return `${parts[0]}/.../${basename}`;
}

function checkPublicArtifactPathHygiene() {
  const releaseCandidateFiles = [
    ...new Set([
      ...gitPathList(["ls-files", "-z"], "List tracked files"),
      ...gitPathList(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        "List untracked non-ignored files",
      ),
    ]),
  ];
  const allowedJsonlFiles = new Set([
    "examples/cases.jsonl",
    "examples/cases.public.jsonl",
    "examples/cases.smoke.jsonl",
    "examples/cases.experiment.jsonl",
    "examples/cases.candidates.jsonl",
    "examples/cases.longform.jsonl",
  ]);
  const allowedManifestFiles = new Set(["examples/cases.public.manifest.json"]);
  const forbiddenPathTokens = [
    "private-holdout",
    "holdout",
    "private-report",
    "eval-result",
    "eval-public",
    "eval-preflight",
    "model-snapshot",
    "models.json",
    "run-provenance",
    "price-snapshot",
    "provider-routing",
    "provider-slug",
    "raw-prompt",
    "raw-answer",
  ];

  for (const file of releaseCandidateFiles) {
    const lowerFile = file.toLowerCase();
    const tokens = pathTokens(file);
    const basename = file.split("/").at(-1)?.toLowerCase() ?? lowerFile;
    if (lowerFile.endsWith(".jsonl") && !allowedJsonlFiles.has(file)) {
      fail(
        `Unapproved JSONL case-set artifact path is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
    if (
      lowerFile.endsWith(".manifest.json") &&
      !allowedManifestFiles.has(file)
    ) {
      fail(
        `Unapproved manifest artifact path is not allowed: ${summarizeArtifactPath(
          file,
        )}`,
      );
    }
    for (const token of forbiddenPathTokens) {
      if (
        (token === "models.json" && basename === token) ||
        hasTokenSequence(tokens, token.split("-"))
      ) {
        fail(
          `Private or generated artifact-like path is not allowed: ${summarizeArtifactPath(
            file,
          )}`,
        );
        break;
      }
    }
  }
}

async function checkPublicManifest() {
  const checkedInManifest = await readJson(
    "examples/cases.public.manifest.json",
  );
  if (checkedInManifest.intendedUse !== "public_sample") {
    fail(
      'examples/cases.public.manifest.json must keep intendedUse: "public_sample"',
    );
  }
  if (checkedInManifest.claimReadiness?.status !== "not_claim_ready") {
    fail(
      'examples/cases.public.manifest.json must keep claimReadiness.status: "not_claim_ready"',
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "frugal-fusion-public-audit-"));
  const generatedManifestPath = join(tempDir, "cases.public.manifest.json");
  try {
    const manifestResult = runCommand(
      "pnpm",
      [
        "tsx",
        "src/cli.ts",
        "validate-cases",
        "examples/cases.public.jsonl",
        "--manifest-out",
        generatedManifestPath,
        "--intended-use",
        "public_sample",
        "--source-label",
        "examples/cases.public.jsonl",
        "--public-category-labels",
        "--public-case-ids",
      ],
      "Regenerate public sample manifest",
    );

    if (manifestResult.status !== 0) {
      return;
    }

    const generatedManifest = JSON.parse(
      await readFile(generatedManifestPath, "utf8"),
    );
    if (stableJson(generatedManifest) !== stableJson(checkedInManifest)) {
      fail(
        "examples/cases.public.manifest.json is stale; regenerate it from examples/cases.public.jsonl",
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkNoSpendWorkflowGuard() {
  const workflowPath = ".github/workflows/no-spend-ci.yml";
  const workflow = await readFile(join(repoRoot, workflowPath), "utf8");
  const permissionsMatch = workflow.match(/^permissions:\n((?:  .*\n?)*)/m);
  const permissionLines =
    permissionsMatch?.[1]
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean) ?? [];
  if (permissionLines.length !== 1 || permissionLines[0] !== "contents: read") {
    fail(
      `${workflowPath} must declare top-level read-only contents permission`,
    );
  }
  if (/^\s{2,}permissions:\s*$/m.test(workflow)) {
    fail(`${workflowPath} must not declare job-level permission overrides`);
  }

  const forbiddenPatterns = [
    ["OpenRouter API key", /OPENROUTER_API_KEY/],
    ["manifest HMAC key", /FRUGAL_FUSION_MANIFEST_HMAC_KEY/],
    ["GitHub secrets context", /secrets\./],
    [
      "live eval command",
      /(?:pnpm(?:\s+[^\s]+)*\s+(?:exec\s+)?tsx|node)\s+\.?\/?(?:src\/cli\.ts|dist\/src\/cli\.js)\s+eval\b/,
    ],
    [
      "models command",
      /(?:pnpm(?:\s+[^\s]+)*\s+(?:exec\s+)?tsx|node)\s+\.?\/?(?:src\/cli\.ts|dist\/src\/cli\.js)\s+models\b/,
    ],
    [
      "ask command",
      /(?:pnpm(?:\s+[^\s]+)*\s+(?:exec\s+)?tsx|node)\s+\.?\/?(?:src\/cli\.ts|dist\/src\/cli\.js)\s+ask\b/,
    ],
    ["package binary eval command", /\bfrugal-fusion\s+eval\b/],
    ["package binary models command", /\bfrugal-fusion\s+models\b/],
    ["package binary ask command", /\bfrugal-fusion\s+ask\b/],
    ["artifact upload action", /upload-artifact/],
    ["npm publish", /\bnpm(?:\s+[^\s]+)*\s+publish\b/],
    ["pnpm publish", /\bpnpm(?:\s+[^\s]+)*\s+publish\b/],
    ["GitHub release command", /\bgh\s+release\b/],
    [
      "release action",
      /(?:actions\/create-release|softprops\/action-gh-release)/,
    ],
    ["write-all permission", /\bwrite-all\b/],
    ["inline write permission", /permissions:\s*\{[^}]*:\s*write\b/],
    ["write permission", /^\s*[a-z-]+:\s*write\s*(?:#.*)?$/m],
    ["private holdout path", /private-holdout/],
    ["private validation flag", /--private\b/],
    ["case manifest binding", /--case-manifest\b/],
    ["HMAC manifest option", /--manifest-hmac-key-env\b/],
  ];

  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(workflow)) {
      fail(
        `${workflowPath} must stay no-spend and public-safe; found ${label}`,
      );
    }
  }
}

await checkPackagePublicationGuard();
await checkIgnoredLocalArtifacts();
checkPublicArtifactPathHygiene();
await checkPublicManifest();
await checkNoSpendWorkflowGuard();

if (failures.length > 0) {
  console.error("Public release audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Public release audit passed.");
