# Execution gas gap: attribution and compatible reductions

Measured against production source `15f0ed22a71cf49bf4ce247760b74f17630657f4`
(also unchanged at research commit `83f01f4`). This is the original matched
single-Core-hop exact-input case from [the Huff study](../huff-feasibility/README.md),
with explicit recipient and synthetic tokens requiring full addresses in Huff.
The **1,137 gas is Yul's extra execution cost**, not its total execution cost.

## Exact accounting

| Execution component | Yul | Huff | Extra Yul |
|---|---:|---:|---:|
| Outer router entry and return instructions | 214 | 169 | 45 |
| Core lock's own work excluding callback | 1,224 | 1,200 | 24 |
| Callback instructions before Core.swap | 1,015 | 664 | 351 |
| Callback instructions after Core.swap | 1,063 | 346 | 717 |
| Shared downstream execution and CALL charges | 76,344 | 76,344 | 0 |
| **Execution total** | **79,860** | **78,723** | **1,137** |

The shared row consists of Core.swap (16,509), startPayments (5,881),
transferFrom (15,484), completePayments (2,021), withdraw (33,349),
five warm callback CALL charges (500), and the outer cold Core CALL charge (2,600).
Nested balanceOf/transfer work is already included in the parent call totals.
The Core lock difference reflects different envelope/buffer sizes.

Yul settles payment before withdrawal; Huff withdraws first. Consequently, compare
whole post-swap sections, not individual intervening segments as equivalent work.
Yul callback segments are 1,015 / 652 / 49 / 71 / 176 / 115; Huff segments are
664 / 182 / 56 / 75 / 27 / 6.

The callback's extra 1,068 instruction gas decomposes as follows:

| Opcode category | Yul | Huff | Difference |
|---|---:|---:|---:|
| DUP / SWAP / POP | 614 | 174 | +440 |
| Branches and jump destinations | 543 | 172 | +371 |
| Arithmetic, checks, environment, other | 322 | 160 | +162 |
| PUSH constants | 469 | 349 | +120 |
| Memory loads/stores | 81 | 72 | +9 |
| Calldata/code reads and copies | 49 | 83 | −34 |
| **Total** | **2,078** | **1,010** | **+1,068** |

Run `python benchmarks/execution-gas/analyze.py` to recount the recorded router
instructions. `router-steps.json` retains frame, PC, opcode and gas cost from the
baseline debugger trace. CALL opcodes are excluded: their debugger gas_cost
includes forwarded gas and cannot be summed as consumed execution gas.

The 811 gas in stack rearrangement and branches identifies a useful optimization
target, not an 811-gas achievable saving. Some branches enforce route, partial-fill,
quote and ERC20-result behavior not shared by Huff. In particular, Huff does not
validate transferFrom return data. We preserve these checks and settlement order.

## Experiments

Positive savings mean less execution gas. Calldata is identical across Yul variants.
All figures below were remeasured in this task.

| Change from baseline | Exact-input saved | Exact-output saved | Other exact-input route snapshots |
|---|---:|---:|---|
| **Direct endpoint settlement (retained)** | **40** | **33** | **40 saved** |
| Single Core hop shortcut | 258 | 277 | 65 more gas |
| Both above | 298 | 310 | 25 more gas |
| Settlement with pay-first switch | 39 | 41 | 39 saved |
| Settlement with withdraw-first switch | 48 | 30 | 48 saved |
| Settlement branches favoring exact input | 69 | 9 | 69 saved |
| Settlement branches favoring exact output | 18 | 62 | 18 saved |
| Zero-debt outer branch | −4 | −26 | 4 more gas |

Inlining Core.swap and ERC20 payment bodies on top of direct settlement produced
no additional gas saving. `experiments.json` records the measurements, including
deployment. SDK snapshots in the initial experiment sweeps were not rerun; the
final full validation reruns them, and `selected-gas.json` contains final snapshots.

The retained change eliminates the settle helper boundary and passes each signed
endpoint directly to payment or withdrawal. It preserves zero-debt behavior,
call order, native refunds and token-return validation. Runtime grows by 36 bytes
(2,391 to 2,427); CREATE grows by 7,762 gas (602,062 to 609,824). The deployment
premium amortizes after about 195 exact-input swaps, excluding deployment intrinsic.
Quotes and the recorded partial-fill rejection cases have unchanged gas.

**The exact-input execution gap falls from 1,137 to 1,097 gas.** Yul execution is
79,820 versus Huff's 78,723. Including intrinsic/calldata, the matched totals are
102,912 versus 100,999: a remaining 1,913-gas difference, including the unchanged
816 calldata-gas difference. Exact-output totals become 103,670 versus 101,567.

The combined shortcut can cut the original execution gap to 839 gas (26.2%), but
its other-route penalty and 52,114 additional CREATE gas make it a workload-dependent
tradeoff. It is not retained in production. `single-hop.patch` preserves the shortcut
against the baseline for further work; it must be applied to the baseline source.
Further substantial same-format gains would require restructuring the general route
executor's live values and loop/helper boundaries. Those gains remain unproven.

## Validation and reproduction

Toolchain: Forge 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`), solc 0.8.33,
Osaka, optimizer runs 9,999,999, via IR, **isolate=true**. Huff is the same recorded
initcode as the earlier study, not a fresh compilation. Dependency pins are unchanged.
Foundry snapshot totals include intrinsic/calldata under isolation.

The retained change passed all 69 production tests plus two matched Huff benchmarks
and a baseline differential test: **72 passed**, with **10,000 runs per fuzz test**,
seed 0x42. The differential checks both token directions and exactness modes against
the original runtime at the same address, comparing success/revert data, returned
amounts, payer/Core token balances and pool state. Existing coverage checks native
settlement/reentrancy, malformed routes, quotes, partial fills, mixed signs and short
ERC20 return data. See `validation.log`.

In an isolated worktree of the commit containing this report, initialize recursive
submodules and SDK dependencies, then apply the opt-in harness:

```sh
git apply benchmarks/execution-gas/harness.patch
forge build
python - <<'PY'
from pathlib import Path
p = Path('benchmarks/huff-feasibility')
Path('out/huff-init.hex').write_text((p / 'huff-init.hex').read_text().strip())
Path('out/execution-baseline.json').write_bytes((p / 'baseline.json').read_bytes())
PY
FOUNDRY_ISOLATE=true forge test --fuzz-runs 10000 --fuzz-seed 0x42 -vv
```

Build before testing after every Yul edit. The benchmark/differential harness remains
opt-in so normal tests need no historical router artifact. To reproduce baseline
gas, restore src/YulRouter.yul from 15f0ed2 in the isolated worktree and rebuild.
