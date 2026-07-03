import { describe, expect, it } from "vitest";
import {
  DRAFT_PERSONAS,
  pairRound,
  parseArms,
  parsePairs,
  parseVerdict,
  runTournament,
} from "../src/sampleSelect.js";

describe("DRAFT_PERSONAS", () => {
  it("has 6 personas with unique keys", () => {
    expect(DRAFT_PERSONAS).toHaveLength(6);
    expect(new Set(DRAFT_PERSONAS.map((p) => p.key)).size).toBe(6);
  });

  it("includes a neutral persona with an empty stance", () => {
    const neutral = DRAFT_PERSONAS.find((p) => p.key === "neutral");
    expect(neutral?.stance).toBe("");
  });
});

describe("pairRound", () => {
  it("pairs an even pool into adjacent matches with no bye", () => {
    const { matches, bye } = pairRound([0, 1, 2, 3, 4, 5], 0);
    expect(matches).toHaveLength(3);
    expect(bye).toBeNull();
  });

  it("gives the last entry a bye in an odd pool", () => {
    const { matches, bye } = pairRound([7, 8, 9], 0);
    expect(matches).toHaveLength(1);
    expect(bye).toBe(9);
  });

  it("alternates A/B presentation by round and match index", () => {
    const r0 = pairRound([0, 1, 2, 3], 0);
    // match 0: (round 0 + match 0) even -> no swap; match 1: odd -> swap
    expect(r0.matches[0]).toEqual({ a: 0, b: 1 });
    expect(r0.matches[1]).toEqual({ a: 3, b: 2 });
    const r1 = pairRound([0, 1, 2, 3], 1);
    expect(r1.matches[0]).toEqual({ a: 1, b: 0 });
    expect(r1.matches[1]).toEqual({ a: 2, b: 3 });
  });

  it("handles a two-entry pool", () => {
    const { matches, bye } = pairRound([4, 2], 0);
    expect(matches).toEqual([{ a: 4, b: 2 }]);
    expect(bye).toBeNull();
  });
});

describe("runTournament", () => {
  it("returns the sole entrant without judging when n=1", async () => {
    const result = await runTournament(1, async () => {
      throw new Error("judge must not be called");
    });
    expect(result).toEqual({ winner: 0, matchCount: 0, depth: 0 });
  });

  it("always selects the strongest candidate under a transitive judge", async () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const result = await runTournament(n, async (a, b) => Math.max(a, b));
      expect(result.winner).toBe(n - 1);
    }
  });

  it("uses 5 matches at depth 3 for n=6", async () => {
    const result = await runTournament(6, async (a, b) => Math.max(a, b));
    expect(result.matchCount).toBe(5);
    expect(result.depth).toBe(3);
  });

  it("rejects n < 1", async () => {
    await expect(runTournament(0, async (a) => a)).rejects.toThrow();
  });
});

describe("parseArms", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(parseArms(undefined, ["review"])).toEqual(["review"]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseArms(" review, ssp ,,ss ", ["x"])).toEqual([
      "review",
      "ssp",
      "ss",
    ]);
  });
});

describe("parseVerdict", () => {
  it("parses a bare A or B", () => {
    expect(parseVerdict("A")).toBe("A");
    expect(parseVerdict("B")).toBe("B");
  });

  it("parses with trailing punctuation and whitespace", () => {
    expect(parseVerdict("  A. ")).toBe("A");
    expect(parseVerdict("B)\n")).toBe("B");
  });

  it("uppercases a lowercase single-letter reply", () => {
    expect(parseVerdict("a")).toBe("A");
    expect(parseVerdict("b")).toBe("B");
  });

  it("falls back to the last standalone uppercase token when the strict prefix fails", () => {
    expect(parseVerdict("The better response is B")).toBe("B");
    expect(parseVerdict("I choose A because it is more complete.")).toBe("A");
  });

  it("returns null when both standalone uppercase letters appear (ambiguous)", () => {
    expect(parseVerdict("Response A is better than B overall")).toBe(null);
  });

  it("still resolves a single-letter reasoning sentence", () => {
    expect(
      parseVerdict("After weighing the tradeoffs, the better response is B"),
    ).toBe("B");
  });

  it("does not match the article 'a' in lowercase prose", () => {
    expect(parseVerdict("a good response would address this")).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(parseVerdict("")).toBe(null);
    expect(parseVerdict("   ")).toBe(null);
  });

  it("returns null for NONE or prose with no standalone uppercase A/B", () => {
    expect(parseVerdict("NONE")).toBe(null);
    expect(parseVerdict("This response is much longer and clearer.")).toBe(
      null,
    );
  });
});

describe("parsePairs", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(parsePairs(undefined, [["a", "b"]])).toEqual([["a", "b"]]);
  });

  it("parses colon-separated pairs", () => {
    expect(parsePairs("ssp:review, ss:review", [])).toEqual([
      ["ssp", "review"],
      ["ss", "review"],
    ]);
  });

  it("throws on a malformed pair", () => {
    expect(() => parsePairs("sspreview", [])).toThrow(/pair/i);
  });
});
