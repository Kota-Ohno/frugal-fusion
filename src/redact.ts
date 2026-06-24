const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string | ((match: string, prefix?: string) => string);
}> = [
  { pattern: /sk-or-v1-[A-Za-z0-9_-]+/g, replacement: "[REDACTED]" },
  {
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern: /(OPENROUTER_API_KEY\s*=\s*)[^\s]+/gi,
    replacement: (_match, prefix = "") => `${prefix}[REDACTED]`,
  },
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { pattern, replacement }) =>
      text.replace(pattern, replacement as string),
    input,
  );
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]),
    ) as T;
  }
  return value;
}
