# Can the Yul router beat Huff?

Measured September 10, 2026 against Yul production source at `15f0ed22a71cf49bf4ce247760b74f17630657f4`.

**Selected swaps can be cheaper with a different encoding and an immutable pool dictionary. These experiments do not demonstrate a consistent overall advantage over Huff. The gains on known-token routes are too small and inconsistent to justify this rewrite for gas alone.** The patches here are reproducible research artifacts; the production router and SDK retain their existing implementations.

## Correcting the initial comparison

Foundry's effective configuration uses `isolate = true`. The original reported 102,952/100,999 exact-input figures include transaction intrinsic/calldata gas, not just execution. They are before refunds. Opcode traces give this decomposition:

| Exact-input component | Yul main | Huff | Yul extra |
|---|---:|---:|---:|
| Transaction intrinsic gas | 23,092 | 22,276 | 816 |
| Execution, including Core and tokens | 79,860 | 78,723 | 1,137 |
| Total before refunds | 102,952 | 100,999 | 1,953 |

The routers made the same five downstream swap/payment/withdrawal calls with identical individual execution costs. Yul's own non-CALL instruction costs were 2,292 gas versus Huff's 1,179; Core's larger lock envelope accounted for another 24 gas. Huff withdraws before paying for exact input; current Yul pays first. The traces and these comparisons do not identify a cheaper way to eliminate any required Core/token call.

This substantially changes the target for a compatible optimization: it would have to remove about 1,953 of Yul's 2,292 own instruction gas while retaining its format and behavior. That is an aggressive target, not a proof of impossibility. Matching Huff's instruction overhead alone would still leave the calldata disadvantage.

## Experiments and results

All prototypes use standard solc 0.8.33, Osaka, via IR, and optimizer runs 9,999,999. The original compatible shortcut preserves the format and bypasses the general loop for one Core hop. It saved only 258 gas for exact input and 277 for exact output in the original fixture.

Further prototypes tested:

- A compact single-hop format that removes repeated token addresses and unused extension/limit fields.
- Flattened callback, Core-call and payment construction; separate exact-input/output paths; memory versus stack return values; alternative direction/delta decoding.
- Variable integer widths versus fixed widths.
- An immutable six-pool dictionary copied directly into Core's ABI buffer, with specialized short-amount paths and general-width fallbacks.
- Indexed two-hop and three-hop routes, including native-token endpoints.

The dictionary single-hop prototype retains the existing general route implementation as a fallback. The indexed-paths prototype adds another compact route mode. Both new modes deliberately use a different binary format.

Representative ranges below are **prototype minus Huff**, including intrinsic/calldata gas. Negative is cheaper. These are measured cases, not predictions for every route in the category.

| Cases | Single-hop prototype | Combined indexed-paths prototype |
|---|---:|---:|
| Known tokens, one-hop, small amounts, both directions, native/ERC-20 and recipient variants | −77 to +47 gas | −52 to +72 gas |
| Known tokens, 100-token fixture amount examples | +203 to +222 gas | +228 to +247 gas |
| Full-address encoding on Huff, bounded input/output examples | −641 / −677 gas | −616 / −652 gas |
| Known tokens, two hops | — | +517 to +590 gas |
| Known tokens, three hops with a native endpoint | — | +511 to +622 gas |

The first apparent dictionary win was roughly 520 gas against full-address Huff calldata. Giving Huff its known-token encoding removed most of that advantage. The full-address rows model routes whose assets are absent from Huff's token table; those rows explicitly force full-address encoding on the same fixtures. They are not a reason to route known USDC/USDT assets through Huff's longer encoding.

The matrices use token contracts with identical test implementations at addresses present in Huff's actual dictionary. They cover six pools, both swap signs and directions, explicit/default recipients, native input/output/refunds, short and long amounts, and the uint64 width boundary. They are controlled local fixtures, not production-fork measurements of the real tokens. The combined matrix contains 42 nonzero cases; zero-swap validation rows are excluded from performance conclusions.

## Costs and compatibility

The combined prototype measured 5,941 runtime bytes versus main's 2,391. CREATE cost was 1,365,001 versus 602,062 gas: **762,939 more deployment gas**. Each dictionary entry occupies 96 bytes; the prototype has six entries. Pool data is immutable, so newly listed pools need a new deployment or the existing full-format fallback.

Existing-format swap cases cost **149 additional gas** in the combined prototype. Wrapper cases have the same measured increase. The fast paths therefore have a cost even when they are not selected.

The full existing suite exposed a format incompatibility: the current router accepts and ignores upper flag bits, and the prototype assigns meanings to them. `testFuzz_RouteModesAgree` fails on those old encodings (example flags: 153). The other 68 existing tests passed at 10,000 fuzz runs; the route-mode test passed 10,000 runs when restricted to the SDK's canonical 0/1 flags. This compatibility check used the original baseline test file and SDK dependencies, rather than the comparison harness with known-token fixture addresses. The logs and legacy snapshot JSON files are included here. This is **not** a drop-in, behavior-equivalent replacement. A production design would need explicit API versioning and an SDK/deployment migration. The new compact amount magnitude is also limited to `2^127 - 1`; it does not implement the existing exact-output `-2^127` edge case.

## Validation and limits

The single-hop prototype passed six dedicated test functions and 10,000 fuzz cases. The combined prototype passed eight dedicated test functions and 10,000 fuzz cases. The checks cover:

- Calculated amounts, endpoint/sign metadata, payer/recipient/Core balances, and written Core storage slots against Huff, using the same router address and restored state between executions.
- Tiny generated swaps that fail slippage or exact-fill checks: their rejection bytes are compared against current Yul main instead of assuming every generated swap should succeed.
- Every truncation of representative compact packets and 1–64 appended bytes, dictionary bounds, amount bounds, slippage failures, false ERC-20 returns, native budget checks, and quote/execution agreement.
- For indexed paths, disconnected pools, invalid indexes, path truncation/appending and quotes.

Authentication, delegatecall rejection, full-fill validation, ERC-20 return checks and quote failure wrapping remain present. This is feasibility testing, not a security audit or evidence that every behavior is equivalent. Huff does not perform all the same validations; removing those checks was not used to manufacture a win.

The result supports pursuing **encoding changes as a separate product/API decision**, particularly if compact indexed routes have other benefits. It does not support a claim that a few more compatible Yul rewrites will beat Huff, or that the proposed dictionary rewrite is broadly more efficient. Other designs or compiler improvements remain possible.

## Reproduce

Use Python 3, git, Forge 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`) and solc 0.8.33. Submodule initialization requires GitHub access.

```sh
python benchmarks/huff-feasibility/replay.py --variant single-hop
python benchmarks/huff-feasibility/replay.py --variant indexed-paths
```

The script creates a separate worktree at the pinned production baseline, applies the selected source/test patch, initializes the pinned dependencies, builds the Yul artifact, and runs the validation and 10,000-case fuzz tests. It explicitly enables isolated transactions and checks the recorded matrix gas values. Evidence goes to a new directory under `~/Documents`; the temporary worktree is removed afterward. `--output PATH` selects a new evidence directory.

`manifest.json` pins artifact checksums and provenance. Huff is the creation bytecode in [the recorded Ethereum deployment](https://github.com/EkuboProtocol/huff-router/blob/a8eb3f888dee82a840810cef0cd57799e17815ff/contracts/broadcast/HuffRouter.s.sol/1/run-latest.json), not a fresh compilation of Huff main. Its 224-entry token table matches the repository's table within that artifact. Core is pinned to `de94c77a665c54f4c848185872b8a55b2c28c1bc`. The baseline JSON preserves Yul's immutable layout so the failure-reference runtime can be placed at the same test address.

`experiments.json` retains the original two-case measurements from the optimization probes. Those rows use different fixture/encoding modes as the investigation progressed; use the paired Huff/Yul values within each row, not an unqualified comparison across rows. The selected matrix JSON files and validation logs are the evidence for the conclusions above.
