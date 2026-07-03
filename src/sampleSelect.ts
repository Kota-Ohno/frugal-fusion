// Pure, network-free logic for the sample-select-polish eval arms:
// draft personas, single-elimination tournament bracket, and CLI flag
// parsing. Kept in src/ (not scripts/) so the standard typecheck and
// vitest gates cover it — same pattern as envFile.ts.

export interface DraftPersona {
  key: string;
  stance: string;
}

// Diversity moves from critique-time to draft-time: the four review-lens
// framings become drafting stances, plus a neutral and a simplicity-minded
// persona. Stances are appended to the task system prompt.
export const DRAFT_PERSONAS: DraftPersona[] = [
  {
    key: "correctness",
    stance:
      " Approach the problem as an engineer obsessed with logical correctness: get every invariant, condition, and state transition exactly right.",
  },
  {
    key: "edge-cases",
    stance:
      " Approach the problem as an engineer who designs from the failure modes inward: handle boundary conditions, race conditions, and hostile inputs first.",
  },
  {
    key: "requirements",
    stance:
      " Approach the problem as an engineer who treats the stated requirements as a contract: address every single one explicitly and completely.",
  },
  {
    key: "security",
    stance:
      " Approach the problem as a security-minded engineer: assume inputs are hostile, validate everything, and design for least privilege.",
  },
  { key: "neutral", stance: "" },
  {
    key: "simplicity",
    stance:
      " Approach the problem as an engineer who prizes simplicity: find the most robust design with the fewest moving parts, and say no to overengineering.",
  },
];

export interface Match {
  a: number;
  b: number;
}

// Pair a pool into adjacent matches. Odd pool -> last entry gets a bye.
// Presentation order (which side is shown as "A") alternates with
// (roundIndex + matchIndex) so a systematic first-position bias in the
// selector cannot favor one bracket path. Full counterbalancing is
// reserved for the outer measurement panel; internal selection tolerates
// more noise per comparison.
export function pairRound(
  pool: number[],
  roundIndex: number,
): { matches: Match[]; bye: number | null } {
  const matches: Match[] = [];
  const pairCount = Math.floor(pool.length / 2);
  for (let m = 0; m < pairCount; m += 1) {
    const first = pool[2 * m]!;
    const second = pool[2 * m + 1]!;
    if ((roundIndex + m) % 2 === 0) {
      matches.push({ a: first, b: second });
    } else {
      matches.push({ a: second, b: first });
    }
  }
  const bye = pool.length % 2 === 1 ? pool[pool.length - 1]! : null;
  return { matches, bye };
}

// Single-elimination tournament over candidate indices 0..n-1.
// `judge(a, b)` sees a presented as "A" and b as "B" and must return the
// winning index (either a or b). Matches within a round run concurrently;
// rounds are serial. Returns the winning index plus match/depth counts
// for instrumentation.
export async function runTournament(
  n: number,
  judge: (a: number, b: number) => Promise<number>,
): Promise<{ winner: number; matchCount: number; depth: number }> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`runTournament requires an integer n >= 1, got ${n}`);
  }
  let pool = Array.from({ length: n }, (_, i) => i);
  let matchCount = 0;
  let depth = 0;
  let roundIndex = 0;
  while (pool.length > 1) {
    const { matches, bye } = pairRound(pool, roundIndex);
    const winners = await Promise.all(matches.map((m) => judge(m.a, m.b)));
    matchCount += matches.length;
    depth += 1;
    roundIndex += 1;
    pool = bye === null ? winners : [...winners, bye];
  }
  return { winner: pool[0]!, matchCount, depth };
}

// Parse an A/B forced-choice verdict from a selector response. Strict
// prefix match first; if that fails, fall back to scanning standalone
// "A"/"B" tokens in the text (reasoning-heavy models often narrate
// before answering — "…therefore the better response is B"). The
// fallback only counts standalone UPPERCASE A/B tokens (\bA\b / \bB\b)
// so it never mistakes the article "a" in ordinary prose for a verdict.
// If exactly one distinct letter appears, that letter wins. If both
// letters are mentioned (e.g. "Response A is better than B overall"),
// the verdict is ambiguous and this returns null rather than guessing —
// callers count null verdicts as observable `unparseable` outcomes.
export function parseVerdict(text: string): "A" | "B" | null {
  const trimmed = text.trim();
  if (trimmed === "A" || trimmed.startsWith("A.") || trimmed.startsWith("A)"))
    return "A";
  if (trimmed === "B" || trimmed.startsWith("B.") || trimmed.startsWith("B)"))
    return "B";
  if (trimmed.toUpperCase() === "A") return "A";
  if (trimmed.toUpperCase() === "B") return "B";
  const matches = trimmed.match(/\b[AB]\b/g);
  if (!matches || matches.length === 0) return null;
  const distinct = new Set(matches);
  if (distinct.size !== 1) return null;
  return distinct.has("A") ? "A" : "B";
}

export function parseArms(
  raw: string | undefined,
  fallback: string[],
): string[] {
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePairs(
  raw: string | undefined,
  fallback: [string, string][],
): [string, string][] {
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Malformed pair "${entry}" — expected "challenger:baseline"`,
        );
      }
      return [parts[0], parts[1]] as [string, string];
    });
}
