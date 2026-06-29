import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const createdRepos: string[] = [];
const auditSource = join(process.cwd(), "scripts/public-release-audit.mjs");

const packageJson = {
  private: true,
  scripts: {
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run",
    lint: "tsc -p tsconfig.json --noEmit",
    format: "prettier --write .",
    "format:check": "prettier --check .",
    "public-release:audit": "node scripts/public-release-audit.mjs",
    "public-release:secrets": "node scripts/public-secret-scan.mjs",
  },
};

const publicManifest = {
  schemaVersion: "frugal-fusion-case-set-manifest-v4",
  intendedUse: "public_sample",
  claimReadiness: { status: "not_claim_ready" },
};

const workflow = `name: No-spend CI

"on":
  pull_request:
  push:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  no-spend:
    runs-on: ubuntu-24.04
    steps:
      - name: Check out repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
          persist-credentials: false
`;

function run(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function writeFile(repo: string, path: string, content: string) {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function createFakePnpm(repo: string) {
  const binDir = join(repo, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/usr/bin/env node
const { copyFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const index = args.indexOf("--manifest-out");
if (index >= 0 && args[index + 1]) {
  copyFileSync(join(process.cwd(), "examples/cases.public.manifest.json"), args[index + 1]);
  process.exit(0);
}
console.error("unexpected pnpm call", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 },
  );
  return binDir;
}

function createRepo() {
  const repo = join(
    tmpdir(),
    `frugal-fusion-release-audit-test-${process.pid}-${createdRepos.length}`,
  );
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(auditSource, join(repo, "scripts/public-release-audit.mjs"));
  writeFile(repo, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFile(
    repo,
    ".gitignore",
    "node_modules/\ndist/\n.frugal-fusion/\n*.log\n.env\n.env.*\n.envrc\n!.env.example\n",
  );
  writeFile(repo, ".github/workflows/no-spend-ci.yml", workflow);
  writeFile(repo, "examples/cases.public.jsonl", "{}\n");
  writeFile(
    repo,
    "examples/cases.public.manifest.json",
    `${JSON.stringify(publicManifest)}\n`,
  );
  writeFile(repo, "examples/cases.jsonl", "{}\n");
  writeFile(
    repo,
    "README.md",
    "private-holdout.jsonl appears here only as documentation.\n",
  );
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "test@example.invalid"], repo);
  run("git", ["config", "user.name", "Frugal Fusion Test"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "base"], repo);
  createdRepos.push(repo);
  return { repo, binDir: createFakePnpm(repo) };
}

function audit(repo: string, binDir: string) {
  return spawnSync("node", ["scripts/public-release-audit.mjs"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
}

afterEach(() => {
  for (const repo of createdRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("public release audit path hygiene", () => {
  it("allows the checked-in public examples and documentation references", () => {
    const { repo, binDir } = createRepo();

    const result = audit(repo, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public release audit passed");
  });

  it("blocks private holdout paths even when untracked but non-ignored", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "private-holdout.jsonl", "{}\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private-holdout.jsonl");
  });

  it("summarizes nested private artifact paths in failure output", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "internal/customer-alpha/private-holdout.jsonl", "{}\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("internal/.../private-holdout.jsonl");
    expect(result.stderr).not.toContain("customer-alpha");
  });

  it("summarizes nested local artifact paths in failure output", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, ".frugal-fusion/customer-alpha/eval-result.json", "{}\n");
    run(
      "git",
      ["add", "-f", ".frugal-fusion/customer-alpha/eval-result.json"],
      repo,
    );

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".frugal-fusion/.../eval-result.json");
    expect(result.stderr).not.toContain("customer-alpha");
  });

  it("blocks generated model snapshot and private report paths", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "models.json", "{}\n");
    writeFile(repo, "eval-result.json", "{}\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("models.json");
    expect(result.stderr).toContain("eval-result.json");
  });

  it("blocks uppercase JSONL and manifest artifact extensions", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "customer-cases.JSONL", "{}\n");
    writeFile(repo, "examples/private.MANIFEST.JSON", "{}\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer-cases.JSONL");
    expect(result.stderr).toContain("examples/private.MANIFEST.JSON");
  });

  it("blocks extra manifest artifacts outside the public sample manifest", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "examples/private.manifest.json", "{}\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("examples/private.manifest.json");
  });

  it("blocks private artifact paths under docs and tests", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "tests/fixtures/private-holdout.jsonl", "{}\n");
    writeFile(repo, "docs/private-report.md", "private report fixture\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/.../private-holdout.jsonl");
    expect(result.stderr).toContain("docs/private-report.md");
  });

  it("does not confuse source camelCase names with generated artifacts", () => {
    const { repo, binDir } = createRepo();
    writeFile(repo, "src/evalPreflight.ts", "export const ok = true;\n");

    const result = audit(repo, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public release audit passed");
  });
});
