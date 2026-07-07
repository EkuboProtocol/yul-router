import { describe, expect, it } from "bun:test";
import {
  encodeRoute,
  encodeRoutes,
  generateCalldata,
  MAX_HOP_LENGTH,
  MAX_MULTIHOP_LENGTH,
} from "../src/index.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const token2 = "0x2222222222222222222222222222222222222222";
const extension = "0x3333333333333333333333333333333333333333";
const config = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("encodeRoute", () => {
  it("encodes a selectorless core multihop route with explicit tokens", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token2,
      specifiedAmount: 1_000_000n,
      calculatedAmountThreshold: 900_000n,
      hops: [
        { type: "core", poolKey: { token0, token1, config } },
        { type: "core", poolKey: { token0: token1, token1: token2, config }, skipAhead: 3 },
      ],
    });

    expect(data).toBe(
      "0x080003030dbba022222222222222222222222222222222222222220f42400100000000000000000000000000000111111111111111111111111111111111111111110003000000000000000000000000",
    );
  });

  it("encodes forwarded and wrapper hop types", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      recipient: extension,
      hops: [
        { type: "wrapper", underlying: token0, wrapped: token2 },
        { type: "forwarded", forwardee: extension, poolKey: { token0: token1, token1: token2, config } },
      ],
    });

    expect(data).toBe(
      "0x090001001111111111111111111111111111111111111111333333333333333333333333333333333333333301010300012222222222222222222222222222222222222222020033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("encodes ve33 hops with an explicit forwardee", () => {
    const data = encodeRoute({
      specifiedToken: token0,
      calculatedToken: token1,
      specifiedAmount: 1n,
      hops: [
        {
          type: "ve33",
          forwardee: extension,
          poolKey: { token0, token1, config },
        },
      ],
    });

    expect(data).toBe(
      "0x08000100111111111111111111111111111111111111111101000400333333333333333333333333333333333333333300000000",
    );
  });

  it("rejects disconnected hops", () => {
    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token2,
        specifiedAmount: 1n,
        hops: [{ type: "core", poolKey: { token0: token1, token1: token2, config } }],
      }),
    ).toThrow("disconnected");
  });
});

describe("encodeRoutes", () => {
  it("supports multiple independent multi-hop paths with a shared settlement token pair", () => {
    const data = encodeRoutes({
      specifiedToken: token0,
      calculatedToken: token2,
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
            { type: "core", poolKey: { token0: token1, token1: token2, config } },
          ],
        },
      ],
    });

    expect(data).toBe(
      "0x090101002222222222222222222222222222222222222222333333333333333333333333333333333333333301000000000000000000000000000000020100000000000000000000000000000111111111111111111111111111111111111111110000000000000000000000000000",
    );
    expect(
      generateCalldata({
        specifiedToken: token0,
        calculatedToken: token2,
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: [{ type: "core", poolKey: { token0, token1: token2, config } }],
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
        multiHops: [
          { specifiedAmount: 1n, hops: [{ type: "core", poolKey: { token0, token1, config } }] },
          { specifiedAmount: -1n, hops: [{ type: "core", poolKey: { token0, token1, config } }] },
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
        multiHops: [
          {
            specifiedAmount: 1n,
            hops: Array.from({ length: MAX_HOP_LENGTH + 1 }, () => hop),
          },
        ],
      }),
    ).toThrow("hops");

    expect(() =>
      encodeRoute({
        specifiedToken: token0,
        calculatedToken: token1,
        specifiedAmount: 1n,
        hops: [{ type: "core", poolKey: { token0, token1, config }, skipAhead: 0x100 }],
      }),
    ).toThrow("skipAhead must fit into uint8");
  });
});
