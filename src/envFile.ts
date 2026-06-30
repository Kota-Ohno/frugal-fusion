import { readFileSync } from "node:fs";

export type EnvFileEntries = Record<string, string>;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(contents: string): EnvFileEntries {
  const entries: EnvFileEntries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;
    const key = assignment.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;
    let value = assignment.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

/**
 * Loads `.env` into `env` without overwriting variables that are already set,
 * so a real shell export always wins over the file. Missing or unreadable
 * files are a silent no-op. Returns only the keys this call actually applied.
 */
export function loadEnvFile(
  path = ".env",
  env: NodeJS.ProcessEnv = process.env,
): EnvFileEntries {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const applied: EnvFileEntries = {};
  for (const [key, value] of Object.entries(parseEnvFile(contents))) {
    if (env[key] === undefined) {
      env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}
