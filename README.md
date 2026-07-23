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

Every route must provide `calculatedAmountThreshold`: a positive minimum output
for exact-in or a negative maximum input for exact-out. Omitting it throws
instead of encoding an unbounded slippage threshold. Passing the boolean
`false` explicitly opts into the legacy unbounded threshold (`0n` for exact-in
or the signed `int128` minimum for exact-out).

`encodeSignedSwapMeta(...)` requires its `nonce` as a `bigint`. JavaScript
`number` values are rejected so uint64 nonces above the safe-integer range
cannot be rounded before encoding.

The SDK exports `YUL_ROUTER_ADDRESS` for the deterministic router deployment address.

`encodeRoute(...)` remains as a convenience wrapper for a single multi-hop path.

Supported hop types:

- `core`: direct `Core.swap_6269342730()` using the provided pool key.
- `forwarded`: `Core.forward(forwardee, abi.encode(poolKey, params))` for forward-only swap extensions such as MEV Capture and Ve33.
- `signedExclusiveSwap`: `Core.forward(forwardee, abi.encode(poolKey, params, meta, minBalanceUpdate, signature))` for SignedExclusiveSwap pools.
- `wrapper`: `Core.forward(wrapper, abi.encode(int256 amount))` for Ekubo token wrappers.

Not supported by design:

- delegatecall routing
- routing through `Core.forward(router, ...)`
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
configured network and verifies that all router addresses and runtime code
hashes match. For a newly sent deployment it also checks the normalized record
against the copied raw Foundry broadcast. For a router that was already
deployed, it creates a fresh record from the script return value and current
on-chain code rather than reusing a stale `run-latest.json`. Only the one
address emitted by this all-chain verification is written to the SDK.

## Production quote integration

CI requests live mainnet quotes from `https://prod-api-quoter.ekubo.org`, converts every split and hop to router
calldata with this repository's SDK, deploys the router locally, and executes the calldata against canonical Ekubo Core
on a mainnet fork. The cases cover ETH to ERC20, ERC20 to ETH, exact output, and ERC20 to ERC20 swaps.

The CI job uses `https://ethereum-rpc.publicnode.com` by default. Set the `MAINNET_RPC_URL` repository secret to use a
dedicated endpoint. Run the same check locally with:

```sh
cd sdk && bun install --frozen-lockfile && cd ..
forge build
forge script script/ProductionQuotesIntegration.s.sol --fork-url "${MAINNET_RPC_URL:-https://ethereum-rpc.publicnode.com}" -vvv
```
