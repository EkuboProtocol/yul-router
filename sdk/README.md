# @ekubo/yul-router-sdk

Builds the packed swap calldata for the [Ekubo](https://ekubo.org) Yul Router on EVM chains,
and the calldata for reading a price quotation for that same route.

The router takes custom packed calldata rather than a conventional ABI-encoded function call.
This SDK is what produces those bytes: you describe a route as a list of hops, and it returns
the `0x…` calldata to send to the router address.

## Installation

```sh
npm install @ekubo/yul-router-sdk
# or
bun add @ekubo/yul-router-sdk
```

`viem` is a peer dependency.

## Constructing a swap transaction

`encodeRoutes(...)` / `generateCalldata(...)` take a set of multi-hops and return the calldata
for the swap. Every multi-hop starts from the same `specifiedToken` and ends at the same
`calculatedToken`; the router executes them all under one Core lock, aggregates the amounts,
applies a single slippage check, and settles once.

```ts
import { generateCalldata, YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";

const data = generateCalldata({
  multiHops: [
    {
      specifiedAmount: 10n ** 18n,
      hops: [{ poolKey, sqrtRatioLimit: MIN_SQRT_RATIO }],
    },
  ],
  specifiedToken: tokenIn,
  calculatedToken: tokenOut,
  calculatedAmountThreshold: minimumOut, // required; guards slippage
  recipient,
});

// Send with any EVM client:
await walletClient.sendTransaction({ to: YUL_ROUTER_ADDRESS, data, value });
```

`calculatedAmountThreshold` is mandatory — a positive minimum output for exact-input routes, a
negative maximum input for exact-output. Omitting it throws rather than silently encoding an
unbounded slippage threshold.

Exact-input amounts are positive; exact-output amounts are negative.

## Obtaining a price quotation

`generateQuoteCalldata(...)` / `encodeQuoteCalldata(...)` produce the calldata for the router's
`quote(bytes)` entrypoint, which runs the identical route inside a Core lock and returns the
resulting amounts without settling. No token balance and no approval are required, and all pool
and extension state changes are rolled back.

```ts
import { generateQuoteCalldata } from "@ekubo/yul-router-sdk";

const data = generateQuoteCalldata({ multiHops, specifiedToken, calculatedToken });
const { data: result } = await publicClient.call({ to: YUL_ROUTER_ADDRESS, data });
// decodes to (specifiedToken, calculatedToken, specifiedAmount, calculatedAmount)
```

Direct execution, forwarding, and quoting all return the same four-word tuple for the same route
and starting state, so a quotation and the swap built from it stay byte-for-byte comparable.

## Hop types

| Hop | Use |
|---|---|
| `CoreHop` | A swap against an Ekubo Core pool |
| `ForwardedHop` | A swap routed through an extension's forward callback |
| `SignedExclusiveSwapHop` | A swap filled against a signed exclusive quote |
| `WrapperHop` | A token wrap or unwrap step |

## Also exported

- `encodeRoute(...)` — encode a single route body
- `encodeSignedSwapMeta(...)` — encode the metadata for a signed exclusive swap
- `encodePoolBalanceUpdate(...)` — encode a pool balance delta
- `calldataSize(...)` — byte length of encoded calldata
- `YUL_ROUTER_ADDRESS`, `YUL_ROUTER_ABI`, and the sqrt-ratio and threshold bounds

## License

See the [repository](https://github.com/EkuboProtocol/yul-router).
