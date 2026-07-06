import { concatHex, encodeAbiParameters, numberToHex } from "viem";
import { encodeRoute, encodeRoutes } from "../src/index.ts";

const TOKEN0 = "0x1111111111111111111111111111111111111111";
const TOKEN1 = "0x2222222222222222222222222222222222222222";
const TOKEN2 = "0x4444444444444444444444444444444444444444";
const WRAPPED_TOKEN0 = "0x3333333333333333333333333333333333333333";
const VE33 = "0xd100000000000000000000000000000000000000";
const RECIPIENT = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496";
const SWAP_AMOUNT = 1_000_000_000_000_000_000n;
const FEE = 92_233_720_368_547n;
const VE33_TICK_SPACING = 1024n;

function config(extension, fee, poolTypeConfig) {
  return concatHex([
    extension,
    numberToHex(fee, { size: 8 }),
    numberToHex(poolTypeConfig, { size: 4 }),
  ]);
}

const coreConfig = config("0x0000000000000000000000000000000000000000", FEE, 0n);
const ve33Config = config(VE33, 0n, 0x80000000n | VE33_TICK_SPACING);

const pool01 = { token0: TOKEN0, token1: TOKEN1, config: coreConfig };
const pool12 = { token0: TOKEN1, token1: TOKEN2, config: coreConfig };
const pool02 = { token0: TOKEN0, token1: TOKEN2, config: coreConfig };
const ve33Pool = { token0: TOKEN0, token1: TOKEN1, config: ve33Config };

const cases = {
  core: encodeRoute({
    specifiedToken: TOKEN0,
    calculatedToken: TOKEN1,
    recipient: RECIPIENT,
    specifiedAmount: SWAP_AMOUNT,
    hops: [{ type: "core", poolKey: pool01 }],
  }),
  wrapper: encodeRoute({
    specifiedToken: TOKEN0,
    calculatedToken: WRAPPED_TOKEN0,
    recipient: RECIPIENT,
    specifiedAmount: SWAP_AMOUNT,
    hops: [{ type: "wrapper", underlying: TOKEN0, wrapped: WRAPPED_TOKEN0 }],
  }),
  ve33: encodeRoute({
    specifiedToken: TOKEN0,
    calculatedToken: TOKEN1,
    recipient: RECIPIENT,
    specifiedAmount: SWAP_AMOUNT,
    hops: [{ type: "ve33", forwardee: VE33, poolKey: ve33Pool }],
  }),
  multiMultiHop: encodeRoutes({
    specifiedToken: TOKEN0,
    calculatedToken: TOKEN2,
    recipient: RECIPIENT,
    multiHops: [
      {
        specifiedAmount: SWAP_AMOUNT,
        hops: [{ type: "core", poolKey: pool02 }],
      },
      {
        specifiedAmount: SWAP_AMOUNT,
        hops: [
          { type: "core", poolKey: pool01 },
          { type: "core", poolKey: pool12 },
        ],
      },
    ],
  }),
};

console.log(
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "core", type: "bytes" },
          { name: "wrapper", type: "bytes" },
          { name: "ve33", type: "bytes" },
          { name: "multiMultiHop", type: "bytes" },
        ],
      },
    ],
    [cases],
  ),
);
