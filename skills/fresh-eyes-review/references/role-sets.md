# Role Sets

Roles are the main lever in this skill. Each role is one agent working one lane, so the set should **cover the territory without overlapping** — overlapping roles waste agents and split the same finding across reviewers.

A role is `{ key, name, lens }`:

- `key` — short id, used in labels (`review:security`).
- `name` — display name.
- `lens` — what to look for **and the question to keep asking**. Format: _"<domain specifics>. Ask: <recurring question>"_.

Pick a set that matches the artifact, then adjust with the user. 4–7 roles is the sweet spot.

---

## Generic / default (good starting point for code)

| key               | name            | Ask                                                             |
| ----------------- | --------------- | --------------------------------------------------------------- |
| `correctness`     | Correctness     | does this actually do what it claims, for every input and path? |
| `robustness`      | Robustness      | what happens when things go wrong or inputs are hostile?        |
| `security`        | Security        | how could this be abused, bypassed, or broken into?             |
| `performance`     | Performance     | where does this get slow or fat as input grows?                 |
| `maintainability` | Maintainability | will the next reader understand and safely change it?           |
| `design`          | Design          | is this in the right place, shaped the right way?               |
| `completeness`    | Completeness    | what is unfinished, untested, or assumed-but-not-enforced?      |

(Full lens text for these lives in `scripts/review_workflow.js` as `DEFAULT_ROLES`.)

## Frontend / UI

`accessibility` (semantic HTML, ARIA, focus, contrast, keyboard) · `visual-polish` (spacing, alignment, responsive, consistency) · `interaction` (state transitions, loading/empty/error states, edge input) · `state-and-data` (prop drilling, re-render/stale-state, fetching/caching) · `performance` (bundle, reflows, list virtualization, image loading) · `security` (XSS, unsafe HTML, exposed secrets)

## Backend / API

`correctness` · `security` (authn/authz, injection, mass-assignment) · `api-contract` (status codes, error shapes, versioning, idempotency, validation) · `data-integrity` (transactions, constraints, migrations, race conditions) · `performance` (N+1, indexes, pagination) · `observability` (logging, tracing, metrics, alertability) · `robustness`

## Design doc / spec

`accuracy` (technically correct claims) · `completeness` (missing requirements, sections, edge cases) · `internal-consistency` (claims that contradict each other or the data model) · `feasibility` (assumptions, unknowns, risks, alternatives not considered) · `clarity` (ambiguity a reader could misimplement) · `testability` (acceptance criteria, how success is measured)

## Infra / config (Terraform, K8s, CI, Dockerfile)

`security` (least privilege, secrets, exposed ports) · `correctness` (resource names, dependencies, syntax) · `reliability` (replicas, health checks, retries, backups) · `cost` (right-sizing, unused resources) · `safety` (idempotency, destroy guards, drift) · `observability`

## Docs / runbook / README

`accuracy` (does it match current behavior) · `completeness` (prerequisites, gotchas, recovery steps) · `clarity` (could a new reader follow it) · `maintainability` (will it rot — hardcoded versions, manual steps that drift)

---

## Writing a strong lens

A weak lens says "look at performance." A strong lens names the **specific failure modes** in this artifact type and pins a **recurring question**:

> **Weak:** `Performance` — "Review performance."
> **Strong:** `Performance` — "Algorithmic complexity, N+1 queries, redundant work, unbounded loops, memory growth. Ask: where does this get slow or fat as the input grows?"

The question is what the agent loops on between findings. Include it.

## Building a custom role

```
{ key: 'migrations', name: 'DB Migration Safety', lens: 'Reversibility, locking, backfill strategy, null-handling on existing rows, long-running table rewrites. Ask: can this be deployed and rolled back safely on a populated database?' }
```

Drop in via the `roles` arg. Custom roles shine for domain-specific reviews (payments, ML pipelines, GDPR, etc.) — ask the user if a domain role applies.
