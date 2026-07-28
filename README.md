# Ekubo Yul Router

Gas-focused Yul router for Ekubo EVM swaps.

The router deliberately carries token addresses, pool configs, extension forwardee addresses, and token wrapper addresses in calldata. It does not use token or extension jump tables, does not expose fee claiming, and rejects delegatecall execution by checking an immutable self address appended at deployment.

## Calldata

The SDK emits custom packed swap calldata directly, without a public router selector. Non-Core calls are interpreted as
route data unless they use the standard `quote(bytes)` selector. Calls from Ekubo Core are reserved for the lock callback
selector `0x00000000` and forward callback selector `0x00000001`.

The primary SDK surface is `encodeRoutes(...)` / `generateCalldata(...)`, which accepts `multiHops: MultiHop[]`. Each
multi-hop has its own specified amount and sequence of hops, all starting from the same `specifiedToken` and ending at
the same `calculatedToken`. The router executes every multi-hop under one Core lock, aggregates the specified/calculated
amounts, applies one slippage check, and settles once.

The same route data can be passed through `Core.forward(router, routeData)` by an existing locker. In this mode the
router executes the route and applies its slippage check, but deliberately does not settle. It returns
`(address specifiedToken, address calculatedToken, int256 specifiedAmount, int256 calculatedAmount)`. The endpoint debt
changes left on the shared lock are `specifiedAmount` and `-calculatedAmount`, respectively. This lets a caller combine a
routed swap with another atomic operation, such as adding liquidity, before settling the net result. Any recipient
encoded in the route is ignored in forwarded mode because the original locker owns settlement.

`quote(bytes routeData)` executes that same packed route inside a Core lock, then deliberately reverts from the lock
callback with a recognized result payload. The public entrypoint catches only that payload and returns
`(address specifiedToken, address calculatedToken, int256 specifiedAmount, int256 calculatedAmount)`. Pool and extension
state changes are rolled back, no token balance or approval is required, and unrelated route or extension errors are
bubbled unchanged. Downstream call failures are internally wrapped while crossing the lock callback and unwrapped by the
public entrypoint, preventing a pool or extension from impersonating the router's result payload. The SDK exposes
`encodeQuoteCalldata(routeData)` and `generateQuoteCalldata(...)` for this entrypoint.

Direct packed-calldata swaps return the same four-word tuple after settlement. Thus direct execution, forwarding, and
quoting have byte-for-byte identical result data for the same route and starting state. Amount signs retain the existing
route convention: exact-input amounts are positive and exact-output amounts are negative.

Every route must provide `calculatedAmountThreshold`: a positive minimum output
for exact-in or a negative maximum input for exact-out. Omitting it throws
instead of encoding an unbounded slippage threshold. Passing the boolean
`false` explicitly opts into the legacy unbounded threshold (`0n` for exact-in
or the signed `int128` minimum for exact-out).

Core and forwarded swap hops accept an optional `allowPartial` flag. When
enabled, the router accounts for the amount actually swapped instead of
requiring the specified amount to be fully filled. This is generic settlement
validation rather than a distinct swap type. It is intentionally limited to
single-hop paths, so a partial fill cannot strand debt in an intermediate
token. Exact-input fills must remain between zero and the positive requested
input; exact-output fills must remain between the negative requested output and
zero. Other independent paths may still be included in the same aggregated
route.

A caller that wants to move a pool to a target price uses a normal partial
exact-output swap with `specifiedAmount = type(int128).min` and the target as
its `sqrtRatioLimit`. The price limit normally stops the otherwise unfillable
request, and the router reports the actual specified and calculated amounts.
The same pattern can move an initialized pool with no liquidity directly to its
`sqrtRatioLimit`: Core returns zero token amounts, and a forwarded route reports
zero endpoint amounts for the caller to combine with a subsequent liquidity
deposit.

`encodeSignedSwapMeta(...)` requires its `nonce` as a `bigint`. JavaScript
`number` values are rejected so uint64 nonces above the safe-integer range
cannot be rounded before encoding.

The SDK exports `YUL_ROUTER_ADDRESS` for the deterministic router deployment address.

`encodeRoute(...)` remains as a convenience wrapper for a single multi-hop path.

Supported hop types:

- `core`: direct `Core.swap_6269342730()` using the provided pool key. This works for arbitrary pools whose extension
  permits the normal Core swap path; Core dispatches the pool's configured hooks.
- `forwarded`: `Core.forward(forwardee, abi.encode(poolKey, params))` for arbitrary forward-only swap implementations
  that use the standard payload and return a `PoolBalanceUpdate` as their first ABI word. The forwardee address is
  carried in each hop rather than hard-coded in the router; current examples include MEV Capture and Ve33. The SDK
  defaults `forwardee` to the extension encoded in `poolKey.config` and allows overriding it to use an adapter.
- `signedExclusiveSwap`: `Core.forward(forwardee, abi.encode(poolKey, params, meta, minBalanceUpdate, signature))` for SignedExclusiveSwap pools.
- `wrapper`: `Core.forward(wrapper, abi.encode(int256 amount))` for Ekubo token wrappers.

Not supported by design:

- delegatecall routing
- protocol or integration fee collection

Constructor argument:

- `core: address`

## Deployment

The Foundry deploy script uses the canonical Ekubo Core address
`0x00000000000014aA86C5d3c41765bb24e11bd701` and deploys through the canonical deterministic deployer
`0x4e59b44847b379578588920cA78FbF26c0B4956C`.

`SALT` is optional and defaults to `bytes32(0)`. The script prints the deployer, salt, init code hash, and expected
address before broadcasting so the salt can be mined externally.

```sh
forge build
SALT=0x0000000000000000000000000000000000000000000000000000000000000000 forge script script/DeployYulRouter.s.sol --rpc-url $RPC_URL --broadcast
```

## SDK release

The manually triggered `Release SDK` GitHub Actions workflow deploys the
deterministic router, verifies every deployment, updates the SDK address and
package version, commits the deployment records under `broadcast/`, publishes
the package to npm, and creates a tagged GitHub release.

The default networks are listed one per line in
`script/release/alchemy-networks.txt`. To add an EVM chain, add its Alchemy RPC
URL prefix identifier; for example, `opt-mainnet` resolves to
`https://opt-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>`.

Configure these secrets in the protected `release` GitHub environment:

- `ALCHEMY_API_KEY`: an Alchemy API key enabled for every configured network.
- `DEPLOYER_PRIVATE_KEY`: a deployment account funded with native gas on every
  configured network.

Configure npm trusted publishing for `@ekubo/yul-router-sdk` with:

- provider: GitHub Actions
- organization: `EkuboProtocol`
- repository: `yul-router`
- workflow filename: `release.yml`
- environment: `release`
- allowed action: `npm publish`

The workflow uses GitHub OIDC to obtain a short-lived npm publishing credential,
so no `NPM_TOKEN` secret is required. npm generates package provenance
automatically for this trusted publication.

The repository must also allow GitHub Actions to write repository contents, and
the `main` branch rules must permit this release workflow to push its generated
commit and annotated tag. Protect the `release` environment with the desired
reviewers so deployment and publishing require approval.

Run the workflow from `main` with an exact semantic version such as `0.5.0`.
Before sending transactions it verifies that every network has the canonical
Core and deterministic deployer. After all deployments,
`script/release/verify-deployments.mjs` requires a fresh record for every
configured network and verifies that all router addresses match. For a newly
sent deployment it also checks the normalized record against the copied raw
Foundry broadcast. For a router that was already
deployed, it creates a fresh record from the script return value rather than
reusing a stale `run-latest.json`. A successful Forge script is authoritative;
the release does not perform a post-deployment runtime-code lookup. Only the
one address emitted by this all-chain verification is written to the SDK.

## Production quote integration

CI requests live mainnet quotes from `https://prod-api-quoter.ekubo.org`, converts every split and hop to router
calldata with this repository's SDK, and executes the calldata against canonical Ekubo Core at the exact block
identified by each quote's block number and hash. It also checks that the router's calculated amount differs from the
production quote by no more than 0.1%. The cases cover ETH to ERC20, ERC20 to ETH, exact output, and ERC20 to ERC20
swaps.

The CI job uses `https://ethereum-rpc.publicnode.com` by default. Set the `MAINNET_RPC_URL` repository secret to use a
dedicated endpoint. Run the same check locally with:

```sh
cd sdk && bun install --frozen-lockfile && cd ..
forge build
forge script script/ProductionQuotesIntegration.s.sol -vvv
```

The script uses `MAINNET_RPC_URL` when set and otherwise falls back to `https://ethereum-rpc.publicnode.com`.
