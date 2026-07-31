import { createMcpHandler } from "agents/mcp/server";
import openapi from "../openapi.json";
import type { Env } from "./core.js";
import { createEkuboServer, publicToolCatalog } from "./server.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const limited = await rateLimit(request, env);
      if (limited !== null) return limited;

      const requestOrigin = request.headers.get("origin");
      const handler = createMcpHandler(() => createEkuboServer(env), {
        route: "/mcp",
        allowedHostnames: commaSeparatedHostnames(
          env.ALLOWED_HOSTNAMES ?? "mcp.ekubo.org,localhost,127.0.0.1",
        ),
        corsOptions: {
          origin: requestOrigin ?? "https://mcp.ekubo.org",
          methods: "GET, POST, OPTIONS",
          headers:
            "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
          exposeHeaders: "mcp-session-id, mcp-protocol-version",
          maxAge: 86400,
        },
        allowedOriginHostnames: allowedOriginHostnames(env),
      });
      return withSecurityHeaders(await handler(request, env, ctx));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        { error: { code: "method_not_allowed", message: "Use GET" } },
        405,
        { Allow: "GET, HEAD" },
      );
    }

    switch (url.pathname) {
      case "/":
        return json(
          {
            name: "Ekubo Protocol MCP",
            description:
              "Public, unauthenticated, read-only agent tools for token discovery, route quotes, calldata preparation, and simulation",
            version: "0.1.0",
            mcp_endpoint: `${url.origin}/mcp`,
            mcp_transport: "streamable-http",
            authentication: "none",
            tools_url: `${url.origin}/tools`,
            openapi_url: `${url.origin}/openapi.json`,
            llms_txt_url: `${url.origin}/llms.txt`,
            upstream_openapi: {
              data_api: "https://prod-api.ekubo.org/openapi.json",
              quoter: "https://prod-api-quoter.ekubo.org/openapi.json",
            },
            safety: {
              signs_transactions: false,
              submits_transactions: false,
              requires_user_confirmation: true,
            },
          },
          200,
          cacheHeaders(300),
        );
      case "/health":
        return json({ status: "ok" }, 200, { "cache-control": "no-store" });
      case "/tools":
        return json(
          { tools: publicToolCatalog },
          200,
          cacheHeaders(3600),
        );
      case "/openapi.json":
        return json(openapi, 200, cacheHeaders(3600));
      case "/llms.txt":
        return text(llmsText(url.origin), "text/plain; charset=utf-8", 3600);
      case "/robots.txt":
        return text(
          "User-agent: *\nAllow: /\n",
          "text/plain; charset=utf-8",
          86400,
        );
      default:
        return json(
          {
            error: {
              code: "route_not_found",
              message: "See /, /tools, /openapi.json, or /mcp",
            },
          },
          404,
        );
    }
  },
} satisfies ExportedHandler<Env>;

async function rateLimit(request: Request, env: Env): Promise<Response | null> {
  if (env.RATE_LIMITER === undefined || request.method === "OPTIONS") {
    return null;
  }
  const actor = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const { success } = await env.RATE_LIMITER.limit({ key: `mcp:${actor}` });
  return success
    ? null
    : json(
        {
          error: {
            code: "rate_limited",
            message: "Too many MCP requests; retry later",
          },
        },
        429,
        { "retry-after": "60" },
      );
}

function allowedOriginHostnames(env: Env): string[] {
  return commaSeparatedHostnames(
    env.ALLOWED_ORIGINS ?? "https://mcp.ekubo.org",
    true,
  );
}

function commaSeparatedHostnames(value: string, parseOrigins = false): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (parseOrigins ? new URL(entry).hostname : entry));
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return withSecurityHeaders(
    Response.json(body, {
      status,
      headers: {
        "access-control-allow-origin": "*",
        ...headers,
      },
    }),
  );
}

function text(body: string, contentType: string, maxAge: number) {
  return withSecurityHeaders(
    new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": `public, max-age=${maxAge}`,
        "access-control-allow-origin": "*",
      },
    }),
  );
}

function withSecurityHeaders(response: Response) {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}

function cacheHeaders(maxAge: number) {
  return { "cache-control": `public, max-age=${maxAge}` };
}

function llmsText(origin: string) {
  return `# Ekubo Protocol agent API

MCP endpoint: ${origin}/mcp
Transport: Streamable HTTP
Authentication: none
Tool catalog: ${origin}/tools
OpenAPI: ${origin}/openapi.json
Canonical data API OpenAPI: https://prod-api.ekubo.org/openapi.json
Canonical quoter OpenAPI: https://prod-api-quoter.ekubo.org/openapi.json

Safe swap sequence:
1. Use ekubo_search_tokens and reject ambiguous symbols.
2. Convert the amount to base units using token decimals.
3. Use ekubo_get_quote or ekubo_prepare_swap with explicit input/output intent.
4. Choose slippage before generating calldata.
5. Only treat a plan as ready when confirmation_ready is true.
6. Show the exact plan ID, bounds, approval, recipient, and transaction to the user.
7. Require explicit confirmation. This server never signs or submits.
`;
}
