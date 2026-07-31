import { describe, expect, it } from "bun:test";
import { YUL_ROUTER_ABI } from "@ekubo/yul-router-sdk";
import { encodeFunctionResult } from "viem";
import { type Env, getQuote, prepareSwap } from "../src/core.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const config = `0x${"00".repeat(32)}`;

const quote = {
  block_number: 123,
  block_hash: "0x01",
  total_calculated: "900",
  estimated_gas_cost: 25_000,
  price_impact: 0.001,
  splits: [
    {
      amount_specified: "1000",
      amount_calculated: "900",
      route: [
        {
          swap: {
            type: "core",
            pool_key: { token0, token1, config },
            sqrt_ratio_limit: "0x000000000000000000000000",
            skip_ahead: 0,
          },
        },
      ],
    },
  ],
} as const;

const env: Env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  RPC_URLS_JSON: JSON.stringify({ 1: "https://rpc.test" }),
};

describe("MCP service core", () => {
  it("maps explicit exact-output intent to the canonical quoter path", async () => {
    let requested = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requested = input.toString();
      return Response.json({
        ...quote,
        total_calculated: "-201",
        splits: [
          {
            ...quote.splits[0],
            amount_specified: "-100",
            amount_calculated: "-201",
          },
        ],
      });
    };
    await getQuote(
      env,
      {
        chainId: "1",
        tokenIn: token1,
        tokenOut: token0,
        quoteType: "exact_output",
        amount: "100",
      },
      fetcher as typeof fetch,
    );

    expect(requested).toBe(
      `https://quoter.test/1/-100/${token0}/${token1}`,
    );
  });

  it("returns confirmation-gated calldata after block-pinned simulation", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("https://quoter.test/")) {
        return Response.json(quote);
      }
      if (url === "https://rpc.test") {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
        };
        if (body.method === "eth_getBlockByNumber") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { hash: "0x01" } });
        }
        if (body.method === "eth_call") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: encodeFunctionResult({
              abi: YUL_ROUTER_ABI,
              functionName: "quote",
              result: [token0, token1, 1000n, 900n],
            }),
          });
        }
      }
      return new Response("not found", { status: 404 });
    };

    const result = await prepareSwap(
      env,
      {
        chainId: "1",
        tokenIn: token0,
        tokenOut: token1,
        quoteType: "exact_input",
        amount: "1000",
        slippageBps: 25,
        simulate: true,
      },
      fetcher as typeof fetch,
    );

    expect(result.requires_user_confirmation).toBe(true);
    expect(result.confirmation_ready).toBe(true);
    expect(result.simulation.status).toBe("success");
    expect(result.transaction.data).toStartWith("0x");
    expect(result.plan_id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
