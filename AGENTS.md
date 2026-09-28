# AGENTS.md

## Complexity Policy (`sdk/`)
- Run `bun run lint` in `sdk/` before considering a change done. CI runs it on every
  push and pull request, before the SDK build.
- The only rule is ESLint's `complexity`, capped at 10 per function.
- One function is over the limit today and recorded in `sdk/eslint-suppressions.json`:
  `encodeSignedSwapMeta` (12) in `sdk/src/index.ts`. `encodeRoutes` was split into
  per-multi-hop, per-hop and header encoders and is no longer recorded.
- The file is a ratchet, not an amnesty: ESLint stores a per-file count, so a new
  function over the limit fails the build even in a file that already has entries.
  Do not raise a count to make the build pass. If you simplify a recorded function,
  the run will report an unused suppression — run `bun run lint:prune` and commit.

## Complexity Policy (`src/`)
- `src/YulRouter.yul` is hand-written Yul. There is no complexity linter for Yul, so
  the router itself is ungated. Nothing to run.
