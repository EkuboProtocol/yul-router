import { describe, expect, it } from "bun:test";
import {
  encodePoolBalanceUpdate,
  encodeRoute,
  encodeRoutes,
  encodeSignedSwapMeta,
  generateCalldata,
  MAX_HOP_LENGTH,
  MAX_MULTIHOP_LENGTH,
  MIN_CALCULATED_AMOUNT_THRESHOLD,
  YUL_ROUTER_ADDRESS,
} from "../src/index.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const token2 = "0x2222222222222222222222222222222222222222";
const extension = "0x3333333333333333333333333333333333333333";
const config =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

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
          forwardee: extension,
          poolKey: { token0, token1, config },
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
    expect(() => encodeSignedSwapMeta({ deadline: -1, nonce: 0 })).toThrow(
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
