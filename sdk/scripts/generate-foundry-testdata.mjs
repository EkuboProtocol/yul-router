import { privateKeyToAccount } from "viem/accounts";
import { concatHex, encodeAbiParameters, keccak256, numberToHex } from "viem";
import {
  encodePoolBalanceUpdate,
  encodeRoute,
  encodeRoutes,
  encodeSignedSwapMeta,
  MIN_CALCULATED_AMOUNT_THRESHOLD,
} from "../src/index.ts";

const TOKEN0 = "0x1111111111111111111111111111111111111111";
const TOKEN1 = "0x2222222222222222222222222222222222222222";
const TOKEN2 = "0x4444444444444444444444444444444444444444";
const WRAPPED_TOKEN0 = "0x3333333333333333333333333333333333333333";
const VE33 = "0xd100000000000000000000000000000000000000";
const SIGNED_EXCLUSIVE_SWAP = "0x5500000000000000000000000000000000000000";
const RECIPIENT = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496";
const SWAP_AMOUNT = 1_000_000_000_000_000_000n;
const FEE = 92_233_720_368_547n;
const VE33_TICK_SPACING = 1024n;
const SIGNED_EXCLUSIVE_SWAP_TICK_SPACING = 1024n;
const SIGNED_EXCLUSIVE_SWAP_FEE = Number((1n << 32n) / 200n);
const CHAIN_ID = Number(process.argv[2] ?? 31337);

function config(extension, fee, poolTypeConfig) {
  return concatHex([
    extension,
    numberToHex(fee, { size: 8 }),
    numberToHex(poolTypeConfig, { size: 4 }),
  ]);
}

function controllerAccount() {
  let pk = 0xa11cen;
  for (;;) {
    const account = privateKeyToAccount(numberToHex(pk, { size: 32 }));
    if (BigInt(account.address) >> 159n === 0n) return account;
    pk += 1n;
  }
}

async function signedExclusiveSwapSignature(poolKey, meta, minBalanceUpdate) {
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [poolKey.token0, poolKey.token1, poolKey.config],
    ),
  );

  return controllerAccount().signTypedData({
    domain: {
      name: "Ekubo SignedExclusiveSwap",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: SIGNED_EXCLUSIVE_SWAP,
    },
    types: {
      SignedSwap: [
        { name: "poolId", type: "bytes32" },
        { name: "meta", type: "uint256" },
        { name: "minBalanceUpdate", type: "bytes32" },
      ],
    },
    primaryType: "SignedSwap",
    message: {
      poolId,
      meta: BigInt(meta),
      minBalanceUpdate,
    },
  });
}

const coreConfig = config("0x0000000000000000000000000000000000000000", FEE, 0n);
const ve33Config = config(VE33, 0n, 0x80000000n | VE33_TICK_SPACING);
const signedExclusiveSwapConfig = config(
  SIGNED_EXCLUSIVE_SWAP,
  0n,
  0x80000000n | SIGNED_EXCLUSIVE_SWAP_TICK_SPACING,
);

const pool01 = { token0: TOKEN0, token1: TOKEN1, config: coreConfig };
const pool12 = { token0: TOKEN1, token1: TOKEN2, config: coreConfig };
const pool02 = { token0: TOKEN0, token1: TOKEN2, config: coreConfig };
const ve33Pool = { token0: TOKEN0, token1: TOKEN1, config: ve33Config };
const signedExclusiveSwapPool = { token0: TOKEN0, token1: TOKEN1, config: signedExclusiveSwapConfig };
const signedExclusiveSwapMeta = encodeSignedSwapMeta({
  deadline: 3601,
  fee: SIGNED_EXCLUSIVE_SWAP_FEE,
  nonce: 777n,
});
const signedExclusiveSwapMinBalanceUpdate = encodePoolBalanceUpdate(
  MIN_CALCULATED_AMOUNT_THRESHOLD,
  MIN_CALCULATED_AMOUNT_THRESHOLD,
);
const signedExclusiveSwapSignatureValue = await signedExclusiveSwapSignature(
  signedExclusiveSwapPool,
  signedExclusiveSwapMeta,
  signedExclusiveSwapMinBalanceUpdate,
);

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
  signedExclusiveSwap: encodeRoute({
    specifiedToken: TOKEN0,
    calculatedToken: TOKEN1,
    recipient: RECIPIENT,
    specifiedAmount: SWAP_AMOUNT,
    hops: [
      {
        type: "signedExclusiveSwap",
        forwardee: SIGNED_EXCLUSIVE_SWAP,
        poolKey: signedExclusiveSwapPool,
        meta: signedExclusiveSwapMeta,
        minBalanceUpdate: signedExclusiveSwapMinBalanceUpdate,
        signature: signedExclusiveSwapSignatureValue,
      },
    ],
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
          { name: "signedExclusiveSwap", type: "bytes" },
          { name: "multiMultiHop", type: "bytes" },
        ],
      },
    ],
    [cases],
  ),
);
