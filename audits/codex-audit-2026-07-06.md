# Codex Audit - 2026-07-06

## Scope

- Repository: `yul-router`
- Commit audited: `04d29c4ac7993b61aedbabe33f0a3c52d77a101c`
- Primary router source: `src/YulRouter.yul`
- SDK encoder reviewed for intended calldata shape: `sdk/src/index.ts`
- Core accounting dependency reviewed from installed `evm-contracts`: `lib/evm-contracts/src/base/FlashAccountant.sol` and `lib/evm-contracts/src/Core.sol`

This was a focused manual audit of the Yul router under the explicit assumption that the external caller can arbitrarily choose the calldata sent to the router. The most important invariants reviewed were:

1. ERC20 allowances can only be spent with `from == msg.sender` of the original router call.
2. If a specified slippage tolerance is not met, the transaction reverts.

## Summary

No critical or high severity issues were found for the two requested invariants.

The allowance-spend invariant holds in the reviewed code: the only router-generated ERC20 `transferFrom` uses the `payer` value appended by the router itself from the original external `caller()`, not a calldata-supplied address. Direct callback spoofing is blocked because only Core can enter the callback branch, Core `forward` to the router is rejected, and delegatecall execution is rejected.

The slippage invariant holds for the router's encoded `calculatedAmountThreshold`: all multi-hop calculated amounts are aggregated, the threshold sign is checked against the exact-in/exact-out mode when any nonzero specified amount exists, and `SlippageCheckFailed(int256)` is raised before settlement when `totalCalculated < threshold`.

## Threat Model Notes

- The caller controls route bytes, token addresses, pool configs, recipients, wrapper addresses, and forwardee addresses.
- Arbitrary forwardees can execute during `Core.forward`, but Core debt accounting must be zero at the end of the lock. Any unbalanced third-token debt causes the whole transaction to revert.
- This audit treats standard ERC20 semantics as the relevant allowance-spend model. A malicious token contract can lie in `balanceOf`, reenter, or implement nonstandard transfer behavior for that token; that does not give the router a path to spend an unrelated honest token allowance from a non-caller.
- User-controlled `recipient` is intentional. It can redirect outputs for the current transaction, but it is not used as an ERC20 `transferFrom` source.

## Invariant A: Allowances Only Spent From `msg.sender`

Status: passed.

### Evidence

External, non-Core calls always enter `lock(core)` in `src/YulRouter.yul`. Before calling `Core.lock`, the router copies the original calldata route and appends two words that the user cannot place after: the original `caller()` and `callvalue()`.

Relevant source:

- `src/YulRouter.yul:40` enters `lock(core)` for non-Core callers.
- `src/YulRouter.yul:46-49` builds `Core.lock()` calldata as `[route][caller()][callvalue()]`.
- `lib/evm-contracts/src/base/FlashAccountant.sol:146-164` calls the original locker, here the router, with selector `0x00000000`, lock id, and the copied route suffix.
- `src/YulRouter.yul:65-67` reads `payer` and `nativeRemaining` from the appended suffix, with `routeEnd = calldatasize() - 0x40`.
- `src/YulRouter.yul:243-245` requires parsing to consume exactly the route bytes before the appended suffix.

The only ERC20 `transferFrom` emitted by the router is in `payErc20`:

- `src/YulRouter.yul:257-258` settles only `specifiedToken` and `calculatedToken`.
- `src/YulRouter.yul:380-390` sends positive signed settlement amounts through `pay(...)`.
- `src/YulRouter.yul:394-410` dispatches ERC20 payments to `payErc20(coreAddress, payer, token, amount)`.
- `src/YulRouter.yul:421-424` encodes `transferFrom(payer, coreAddress, amount)`.

Because `payer` is the original external `caller()` appended by router code immediately before the Core lock, calldata cannot set `payer` to a victim address. Fake payer bytes included by a caller are just route bytes; if they are not valid route data, parsing reverts, and if they are valid route data, the real payer suffix remains after them.

### Callback Spoofing Review

The callback branch is not externally reachable with arbitrary calldata:

- `src/YulRouter.yul:27-38` only accepts callback selectors when `caller() == core`.
- `src/YulRouter.yul:29-31` accepts selector `0x00000000` only as the Core lock callback.
- `src/YulRouter.yul:32-34` rejects selector `0x00000001`, which is the Core forward callback selector.
- `lib/evm-contracts/src/base/FlashAccountant.sol:190-220` shows `Core.forward(address)` calls the forwardee with selector `0x00000001`.
- `src/YulRouter.yul:23-25` rejects delegatecall by comparing the immutable deployed self address with `address()`.

Therefore an attacker cannot call Core in a way that makes the router process attacker-chosen callback calldata while preserving a victim payer suffix. `Core.forward(router, ...)` reaches selector `0x00000001` and reverts with `ForwardNotAllowed()`.

### Native Token Path

The native token path follows the same original-caller binding:

- `src/YulRouter.yul:48-49` appends original caller and original `msg.value`.
- `src/YulRouter.yul:397-408` pays native token debt only from the appended `nativeRemaining`.
- `src/YulRouter.yul:260-264` refunds remaining native token only to `payer`.

No native path can pull value from a third party.

## Invariant B: Slippage Tolerance Reverts When Not Met

Status: passed.

### Evidence

The router aggregates calculated amounts from every multi-hop before settlement:

- `src/YulRouter.yul:93-96` initializes `totalSpecified`, `totalCalculated`, and exact-output tracking.
- `src/YulRouter.yul:98-121` iterates all multi-hops and enforces that nonzero multi-hop specified amounts are consistently exact-in or exact-out.
- `src/YulRouter.yul:123-234` executes each hop.
- `src/YulRouter.yul:236-240` requires each multi-hop to end at `calculatedToken` and adds the final `currentAmount` into `totalCalculated`.

The threshold is checked before any final settlement transfer:

- `src/YulRouter.yul:247-249` rejects a nonzero threshold whose sign does not match the exact-in/exact-out mode when a nonzero specified amount exists.
- `src/YulRouter.yul:251-255` reverts with `SlippageCheckFailed(int256)` when `totalCalculated < threshold`.
- `src/YulRouter.yul:257-258` performs ERC20/native payment and output withdrawal only after the slippage check.

For exact-in routes, `totalCalculated` is the output amount and the threshold is a minimum output. If output is below the threshold, `totalCalculated < threshold` is true and the transaction reverts.

For exact-out routes, `totalCalculated` is negative and represents the input paid. The threshold is also negative and represents the maximum acceptable input as a lower bound in signed space. If the route requires more input than allowed, for example `-120 < -100`, the transaction reverts.

The SDK mirrors this interpretation:

- `sdk/src/index.ts:201-208` defaults the threshold and rejects a threshold sign that conflicts with the route's exact-in/exact-out mode.
- `sdk/src/index.ts:210-220` encodes the threshold into the router header.

### Ordering

The slippage check occurs after swaps/forwards have executed in the Core lock but before router settlement. If the check fails, the revert unwinds all Core state changes and external token transfers in the transaction. This satisfies the requested invariant for a failed tolerance check.

## Findings

### No Critical or High Findings

No path was identified where arbitrary calldata lets a caller spend ERC20 allowance from any address other than the original router caller. No path was identified where a missed `calculatedAmountThreshold` can settle successfully.

### Informational: Add Direct Invariant Tests for Arbitrary Calldata

The current Foundry tests cover successful core, Ve33, wrapper, multi-multihop, SDK-generated routes, delegatecall rejection, Core forward rejection, and the absence of the old fee-claiming surface. They do not directly assert the two audit invariants under adversarial calldata.

Recommended tests:

- A malicious caller supplies bytes that try to append or embed a victim address as a fake payer while the victim has approved the router. Assert the victim balance and allowance are unchanged and the transaction cannot spend from the victim.
- A route with a deliberately impossible exact-in output threshold reverts with `SlippageCheckFailed(int256)` and does not spend caller allowance.
- A route with a deliberately impossible exact-out input threshold reverts and does not spend caller allowance.
- A route using an arbitrary forwardee that attempts to create extra debt in a third token reverts due to nonzero Core debt.

These tests would strengthen regression coverage for the manually reviewed invariants, but their absence is not itself an invariant failure in the reviewed implementation.

## Verification Performed

Manual review was performed over:

- `src/YulRouter.yul`
- `sdk/src/index.ts`
- `test/YulRouter.t.sol`
- `lib/evm-contracts/src/base/FlashAccountant.sol`
- relevant portions of `lib/evm-contracts/src/Core.sol`

Commands run after adding this report:

```sh
forge test
cd sdk && bun run test
```

Results:

- `forge test`: passed. Foundry reported 9 passed, 0 failed, 0 skipped. It also emitted the existing Yul parser diagnostic `error: expected identifier, found <string>` for `src/YulRouter.yul:1:8`, but the command exited successfully and ran the suite.
- `cd sdk && bun run test`: passed. Bun reported 9 passed, 0 failed across `sdk/test/index.test.ts`.
