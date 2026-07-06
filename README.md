# Ekubo Yul Router

Gas-focused Yul router for Ekubo EVM swaps.

The router deliberately carries token addresses, pool configs, extension forwardee addresses, and token wrapper addresses in calldata. It does not use token or extension jump tables, does not expose fee claiming, rejects Core `forward` calls to itself, and rejects delegatecall execution by checking an immutable self address appended at deployment.

## Calldata

The SDK emits custom packed calldata directly, without a public router selector. Non-Core calls are interpreted as route
data. Calls from Ekubo Core are reserved for the lock callback selector `0x00000000` and forward callback selector
`0x00000001`; the forward callback always reverts.

The primary SDK surface is `encodeRoutes(...)` / `generateCalldata(...)`, which accepts `multiHops: MultiHop[]`. Each
multi-hop has its own specified amount and sequence of hops, all starting from the same `specifiedToken` and ending at
the same `calculatedToken`. The router executes every multi-hop under one Core lock, aggregates the specified/calculated
amounts, applies one slippage check, and settles once.

`encodeRoute(...)` remains as a convenience wrapper for a single multi-hop path.

Supported hop types:

- `core`: direct `Core.swap_6269342730()` using the provided pool key.
- `forwarded`: `Core.forward(forwardee, abi.encode(poolKey, params))` for MEV-capture-compatible forwarded swap extensions.
- `ve33`: `Core.forward(forwardee, abi.encode(uint256(0), poolKey, params))` for Ve33-compatible pools that prefix forwarded swap data with a call type.
- `wrapper`: `Core.forward(wrapper, abi.encode(int256 amount))` for Ekubo token wrappers.

Not supported by design:

- delegatecall routing
- routing through `Core.forward(router, ...)`
- protocol or integration fee collection

Constructor argument:

- `core: address`

## Deployment

The Foundry deploy script uses the canonical Ekubo Core address
`0x00000000000014aA86C5d3c41765bb24e11bd701`.

```sh
forge build
forge script script/DeployYulRouter.s.sol --rpc-url $RPC_URL --broadcast --verify
```
