import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFile } from "../src/envFile.js";

describe("parseEnvFile", () => {
  it("parses simple assignments, skipping comments and blank lines", () => {
    expect(parseEnvFile("# comment\n\nFOO=bar\nBAZ=qux\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("strips matching surrounding quotes and honors export prefix", () => {
    expect(parseEnvFile(`export A="one"\nB='two'\nC=three`)).toEqual({
      A: "one",
      B: "two",
      C: "three",
    });
  });

  it("ignores invalid keys and keyless lines", () => {
    expect(parseEnvFile("1BAD=x\n=novalue\nGOOD=y")).toEqual({ GOOD: "y" });
  });
});

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frugal-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a missing file", () => {
    expect(loadEnvFile(join(dir, "nope.env"), {})).toEqual({});
  });

  it("applies file values only when the variable is unset", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "PRESET=fromfile\nNEW=fromfile\n");
    const env: NodeJS.ProcessEnv = { PRESET: "fromshell" };
    const applied = loadEnvFile(path, env);
    expect(applied).toEqual({ NEW: "fromfile" });
    expect(env.PRESET).toBe("fromshell");
    expect(env.NEW).toBe("fromfile");
  });
});
