import { describe, expect, it } from "bun:test";
import worker from "../src/index.js";
import { publicToolCatalog } from "../src/server.js";

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ALLOWED_HOSTNAMES: "mcp.ekubo.org",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

describe("Worker discovery", () => {
  it("publishes root metadata, OpenAPI, and a deterministic tool catalog", async () => {
    const root = await worker.fetch(
      new Request("https://mcp.ekubo.org/"),
      env,
      context,
    );
    const metadata = (await root.json()) as {
      mcp_endpoint: string;
      authentication: string;
    };
    expect(metadata.mcp_endpoint).toBe("https://mcp.ekubo.org/mcp");
    expect(metadata.authentication).toBe("none");

    const tools = await worker.fetch(
      new Request("https://mcp.ekubo.org/tools"),
      env,
      context,
    );
    const catalog = (await tools.json()) as { tools: typeof publicToolCatalog };
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "ekubo_search_tokens",
      "ekubo_get_token",
      "ekubo_get_quote",
      "ekubo_prepare_swap",
    ]);

    const spec = await worker.fetch(
      new Request("https://mcp.ekubo.org/openapi.json"),
      env,
      context,
    );
    const document = (await spec.json()) as {
      openapi: string;
      paths: Record<string, { post?: unknown }>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/mcp"].post).toBeDefined();
  });

  it("serves protocol-native MCP initialization and tool discovery", async () => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "mcp.ekubo.org",
      origin: "https://mcp.ekubo.org",
    };
    const initialized = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "ekubo-test", version: "1.0.0" },
          },
        }),
      }),
      env,
      context,
    );
    expect(initialized.status).toBe(200);
    const initializeResult = (await mcpJson(initialized)) as {
      result: { capabilities: { tools?: unknown } };
    };
    expect(initializeResult.result.capabilities.tools).toBeDefined();

    const listed = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      }),
      env,
      context,
    );
    expect(listed.status).toBe(200);
    const listResult = (await mcpJson(listed)) as {
      result: { tools: { name: string }[] };
    };
    expect(listResult.result.tools.map((tool) => tool.name)).toEqual(
      publicToolCatalog.map((tool) => tool.name),
    );
  });

  it("rejects browser origins outside the explicit allowlist", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: "mcp.ekubo.org",
          origin: "https://example.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "blocked-test", version: "1.0.0" },
          },
        }),
      }),
      env,
      context,
    );

    expect(response.status).toBe(403);
  });
});

async function mcpJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  if (data === undefined) throw new Error(`MCP stream had no data: ${body}`);
  return JSON.parse(data);
}
