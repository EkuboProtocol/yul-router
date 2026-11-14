# Does compiling the router with Solar save gas?

Measured November 14, 2026 against production source `642fd13`. Experiment only: nothing here is
deployed, released or wired into CI, and `src/YulRouter.yul` is still the production router.

**No. A direct port costs 0.35% to 0.95% more gas per swap under Solar (1.8% to 1.9% on a quote) and is
not behaviour-equivalent.
A port with a memory layout that is sound under Solar is within about ±0.25% of the solc build:
slightly cheaper on multi-path routes, slightly dearer on single-hop swaps.**

## What was built

Solar does not compile standalone Yul objects (`error: Yul is not supported yet`, also with
`-Zparse-yul`). The port is therefore a Solidity contract with two immutables and a `fallback` whose
body is the router's runtime code as one inline assembly block.

| Label | Source | Compiler |
|---|---|---|
| `yul-solc` | `src/YulRouter.yul` (production) | solc 0.8.33, via IR, 9,999,999 runs |
| `sol-solc` | `sources/NaivePort.sol`, runtime code unchanged | same solc |
| `solar030-gas` | `sources/NaivePort.sol` | Solar 0.3.0 release (`e7a91fc7`), `-O gas` |
| `solarmain-gas` | `sources/NaivePort.sol` | Solar main (`c6a26991`), `-O gas` |
| `ms-solarmain-gas` | `sources/MemorySafePort.sol`, every buffer at `mload(0x40)` | Solar main |
| `l80_e2-solc` | `src/YulRouter.sol` | same solc |
| `l80_e2-solar030` | `src/YulRouter.sol` | Solar 0.3.0 release |
| `l80_e2-solar` | `src/YulRouter.sol` | Solar main |

`src/YulRouter.sol` keeps fixed-size ABI buffers at constant addresses from `0x80`, moves the three
variable-length buffers (lock envelope, signed-swap signature, bubbled revert data) to the free
memory pointer, and folds the per-path hop count into the hop loop counter.

## Results

Foundry 1.8.3, Osaka, `isolate = true`, so swap figures include intrinsic and calldata gas. Deltas
are against `yul-solc`. The full table is in `results/summary.md`.

| Case | yul-solc | solar030-gas | solarmain-gas | l80_e2-solc | l80_e2-solar030 | l80_e2-solar |
|---|---:|---:|---:|---:|---:|---:|
| Core hop | 93,328 | +886 | +800 | +52 | +234 | +130 |
| Core hop, SDK calldata | 93,400 | +855 | +772 | +52 | +203 | +99 |
| Core hop with deadline | 93,543 | +798 | +718 | +52 | +146 | +48 |
| Forwarded hop | 97,903 | +896 | +810 | +52 | +229 | +131 |
| Two paths, multi-hop | 130,579 | +746 | +488 | +1 | +206 | −100 |
| Two paths, multi-hop, SDK | 130,651 | +715 | +460 | +1 | +175 | −131 |
| Signed exclusive swap hop | 150,640 | +896 | +841 | +134 | +334 | +266 |
| Wrapper hop | 98,111 | +890 | +887 | +68 | +242 | +233 |
| Quote, core hop | 45,712 | +888 | +802 | +11 | +152 | +48 |
| Runtime bytes | 2,523 | 2,378 | 2,449 | 3,125 | 2,568 | 2,624 |
| CREATE gas | 630,603 | −29,600 | −13,929 | +131,445 | +11,370 | +23,802 |

Across all 20 swap, quote, native, partial and token snapshots: the direct port is +460 to +965 gas
under either Solar build; `l80_e2-solar` ranges from −131 to +266 gas (−0.10% to +0.24%).

## Why the direct port costs more

Solar keeps three long-lived values of the route loop (`routeEnd` and the two hop counters) in
memory instead of on the stack. Because the router writes memory at addresses computed
from calldata, Solar places those spill slots above `0x2080`
([`CODEGEN-010`](https://github.com/paradigmxyz/solar/blob/main/docs/SOLC_DIVERGENCE.md)); they land
at `0x2120`, `0x2140` and `0x2160`. Touching `0x2160` expands the callback's memory to 268 words,
which costs 944 gas against 15 for the solc build. That is the whole regression: subtracting it puts
the Solar main direct port at roughly −130 gas on a core hop and −440 on the two-path route. Those
two figures are derived by arithmetic, not measured.

## Why the direct port is not equivalent

The router copies a signed swap's signature to `0x140` and onward. With a signature longer than
8,160 bytes the copy reaches the spill slots, and Solar's spill stores then overwrite 96 bytes of the
signature before the call. `test/RouterDifferential.t.sol` shows it: the forwardee receives a
different payload from the Solar build than from the solc build, with every differing byte at router
memory `0x2120..0x217f`. Solar documents this limit for assembly that is not memory-safe, so it is a
property of the port, not a compiler bug. Real signatures are 65 bytes, and a corrupted one fails
verification, so the effect is a revert, not a loss of funds.

Marking the unchanged block `"memory-safe"` does not move the spill slots and would be untrue.
Making it genuinely memory-safe (`sources/MemorySafePort.sol`) removes the divergence but ranges
from −29 to +238 gas under Solar main (+184 on a core hop), because every buffer address becomes
`mload(0x40)` plus an offset.

## Validation

- All 74 existing tests pass on every build in the table.
- `test/RouterDifferential.t.sol` deploys the solc Yul build and a candidate at the same address and
  requires identical success flags, return data and forwarded payloads for generated multi-path
  routes (forwarded, signed and wrapper hops, signatures up to 20,000 bytes), mutated routes and
  arbitrary calldata, in quote and forwarded mode. Core hops and settlement are covered by the
  existing suite only.
- `l80_e2-solar`: 79 tests pass at 5,000 fuzz runs, seed `0x42`.
- `solarmain-gas` and `solar030-gas` fail the differential test on forwarded payloads.

Not done: no audit, no fork test, no check that block explorers can verify Solar bytecode, and no
change to the deploy script, release workflow or CI, which still build the Yul object with forge.
Solar 0.3.0's release notes call code generation experimental and say not to deploy its output to
production.

## Reproduce

```sh
forge build
benchmarks/solar/build-solar.sh /path/to/solar l80_e2-solar -O gas
benchmarks/solar/run-variant.sh l80_e2-solar out/l80_e2-solar/YulRouter.json
python3 benchmarks/solar/compare.py yul-solc l80_e2-solar

# Rebuild another variant from the direct port (l80, e2, hyb, e1 are defined in variants.py).
python3 benchmarks/solar/variants.py benchmarks/solar/sources/NaivePort.sol src/YulRouter.sol l80+e2

# Show the payload difference for one generated route.
ROUTER_ARTIFACT=out/solarmain-gas/YulRouter.json forge test --match-test test_DebugSeed -vv > debug.log
python3 benchmarks/solar/diffpayload.py debug.log
```

`ROUTER_ARTIFACT` selects the artifact the tests deploy; it defaults to the solc Yul build.
`run-variant.sh` restores `snapshots/` after copying them, so the checked-in snapshots stay those of
the production build. `hyb` and `e1` in `variants.py` are rejected experiments: `hyb` overwrites the
free memory pointer and fails the suite, and `e1` costs more gas.
