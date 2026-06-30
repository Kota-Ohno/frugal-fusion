#!/usr/bin/env node
// Deterministically GENERATES long-input eval cases whose answers are computed
// in code (not by an LLM), so expected values are guaranteed correct. These
// target genuine headroom: tasks a strong model slips on because the answer
// compounds over a long input (summing/counting/chaining many operands), while
// remaining deterministically checkable.
//
// Usage: node scripts/gen-longform-cases.mjs > examples/cases.longform.jsonl

// Seeded LCG so output is reproducible (no Math.random).
let _seed = 20260630;
const rnd = () => {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const list = (n, lo, hi) => Array.from({ length: n }, () => int(lo, hi));
const isPrime = (n) => {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
};

const cases = [];
const push = (c) => cases.push(c);

// 1. Long sum (number) ----------------------------------------------------
for (let i = 1; i <= 10; i++) {
  const xs = list(int(32, 48), 10, 999);
  push({
    id: `sum-${i}`,
    task: `Add together all of these numbers and return the total: ${xs.join(", ")}. Return only the final number, no words or units.`,
    constraints: ["Sum every number", "Return only the number"],
    difficulty: "hard",
    grader: { number: { expected: xs.reduce((a, b) => a + b, 0) } },
  });
}

// 2. Count-of-property (number) -------------------------------------------
for (let i = 1; i <= 6; i++) {
  const xs = list(int(30, 45), 1, 200);
  const thr = int(80, 120);
  push({
    id: `count-${i}`,
    task: `In this list, how many numbers are strictly greater than ${thr}? List: ${xs.join(", ")}. Return only the final number, no words.`,
    constraints: [`Count numbers > ${thr}`, "Return only the number"],
    difficulty: "hard",
    grader: { number: { expected: xs.filter((x) => x > thr).length } },
  });
}

// 3. Prime-count (number) -------------------------------------------------
for (let i = 1; i <= 4; i++) {
  const xs = list(int(24, 34), 2, 120);
  push({
    id: `primes-${i}`,
    task: `How many of these numbers are prime? List: ${xs.join(", ")}. Return only the final number, no words.`,
    constraints: ["Count primes", "Return only the number"],
    difficulty: "hard",
    grader: { number: { expected: xs.filter(isPrime).length } },
  });
}

// 4. Operation chain (number) ---------------------------------------------
for (let i = 1; i <= 6; i++) {
  let v = int(5, 40);
  const start = v;
  const ops = [];
  const steps = int(9, 13);
  for (let s = 0; s < steps; s++) {
    const kind = int(0, 2);
    if (kind === 0) {
      const k = int(3, 40);
      ops.push(`add ${k}`);
      v += k;
    } else if (kind === 1) {
      const k = int(2, 25);
      ops.push(`subtract ${k}`);
      v -= k;
    } else {
      const k = int(2, 4);
      ops.push(`multiply by ${k}`);
      v *= k;
    }
  }
  push({
    id: `chain-${i}`,
    task: `Start with ${start}. Then, in order: ${ops.join(", ")}. What is the final result? Return only the final number, no words.`,
    constraints: ["Apply each operation in order", "Return only the number"],
    difficulty: "hard",
    grader: { number: { expected: v } },
  });
}

// 5. Filtered sum (number) ------------------------------------------------
for (let i = 1; i <= 4; i++) {
  const xs = list(int(28, 40), 1, 99);
  const d = [3, 4, 5][int(0, 2)];
  push({
    id: `filtsum-${i}`,
    task: `From this list, add up only the numbers that are evenly divisible by ${d}, and return that total: ${xs.join(", ")}. Return only the final number, no words.`,
    constraints: [`Sum only multiples of ${d}`, "Return only the number"],
    difficulty: "hard",
    grader: {
      number: {
        expected: xs.filter((x) => x % d === 0).reduce((a, b) => a + b, 0),
      },
    },
  });
}

// 6. Sorted positions (json) ----------------------------------------------
for (let i = 1; i <= 6; i++) {
  const n = int(20, 28);
  const xs = list(n, 1, 999);
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor((n - 1) / 2);
  push({
    id: `sort-${i}`,
    task: `Sort these numbers in ascending order and return strict JSON (no markdown, no prose) of the form {"result": [ ... ]} where result is the full sorted array: ${xs.join(", ")}.`,
    constraints: ["Ascending order", "Return strict JSON with key result"],
    difficulty: "hard",
    grader: {
      json: {
        requireValid: true,
        requiredPaths: ["result[0]", `result[${n - 1}]`],
        arrayMinLength: { result: n },
        equals: {
          "result[0]": sorted[0],
          [`result[${mid}]`]: sorted[mid],
          [`result[${n - 1}]`]: sorted[n - 1],
        },
      },
    },
  });
}

// 7. Largest-sum choice (choice) ------------------------------------------
for (let i = 1; i <= 4; i++) {
  const labels = ["a", "b", "c", "d"];
  const lists = labels.map(() => list(int(10, 16), 1, 99));
  const sums = lists.map((l) => l.reduce((a, b) => a + b, 0));
  let best = 0;
  for (let k = 1; k < sums.length; k++) if (sums[k] > sums[best]) best = k;
  // Ensure a unique max; if tie, nudge the intended winner up by 1 element.
  const tie = sums.filter((s) => s === sums[best]).length > 1;
  if (tie) {
    lists[best].push(1);
    sums[best] += 1;
  }
  const desc = labels
    .map((lab, k) => `${lab}: [${lists[k].join(", ")}]`)
    .join("  ");
  push({
    id: `maxsum-${i}`,
    task: `Four labelled lists are given. Which list has the largest sum? ${desc}. Answer with exactly one of: a, b, c, d. Output only the single letter.`,
    constraints: ["Compare list sums", "Output only the letter"],
    difficulty: "hard",
    grader: { choice: { expected: labels[best], allowed: labels } },
  });
}

for (const c of cases) process.stdout.write(JSON.stringify(c) + "\n");
process.stderr.write(`generated ${cases.length} cases\n`);
