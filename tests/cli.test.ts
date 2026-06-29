import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("runCli --version", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should print package version and exit 0 when --version is passed", async () => {
    const exitCode = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(PACKAGE_VERSION);
  });

  it("should print package version and exit 0 when -V is passed", async () => {
    const exitCode = await runCli(["-V"]);
    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(PACKAGE_VERSION);
  });
});
