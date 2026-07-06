import { describe, expect, it } from "vitest";
import { encodeRoute, ROUTER_SELECTOR } from "../src/index.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const token2 = "0x2222222222222222222222222222222222222222";
const extension = "0x3333333333333333333333333333333333333333";
const config = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("encodeRoute", () => {
  it("encodes a core multihop route with explicit tokens", () => {
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

    expect(data.startsWith(ROUTER_SELECTOR)).toBe(true);
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

    expect(data.slice(0, 10)).toBe(ROUTER_SELECTOR);
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

    expect(data.includes("03")).toBe(true);
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
