import { describe, expect, it } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  buildQuoterQuoteUrl,
  type EvmQuoterQuote,
  encodePoolBalanceUpdate,
  encodeQuoteCalldata,
  encodeRoute,
  encodeRoutes,
  encodeSignedSwapMeta,
  generateCalldata,
  generateQuoteCalldata,
  MAX_HOP_LENGTH,
  MAX_MULTIHOP_LENGTH,
  MIN_CALCULATED_AMOUNT_THRESHOLD,
  prepareSwapFromQuote,
  YUL_ROUTER_ABI,
  YUL_ROUTER_ADDRESS,
} from "../src/index.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const token2 = "0x2222222222222222222222222222222222222222";
const extension = "0x3333333333333333333333333333333333333333";
const config =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const extensionConfig =
  "0x3333333333333333333333333333333333333333000000000000000000000000";

function quoterQuote(
  overrides: Partial<EvmQuoterQuote> = {},
): EvmQuoterQuote {
  return {
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
    ...overrides,
  };
}

const exactInputIntent = {
  tokenIn: token0,
  tokenOut: token1,
  quoteType: "exact_input" as const,
  amount: 1000n,
};

describe("buildQuoterQuoteUrl", () => {
  it("maps explicit exact-input and exact-output intent to signed paths", () => {
    expect(
      buildQuoterQuoteUrl({
        quoterUrl: "https://prod-api-quoter.ekubo.org/",
        chainId: 1,
        ...exactInputIntent,
      }),
    ).toBe(
      `https://prod-api-quoter.ekubo.org/1/1000/${token0}/${token1}`,
    );
    expect(
      buildQuoterQuoteUrl({
        quoterUrl: "https://prod-api-quoter.ekubo.org",
        chainId: "1",
        tokenIn: token1,
        tokenOut: token0,
        quoteType: "exact_output",
        amount: "100",
      }),
    ).toBe(
      `https://prod-api-quoter.ekubo.org/1/-100/${token0}/${token1}`,
    );
  });
});

describe("prepareSwapFromQuote", () => {
  it("prepares native exact-input execution and simulation calldata", () => {
    const prepared = prepareSwapFromQuote({
      quote: quoterQuote(),
      ...exactInputIntent,
      slippageBps: 100,
      recipient: extension,
    });

    expect(prepared.quoteType).toBe("exact_input");
    expect(prepared.minimumAmountOut).toBe(891n);
    expect(prepared.maximumAmountIn).toBeNull();
    expect(prepared.calculatedAmountThreshold).toBe(891n);
    expect(prepared.transaction.value).toBe(1000n);
    expect(prepared.transaction.to).toBe(YUL_ROUTER_ADDRESS);
    expect(prepared.approval).toBeNull();
    expect(prepared.recipient).toBe(extension);
    expect(prepared.block.number).toBe(123n);
    expect(prepared.block.hash).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );

    const decoded = decodeFunctionData({
      abi: YUL_ROUTER_ABI,
      data: prepared.quoteCalldata,
    });
    expect(decoded.functionName).toBe("quote");
    expect(decoded.args[0]).toBe(prepared.route);
  });

  it("rounds the maximum input up for ERC20 exact-output swaps", () => {
    const quote = quoterQuote({
      total_calculated: "-201",
      splits: [
        {
          amount_specified: "-100",
          amount_calculated: "-201",
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
    });
    const prepared = prepareSwapFromQuote({
      quote,
      tokenIn: token1,
      tokenOut: token0,
      quoteType: "exact_output",
      amount: 100n,
      slippageBps: 50n,
    });

    expect(prepared.minimumAmountOut).toBeNull();
    expect(prepared.maximumAmountIn).toBe(203n);
    expect(prepared.calculatedAmountThreshold).toBe(-203n);
    expect(prepared.transaction.value).toBe(0n);
    expect(prepared.approval).toEqual({
      token: token1,
      spender: YUL_ROUTER_ADDRESS,
      amount: 203n,
    });
  });

  it("maps forwarded quoter nodes through their pool extension", () => {
    const quote = quoterQuote({
      splits: [
        {
          amount_specified: "1000",
          amount_calculated: "900",
          route: [
            {
              swap: {
                type: "forwarded",
                pool_key: { token0, token1, config: extensionConfig },
                sqrt_ratio_limit: "0x000000000000000000000000",
                skip_ahead: 0,
              },
            },
          ],
        },
      ],
    });

    expect(() =>
      prepareSwapFromQuote({ quote, ...exactInputIntent, slippageBps: 1 }),
    ).not.toThrow();
  });

  it("rejects inconsistent quote totals and unsafe slippage", () => {
    expect(() =>
      prepareSwapFromQuote({
        quote: quoterQuote({ total_calculated: "901" }),
        ...exactInputIntent,
        slippageBps: 1,
      }),
    ).toThrow("calculated total");
    expect(() =>
      prepareSwapFromQuote({
        quote: quoterQuote(),
        ...exactInputIntent,
        slippageBps: 10_001,
      }),
    ).toThrow("at most 10000");
    expect(() =>
      prepareSwapFromQuote({
        quote: quoterQuote(),
        ...exactInputIntent,
        slippageBps: 0.5,
      }),
    ).toThrow("safe integer");
    expect(() =>
      prepareSwapFromQuote({
        quote: quoterQuote(),
        ...exactInputIntent,
        quoteType: "unsupported" as "exact_input",
        slippageBps: 1,
      }),
    ).toThrow("unsupported quote type");
  });

  it("keeps exact-input dust protection nonzero", () => {
    const prepared = prepareSwapFromQuote({
      quote: quoterQuote({
        total_calculated: "1",
        splits: [
          {
            amount_specified: "1",
            amount_calculated: "1",
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
      }),
      tokenIn: token0,
      tokenOut: token1,
      quoteType: "exact_input",
      amount: 1n,
      slippageBps: 10_000,
    });

    expect(prepared.minimumAmountOut).toBe(1n);
  });
});

describe("encodeSignedSwapMeta", () => {
  it("encodes uint64 bigint nonces above the safe integer range exactly", () => {
    const nonce = 9_007_199_254_740_993n;
    const meta = encodeSignedSwapMeta({ deadline: 0, nonce });
    const decodedNonce = (BigInt(meta) >> 128n) & ((1n << 64n) - 1n);

    expect(decodedNonce).toBe(nonce);
  });

  it("rejects numeric nonce inputs at runtime", () => {
    const unsafeNumericNonce = Number(9_007_199_254_740_993n);

    expect(() =>
      encodeSignedSwapMeta({
        deadline: 0,
        nonce: unsafeNumericNonce as unknown as bigint,
      }),
    ).toThrow("nonce must be a bigint");
  });

  it("rejects bigint nonces outside uint64", () => {
    expect(() =>
      encodeSignedSwapMeta({ deadline: 0, nonce: -1n }),
    ).toThrow("nonce must fit into uint64");
    expect(() =>
      encodeSignedSwapMeta({ deadline: 0, nonce: 1n << 64n }),
    ).toThrow("nonce must fit into uint64");
  });
});

describe("encodeRoute", () => {
  it("encodes a selectorless core multihop route with explicit tokens", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token2,
      specifiedAmount: 1_000_000n,
      calculatedAmountThreshold: 900_000n,
      hops: [
        { type: "core", poolKey: { token0, token1, config } },
        {
          type: "core",
          poolKey: { token0: token1, token1: token2, config },
          skipAhead: 3,
        },
      ],
    });

    expect(data.slice(0, 6)).toBe("0x0000");
  });

  it("encodes forwarded and wrapper hop types", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: 1n,
      recipient: extension,
      hops: [
        { type: "wrapper", underlying: token0, wrapped: token2 },
        {
          type: "forwarded",
          forwardee: extension,
          poolKey: { token0: token1, token1: token2, config },
        },
      ],
    });

    expect(data.slice(0, 4)).toBe("0x01");
    expect(data).toContain("02");
    expect(data).toContain("01");
  });

  it("encodes opt-in partial fills in the swap control word", () => {
    const coreData = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: false,
      hops: [
        {
          type: "core",
          poolKey: { token0, token1, config },
          skipAhead: 3,
          allowPartial: true,
        },
      ],
    });
    const forwardedData = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: false,
      hops: [
        {
          type: "forwarded",
          forwardee: extension,
          poolKey: { token0, token1, config },
          allowPartial: true,
        },
      ],
    });

    expect(coreData.endsWith("80000003")).toBe(true);
    expect(forwardedData.endsWith("80000000")).toBe(true);
  });

  it("defaults forwarded hops to the pool extension", () => {
    const parameters = {
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: false,
      hops: [
        {
          type: "forwarded",
          poolKey: { token0, token1, config: extensionConfig },
        },
      ],
    } as const;
    const inferred = encodeRoute(parameters);
    const explicit = encodeRoute({
      ...parameters,
      hops: [{ ...parameters.hops[0], forwardee: extension }],
    });

    expect(inferred).toBe(explicit);
  });

  it("requires a nonzero forward target", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 1n,
        calculatedAmountThreshold: false,
        hops: [{ type: "forwarded", poolKey: { token0, token1, config } }],
      }),
    ).toThrow("forwardee or a nonzero pool extension");

    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 1n,
        calculatedAmountThreshold: false,
        hops: [
          {
            type: "forwarded",
            forwardee: "0x0000000000000000000000000000000000000000",
            poolKey: { token0, token1, config: extensionConfig },
          },
        ],
      }),
    ).toThrow("forwardee or a nonzero pool extension");
  });

  it("restricts partial fills to single-hop paths with nonzero amounts", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: -(1n << 127n),
        calculatedAmountThreshold: false,
        hops: [
          {
            type: "core",
            poolKey: { token0, token1, config },
            allowPartial: true,
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token2,
        specifiedAmount: 1n,
        calculatedAmountThreshold: false,
        hops: [
          {
            type: "core",
            poolKey: { token0, token1, config },
            allowPartial: true,
          },
          {
            type: "core",
            poolKey: { token0: token1, token1: token2, config },
          },
        ],
      }),
    ).toThrow("single-hop paths with a nonzero specifiedAmount");

    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 0n,
        calculatedAmountThreshold: false,
        hops: [
          {
            type: "core",
            poolKey: { token0, token1, config },
            allowPartial: true,
          },
        ],
      }),
    ).toThrow("single-hop paths with a nonzero specifiedAmount");
  });

  it("encodes signed exclusive swap hops with signed payload fields", () => {
    const meta = encodeSignedSwapMeta({
      authorizedLocker: extension,
      deadline: 1_800_000_000,
      fee: 123,
      nonce: 456n,
    });
    const minBalanceUpdate = encodePoolBalanceUpdate(
      MIN_CALCULATED_AMOUNT_THRESHOLD,
      MIN_CALCULATED_AMOUNT_THRESHOLD,
    );
    const signature = "0x123456";

    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: 1n,
      hops: [
        {
          type: "signedExclusiveSwap",
          poolKey: { token0, token1, config: extensionConfig },
          meta,
          minBalanceUpdate,
          signature,
        },
      ],
    });

    expect(data).toContain(`04${extension.slice(2).toLowerCase()}`);
    expect(data).toContain(meta.slice(2));
    expect(data).toContain(minBalanceUpdate.slice(2));
    expect(data.endsWith("00000003123456")).toBe(true);
  });

  it("requires a calculated amount threshold for exact-in routes", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 1n,
        hops: [{ type: "core", poolKey: { token0, token1, config } }],
      }),
    ).toThrow("calculatedAmountThreshold is required");
  });

  it("requires a calculated amount threshold for exact-out routes", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: -1n,
        hops: [{ type: "core", poolKey: { token0, token1, config } }],
      }),
    ).toThrow("calculatedAmountThreshold is required");
  });

  it("encodes an explicit maximum input for exact-out routes", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: -1n,
      calculatedAmountThreshold: -2n,
      hops: [{ type: "core", poolKey: { token0, token1, config } }],
    });

    expect(data).toStartWith(
      `0x0000${token0.slice(2)}${token1.slice(2)}fffffffffffffffffffffffffffffffe`,
    );
  });

  it("allows an explicit legacy unbounded threshold for exact-in routes", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      calculatedAmountThreshold: false,
      hops: [{ type: "core", poolKey: { token0, token1, config } }],
    });

    expect(data).toStartWith(
      `0x0000${token0.slice(2)}${token1.slice(2)}00000000000000000000000000000000`,
    );
  });

  it("allows an explicit legacy unbounded threshold for exact-out routes", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: -1n,
      calculatedAmountThreshold: false,
      hops: [{ type: "core", poolKey: { token0, token1, config } }],
    });

    expect(data).toStartWith(
      `0x0000${token0.slice(2)}${token1.slice(2)}80000000000000000000000000000000`,
    );
  });

  it("rejects oversized signed exclusive swap fields", () => {
    expect(() => encodeSignedSwapMeta({ deadline: -1, nonce: 0n })).toThrow(
      "deadline",
    );
    expect(() =>
      encodePoolBalanceUpdate(MIN_CALCULATED_AMOUNT_THRESHOLD - 1n, 0n),
    ).toThrow("delta0");
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 1n,
        calculatedAmountThreshold: 1n,
        hops: [
          {
            type: "signedExclusiveSwap",
            forwardee: extension,
            poolKey: { token0, token1, config },
            meta: 1n << 256n,
            minBalanceUpdate: "0x00",
            signature: "0x",
          },
        ],
      }),
    ).toThrow("meta");
  });

  it("rejects disconnected hops", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token2,
        specifiedAmount: 1n,
        calculatedAmountThreshold: 1n,
        hops: [
          { type: "core", poolKey: { token0: token1, token1: token2, config } },
        ],
      }),
    ).toThrow("disconnected");
  });
});

describe("encodeQuoteCalldata", () => {
  it("wraps packed routes in the quote(bytes) entrypoint", () => {
    const parameters = {
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1_000_000n,
      calculatedAmountThreshold: false,
      hops: [
        {
          type: "core",
          poolKey: { token0, token1, config },
          allowPartial: true,
        },
      ],
    } as const;
    const route = encodeRoute(parameters);
    const calldata = generateQuoteCalldata({
      specifiedToken: parameters.specifiedToken,
      calculatedToken: parameters.calculatedToken,
      calculatedAmountThreshold: parameters.calculatedAmountThreshold,
      multiHops: [
        {
          specifiedAmount: parameters.specifiedAmount,
          hops: parameters.hops,
        },
      ],
    });
    const decoded = decodeFunctionData({
      abi: YUL_ROUTER_ABI,
      data: calldata,
    });

    expect(calldata).toBe(encodeQuoteCalldata(route));
    expect(decoded.functionName).toBe("quote");
    expect(decoded.args[0]).toBe(route);
  });
});

describe("encodeRoutes", () => {
  it("rejects an omitted threshold for exact-in multi-hop routes", () => {
    expect(() =>
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token1,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: [{ type: "core", poolKey: { token0, token1, config } }],
          },
        ],
      }),
    ).toThrow("calculatedAmountThreshold is required");
  });

  it("supports multiple independent multi-hop paths with a shared settlement token pair", () => {
    const data = encodeRoutes({
      specifiedToken: token0,
      calculatedToken: token2,
      calculatedAmountThreshold: 1n,
      recipient: extension,
      multiHops: [
        {
          specifiedAmount: 1n,
          hops: [{ type: "core", poolKey: { token0, token1: token2, config } }],
        },
        {
          specifiedAmount: 2n,
          hops: [
            { type: "core", poolKey: { token0, token1, config } },
            {
              type: "core",
              poolKey: { token0: token1, token1: token2, config },
            },
          ],
        },
      ],
    });

    expect(data.slice(0, 6)).toBe("0x0101");
    expect(
      generateCalldata({
        specifiedToken: token0,
        calculatedToken: token2,
        calculatedAmountThreshold: 1n,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: [
              { type: "core", poolKey: { token0, token1: token2, config } },
            ],
          },
        ],
      }),
    ).toBeDefined();
  });

  it("rejects mixed exact-in and exact-out paths", () => {
    expect(() =>
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token1,
        calculatedAmountThreshold: 1n,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: [{ type: "core", poolKey: { token0, token1, config } }],
          },
          {
            specifiedAmount: -1n,
            hops: [{ type: "core", poolKey: { token0, token1, config } }],
          },
        ],
      }),
    ).toThrow("mixed exact-out / exact-in");
  });

  it("supports the maximum number of multi-hops", () => {
    const hop = { type: "core" as const, poolKey: { token0, token1, config } };

    expect(
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token1,
        calculatedAmountThreshold: 1n,
        multiHops: Array.from({ length: MAX_MULTIHOP_LENGTH }, () => ({
          specifiedAmount: 1n,
          hops: [hop],
        })),
      }),
    ).toBeDefined();
  });

  it("supports the maximum number of hops per multi-hop", () => {
    const hop = { type: "core" as const, poolKey: { token0, token1, config } };

    expect(
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token0,
        calculatedAmountThreshold: 1n,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: Array.from({ length: MAX_HOP_LENGTH }, () => hop),
          },
        ],
      }),
    ).toBeDefined();
  });

  it("rejects routes above the encoded complexity limits", () => {
    const hop = { type: "core" as const, poolKey: { token0, token1, config } };

    expect(() =>
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token1,
        calculatedAmountThreshold: 1n,
        multiHops: Array.from({ length: MAX_MULTIHOP_LENGTH + 1 }, () => ({
          specifiedAmount: 1n,
          hops: [hop],
        })),
      }),
    ).toThrow("multiHops length");

    expect(() =>
      encodeRoutes({
        specifiedToken: token0,
        calculatedToken: token1,
        calculatedAmountThreshold: 1n,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: Array.from({ length: MAX_HOP_LENGTH + 1 }, () => hop),
          },
        ],
      }),
    ).toThrow("hops");
  });
});
