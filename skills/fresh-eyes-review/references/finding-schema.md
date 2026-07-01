# Finding, Verdict, and Report Shapes

The workflow (`scripts/review_workflow.js`) encodes these internally via JSON Schema. Use these shapes when running the **Agent-tool fallback** (when the Workflow tool is unavailable), so the output stays consistent.

## Finding — what each reviewer returns

```json
{
  "findings": [
    {
      "title": "Salt is generated but never used in the hash",
      "severity": "high",
      "location": "auth.py:42 hash_password()",
      "problem": "os.urandom(16) is created but the hash uses sha256(password) with no salt, so identical passwords produce identical hashes and are rainbow-table vulnerable.",
      "recommendation": "Use hashlib.pbkdf2_hmac or bcrypt/argon2 with the generated salt baked into the output.",
      "rationale": "Unsalted hashes let an attacker crack all accounts with one precomputed table."
    }
  ]
}
```

Ask each role-agent for this shape. `rationale` is optional; the rest are required.

## Verdict — what each skeptic returns

```json
{
  "verdict": "confirmed", // confirmed | refuted | uncertain
  "confidence": "high", // high | medium | low
  "reasoning": "auth.py:42 — hashlib.sha256(password.encode()).hexdigest() indeed ignores the `salt` variable created on line 40. Confirmed.",
  "corrected_severity": "high" // optional — only if the reviewer's severity was wrong
}
```

A finding is **kept** only when `verdict === "confirmed"`. Anything else is a false positive and is filtered (but a few are surfaced in the report's `false_positives` so the user can see the rigor).

## Report — what the workflow returns to you

```json
{
  "summary": "2 confirmed findings, both in auth.py. No issues elsewhere.",
  "findings": [
    {
      "title": "...",
      "severity": "...",
      "location": "...",
      "problem": "...",
      "recommendation": "...",
      "rationale": "...",
      "roles": ["security", "correctness"]
    }
  ],
  "false_positives": [{ "title": "...", "why": "..." }]
}
```

## Severity guidance

- **critical** — exploitable security hole, data loss, or crashes on normal input. Must fix.
- **high** — likely bug or security weakness with real impact. Fix before shipping.
- **medium** — real issue, moderate impact or moderate likelihood. Should fix.
- **low** — minor correctness/clarity issue. Nice to fix.
- **nit** — style/preference. Optional.

## Convergence (decided by you, the main agent — not the workflow)

A round has **new notable findings** if any confirmed finding has severity `medium` or higher **and** its title is not already in `alreadyAddressed`.

- **Converged** → a round with zero new notable findings. Stop.
- **Hard cap** → stop after 4 rounds regardless, and report what remains.
- `low`/`nit` findings are listed and may be fixed, but they never block convergence on their own — otherwise the loop chases nits forever.
