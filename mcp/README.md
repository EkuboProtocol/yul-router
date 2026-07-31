# Ekubo MCP Worker

Stateless Cloudflare Worker for `https://mcp.ekubo.org`.

## Public endpoints

- `POST/GET /mcp` — MCP Streamable HTTP endpoint
- `GET /` — service metadata and canonical documentation links
- `GET /tools` — deterministic tool catalog for non-MCP discovery
- `GET /openapi.json` — OpenAPI 3.1 discovery contract
- `GET /llms.txt` — concise agent workflow
- `GET /health` — Worker liveness

MCP-native discovery remains authoritative: clients use `tools/list` and
`resources/list`. The HTTP discovery endpoints are additive and help crawlers,
OpenAPI clients, and humans find the same capabilities.

## Tools

- `ekubo_search_tokens` — search the canonical token list
- `ekubo_get_token` — fetch token metadata by chain and address
- `ekubo_get_quote` — translate explicit EVM intent to the canonical signed
  quoter URL and return its block-pinned route
- `ekubo_prepare_swap` — quote, generate slippage-protected unsigned Yul
  router calldata, and simulate when an allowlisted RPC is configured

Every tool is read-only and idempotent. The Worker has no wallet, key material,
signing function, or broadcast function.

## Configuration

`wrangler.jsonc` configures the two fixed public upstreams:

- `EKUBO_API_URL=https://prod-api.ekubo.org`
- `EKUBO_QUOTER_URL=https://prod-api-quoter.ekubo.org`

Never make either URL a tool argument. Keeping upstreams operator-controlled
prevents the public Worker from becoming an SSRF or arbitrary RPC proxy.

Set allowlisted per-chain RPC URLs as an encrypted Worker secret:

```sh
wrangler secret put RPC_URLS_JSON
```

The value is a JSON object such as:

```json
{"1":"https://...","8453":"https://..."}
```

Without a configured RPC, `ekubo_prepare_swap` still returns unsigned calldata
but sets `confirmation_ready` to false. Agents must not present such a plan for
submission until it has been simulated successfully.

Request hosts are restricted by `ALLOWED_HOSTNAMES`, and browser origins are
restricted by `ALLOWED_ORIGINS`. Non-browser MCP clients normally omit
`Origin` and remain compatible. Add trusted deployment hosts and browser MCP
client origins to the corresponding comma-separated Worker variables when
required.

For production abuse protection, add a Cloudflare Workers Rate Limiting
binding named `RATE_LIMITER` or enforce an equivalent account-level rule. The
Worker automatically uses that binding when present and returns HTTP 429 after
the configured limit. See the [Cloudflare Rate Limiting binding
documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Development

Build the SDK first because this package consumes it through a local file
dependency:

```sh
bun --cwd ../sdk install
bun --cwd ../sdk run build
bun install
bun run build
bun run test
bun run check
bun run dev
```

Connect MCP Inspector to `http://localhost:8787/mcp`.

## Deployment

The Worker configuration declares `mcp.ekubo.org` as a custom domain. Deploy
from an authenticated Cloudflare environment:

```sh
bun run deploy
```

The implementation uses the recommended stateless `createMcpHandler` path and
does not require Durable Objects. Authorization is intentionally omitted
because all tools operate on public data and cannot mutate protocol or user
state. If write-capable tools are ever introduced, they should use a separate
authenticated server and must not be added to this endpoint.
