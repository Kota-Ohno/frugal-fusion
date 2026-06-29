# Frugal Fusion No-Spend Verify Gate

Run the project's no-spend verification gate and make the change pass it. Use
ONLY local, no-spend commands — never any live OpenRouter / model / network call.

## Commands to run (in order)

```bash
pnpm install --frozen-lockfile   # only if node_modules is missing
pnpm typecheck
pnpm lint
pnpm run format:check
pnpm test
pnpm run public-release:secrets
pnpm run public-release:audit
```

If a command's script does not exist in `package.json`, skip it and note that in
the report rather than inventing a substitute.

## What to do with results

- If everything passes: report the exact commands run and their pass status, and
  conclude that the no-spend checks pass.
- If something fails because of THIS change: fix it within the causally related
  scope only — do not expand scope or weaken existing contracts — then re-run the
  gate.
- If `public-release:audit` flags a stray generated/private artifact that this
  task introduced (e.g. `dist/`, snapshots, `.serena/`, `.takt/runs/`), remove it
  from the working tree / staging rather than editing the guard to allow it.
- If a failure is pre-existing and unrelated to this change, do NOT fix it; record
  it as a pre-existing issue and proceed.
- If the change fundamentally cannot pass without replanning, say so and request a
  replan instead of forcing a workaround.

Report the commands executed, their outcomes, and any artifacts removed.
