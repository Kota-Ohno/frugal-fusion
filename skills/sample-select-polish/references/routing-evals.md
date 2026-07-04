# Routing evals — does the agent follow the SSP-first policy?

Regression scenarios for `claude-md-policy.md` (SSP.md). Use when swapping
the main model or editing the policy: give each request to a fresh session
with the policy installed and check the observed routing against Expected.
A pass requires both the right tier AND no un-asked-for escalation.

| #   | Request (verbatim to the agent)                                    | Expected routing                                                                                                       | Why                                                                                          |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | 認証まわりのアーキテクチャ設計書を書いて                           | Tier 1: invoke sample-select-polish                                                                                    | New hard artifact; security-sensitive design doc                                             |
| 2   | このPR、レビューしてもらえる?                                      | Tier 2: invoke fresh-eyes-review                                                                                       | Existing artifact, explicit "review" trigger                                                 |
| 3   | READMEのtypoを直して                                               | Tier 3: neither                                                                                                        | Trivial edit; sampling cost unjustified                                                      |
| 4   | 決済のリトライ処理を実装して                                       | Tier 1: invoke sample-select-polish                                                                                    | High-stakes implementation (payments, idempotency traps)                                     |
| 5   | この設計書、何か見落としある?                                      | Tier 2: invoke fresh-eyes-review                                                                                       | "What did I miss" on an existing artifact                                                    |
| 6   | この変数、全部リネームして                                         | Tier 3: neither                                                                                                        | Mechanical refactor                                                                          |
| 7   | 公開用のブログ記事を書いて                                         | Tier 1: invoke sample-select-polish                                                                                    | Publication-grade writing                                                                    |
| 8   | この関数って何をしてるの?                                          | Tier 3: neither                                                                                                        | Q&A / exploratory chat                                                                       |
| 9   | (5タスクの実装計画の途中で) 次はDBマイグレーションのタスクをやって | Composition rule: sample-select-polish on this task ONLY if it is the plan's riskiest artifact; otherwise normal draft | Inside a larger plan, ssp goes to the single riskiest artifact, not every Tier-1-shaped task |
| 10  | (ssp勝者を渡して) 念のためもう一回フルレビューして                 | Decline the extra round: explain the one-round discipline, offer a bounded re-sample if critical issues are suspected  | Tier 2 exception + anti-pattern: an ssp winner already had its review round                  |

Scoring: 10/10 = policy holds. Failures on #9/#10 (the composition and
discipline rules) matter more than #1-8 (plain routing) — they are where
weaker models drift first, and where the cost blowups live.
