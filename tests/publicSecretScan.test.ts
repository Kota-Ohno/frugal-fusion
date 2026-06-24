import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const createdRepos: string[] = [];
const scannerSource = join(process.cwd(), "scripts/public-secret-scan.mjs");

function fakeOpenRouterKey(suffix: string) {
  return ["sk", "or", "v1", suffix].join("-");
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function createRepo() {
  const repo = join(
    tmpdir(),
    `frugal-fusion-secret-scan-test-${process.pid}-${createdRepos.length}`,
  );
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(scannerSource, join(repo, "scripts/public-secret-scan.mjs"));
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "test@example.invalid"], repo);
  run("git", ["config", "user.name", "Frugal Fusion Test"], repo);
  createdRepos.push(repo);
  return repo;
}

function commitAll(repo: string, message: string) {
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", message], repo);
}

function scan(repo: string) {
  return spawnSync("node", ["scripts/public-secret-scan.mjs"], {
    cwd: repo,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const repo of createdRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("public secret scan", () => {
  it("allows documented placeholders and short synthetic test tokens", () => {
    const repo = createRepo();
    writeFileSync(
      join(repo, "README.md"),
      [
        'export OPENROUTER_API_KEY="..."',
        'export FRUGAL_FUSION_MANIFEST_HMAC_KEY="$(openssl rand -base64 32)"',
        'const fake = "sk-or-v1-secret";',
      ].join("\n"),
    );
    commitAll(repo, "safe placeholders");

    const result = scan(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public secret scan passed");
  });

  it("redacts high-confidence worktree credentials in failure output", () => {
    const repo = createRepo();
    const secret = fakeOpenRouterKey("abcdefghijklmnopqrstuvwxyz1234567890");
    writeFileSync(join(repo, "leak.txt"), `const key = "${secret}";\n`);

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("openrouter_api_key");
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain("sk-or-...[REDACTED]...7890");
  });

  it("redacts every credential on a reported line", () => {
    const repo = createRepo();
    const firstSecret = fakeOpenRouterKey("aaaaaaaaaaaaaaaaaaaa111111111111");
    const secondSecret = fakeOpenRouterKey("bbbbbbbbbbbbbbbbbbbb222222222222");
    writeFileSync(
      join(repo, "two-leaks.txt"),
      `const keys = "${firstSecret}" + "${secondSecret}";\n`,
    );

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("openrouter_api_key");
    expect(result.stderr).not.toContain(firstSecret);
    expect(result.stderr).not.toContain(secondSecret);
    expect(result.stderr).toContain("sk-or-...[REDACTED]...1111");
    expect(result.stderr).toContain("sk-or-...[REDACTED]...2222");
  });

  it("redacts credentials that appear only in file paths", () => {
    const repo = createRepo();
    const pathSecret = fakeOpenRouterKey("pathpathpathpathpath333333333333");
    writeFileSync(join(repo, `${pathSecret}.txt`), "safe content\n");

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worktree-path");
    expect(result.stderr).toContain("openrouter_api_key");
    expect(result.stderr).not.toContain(pathSecret);
  });

  it("detects concrete HMAC values in YAML-style assignments", () => {
    const repo = createRepo();
    const hmacSecret = "abcdefghijklmnopqrstuvwxyz1234567890";
    writeFileSync(
      join(repo, "workflow.yml"),
      `FRUGAL_FUSION_MANIFEST_HMAC_KEY: "${hmacSecret}"\n`,
    );

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("concrete_eval_secret_env");
    expect(result.stderr).not.toContain(hmacSecret);
  });

  it("does not allow long fake-prefixed OpenRouter-shaped values", () => {
    const repo = createRepo();
    const fakePrefixedSecret = fakeOpenRouterKey(
      "fakeabcdefghijklmnopqrstuvwxyz1234567890",
    );
    writeFileSync(join(repo, "fake-prefixed.txt"), `${fakePrefixedSecret}\n`);

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("openrouter_api_key");
    expect(result.stderr).not.toContain(fakePrefixedSecret);
  });

  it("scans reachable commit history without exposing the matched value", () => {
    const repo = createRepo();
    const secret = fakeOpenRouterKey("zyxwvutsrqponmlkjihgfedcba9876543210");
    writeFileSync(join(repo, "history.txt"), `historical = "${secret}";\n`);
    commitAll(repo, "leaky history");
    writeFileSync(join(repo, "history.txt"), "historical = redacted;\n");
    commitAll(repo, "redact history");

    const result = scan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("history:");
    expect(result.stderr).toContain("openrouter_api_key");
    expect(result.stderr).not.toContain(secret);
  });
});
