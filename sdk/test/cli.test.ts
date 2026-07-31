import { afterAll, describe, expect, it } from "bun:test";

const native = {
  chain_id: "0x1",
  name: "Ether",
  symbol: "ETH",
  decimals: 18,
  address: "0x0000000000000000000000000000000000000000",
  visibility_priority: 3,
  usd_price: 2_000,
};
const usdc = {
  chain_id: "0x1",
  name: "USDC",
  symbol: "USDC",
  decimals: 6,
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  visibility_priority: 3,
  usd_price: 1,
};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/tokens") {
      const search = url.searchParams.get("search")?.toUpperCase();
      return Response.json(search === "ETH" ? [native] : [usdc]);
    }
    if (url.pathname === "/1/v1/quote") {
      expect(request.method).toBe("GET");
      expect(url.searchParams.get("token_in")).toBe(native.address);
      expect(BigInt(url.searchParams.get("token_out")!)).toBe(BigInt(usdc.address));
      expect(url.searchParams.get("quote_type")).toBe("exact_input");
      const amount = url.searchParams.get("amount")!;
      return Response.json({
        schema_version: "1",
        quote_type: "exact_input",
        token_in: native.address,
        token_out: usdc.address,
        amount_in: amount,
        amount_out: "200000000",
        block_number: 123,
        block_hash: "0x01",
        estimated_gas_cost: 25_000,
        price_impact: 0.001,
        splits: [
          {
            amount_specified: amount,
            amount_calculated: "200000000",
            route: [
              {
                swap: {
                  type: "core",
                  pool_key: {
                    token0: native.address,
                    token1: usdc.address,
                    config: `0x${"00".repeat(32)}`,
                  },
                  sqrt_ratio_limit: "0x000000000000000000000000",
                  skip_ahead: 0,
                },
              },
            ],
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("ekubo-swap CLI", () => {
  it("resolves tokens and emits a confirmation-gated unsigned plan", async () => {
    const baseUrl = server.url.toString().replace(/\/$/, "");
    const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
    const process = Bun.spawn(
      [
        "node",
        cliPath,
        "prepare",
        "--chain-id",
        "1",
        "--token-in",
        "ETH",
        "--token-out",
        "USDC",
        "--type",
        "exact-input",
        "--amount",
        "0.1",
        "--slippage-bps",
        "25",
        "--api-url",
        baseUrl,
        "--quoter-url",
        baseUrl,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.requires_user_confirmation).toBe(true);
    expect(output.tokens.input.symbol).toBe("ETH");
    expect(output.tokens.output.symbol).toBe("USDC");
    expect(output.quote.amount_in).toBe("100000000000000000");
    expect(BigInt(output.quote.minimum_amount_out)).toBeGreaterThan(0n);
    expect(output.simulation.status).toBe("not_run");
    expect(output.transaction.data).toStartWith("0x");
    expect(output.plan_id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
