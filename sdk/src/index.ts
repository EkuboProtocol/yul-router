import {
  Address,
  concatHex,
  getAddress,
  Hex,
  hexToBigInt,
  maxInt128,
  minInt128,
  numberToHex,
  padHex,
  size,
} from "viem";

export const MIN_SQRT_RATIO = 4611797791050542631n;
export const MAX_SQRT_RATIO = 79227682466138141934206691491n;
export const MIN_CALCULATED_AMOUNT_THRESHOLD = minInt128;
export const MAX_CALCULATED_AMOUNT_THRESHOLD = maxInt128;
export const MAX_MULTIHOP_LENGTH = 256;
export const MAX_HOP_LENGTH = 256;

export interface PoolKey {
  token0: Address;
  token1: Address;
  config: Hex;
}

export interface CoreHop {
  type: "core";
  poolKey: PoolKey;
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
}

export interface ForwardedHop {
  type: "forwarded";
  forwardee: Address;
  poolKey: PoolKey;
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
}

export interface Ve33Hop {
  type: "ve33";
  forwardee: Address;
  poolKey: PoolKey;
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
}

export interface WrapperHop {
  type: "wrapper";
  underlying: Address;
  wrapped: Address;
}

export type Hop = CoreHop | ForwardedHop | Ve33Hop | WrapperHop;

export interface MultiHop {
  specifiedAmount: bigint;
  hops: readonly Hop[];
}

export interface EncodeRoutesParameters {
  specifiedToken: Address;
  calculatedToken: Address;
  calculatedAmountThreshold?: bigint;
  recipient?: Address;
  multiHops: readonly MultiHop[];
}

export interface EncodeRouteParameters {
  specifiedToken: Address;
  calculatedToken: Address;
  specifiedAmount: bigint;
  calculatedAmountThreshold?: bigint;
  recipient?: Address;
  hops: readonly Hop[];
}

export type Parameters = EncodeRoutesParameters;

export function encodeRoute(params: EncodeRouteParameters): Hex {
  const { specifiedAmount, hops, ...shared } = params;
  return encodeRoutes({
    ...shared,
    multiHops: [{ specifiedAmount, hops }],
  });
}

export function generateCalldata(params: EncodeRoutesParameters): Hex {
  return encodeRoutes(params);
}

export function encodeRoutes(params: EncodeRoutesParameters): Hex {
  const {
    specifiedToken,
    calculatedToken,
    calculatedAmountThreshold,
    recipient,
    multiHops,
  } = params;

  if (multiHops.length < 1 || multiHops.length > MAX_MULTIHOP_LENGTH) {
    throw new Error(`multiHops length must be between 1 and ${MAX_MULTIHOP_LENGTH}`);
  }

  const specified = getAddress(specifiedToken);
  const calculated = getAddress(calculatedToken);
  let isExactOut: boolean | undefined;
  const encodedMultiHops: Hex[] = [];

  for (const multiHop of multiHops) {
    const { specifiedAmount, hops } = multiHop;
    assertInt128(specifiedAmount, "specifiedAmount");

    if (specifiedAmount !== 0n) {
      const multiHopExactOut = specifiedAmount < 0n;
      if (isExactOut !== undefined && isExactOut !== multiHopExactOut) {
        throw new Error("mixed exact-out / exact-in multi-hops");
      }
      isExactOut = multiHopExactOut;
    }

    if (hops.length < 1 || hops.length > MAX_HOP_LENGTH) {
      throw new Error(`each multi-hop needs between 1 and ${MAX_HOP_LENGTH} hops`);
    }

    let currentToken = specified;
    const encodedHops: Hex[] = [];

    for (const hop of hops) {
      switch (hop.type) {
        case "core": {
          const { nextToken } = resolvePoolHop(currentToken, hop.poolKey);
          encodedHops.push(encodeSwapHop("00", hop.poolKey, hop.sqrtRatioLimit, hop.skipAhead));
          currentToken = nextToken;
          break;
        }
        case "forwarded": {
          const { poolKey, forwardee } = hop;
          const { nextToken } = resolvePoolHop(currentToken, poolKey);
          encodedHops.push(
            concatHex([
              "0x01",
              encodeAddress(forwardee),
              encodePoolKey(poolKey),
              encodeSqrtRatioLimit(hop.sqrtRatioLimit),
              encodeSkipAhead(hop.skipAhead),
            ]),
          );
          currentToken = nextToken;
          break;
        }
        case "ve33": {
          const { poolKey, forwardee } = hop;
          const { nextToken } = resolvePoolHop(currentToken, poolKey);
          encodedHops.push(
            concatHex([
              "0x03",
              encodeAddress(forwardee),
              encodePoolKey(poolKey),
              encodeSqrtRatioLimit(hop.sqrtRatioLimit),
              encodeSkipAhead(hop.skipAhead),
            ]),
          );
          currentToken = nextToken;
          break;
        }
        case "wrapper": {
          const underlying = getAddress(hop.underlying);
          const wrapped = getAddress(hop.wrapped);
          if (hexToBigInt(underlying) === hexToBigInt(wrapped)) {
            throw new Error("underlying and wrapped token must differ");
          }
          if (currentToken === underlying) {
            currentToken = wrapped;
          } else if (currentToken === wrapped) {
            currentToken = underlying;
          } else {
            throw new Error("wrapper hop is disconnected");
          }
          encodedHops.push(concatHex(["0x02", encodeAddress(underlying), encodeAddress(wrapped)]));
          break;
        }
      }
    }

    if (currentToken !== calculated) {
      throw new Error("calculatedToken does not match multi-hop output");
    }

    encodedMultiHops.push(
      concatHex([
        encodeInt128(specifiedAmount),
        numberToHex(hops.length - 1, { size: 1 }),
        ...encodedHops,
      ]),
    );
  }

  const threshold =
    calculatedAmountThreshold ??
    (isExactOut === true ? MIN_CALCULATED_AMOUNT_THRESHOLD : 0n);
  assertInt128(threshold, "calculatedAmountThreshold");

  if (threshold !== 0n && isExactOut !== undefined && (threshold < 0n) !== isExactOut) {
    throw new Error("calculatedAmountThreshold sign and specified amount signs have to match");
  }

  const flags = recipient ? 1 : 0;
  const header = concatHex([
    numberToHex(flags, { size: 1 }),
    numberToHex(multiHops.length - 1, { size: 1 }),
    encodeAddress(specified),
    encodeAddress(calculated),
    encodeInt128(threshold),
    ...(recipient ? [encodeAddress(recipient)] : []),
  ]);

  return concatHex([header, ...encodedMultiHops]);
}

function resolvePoolHop(currentToken: Address, poolKey: PoolKey) {
  const token0 = getAddress(poolKey.token0);
  const token1 = getAddress(poolKey.token1);
  if (hexToBigInt(token0) >= hexToBigInt(token1)) {
    throw new Error("poolKey tokens must be sorted");
  }

  if (currentToken === token0) {
    return { nextToken: token1 };
  }
  if (currentToken === token1) {
    return { nextToken: token0 };
  }

  throw new Error("pool hop is disconnected");
}

function encodeSwapHop(kind: "00", poolKey: PoolKey, sqrtRatioLimit?: bigint, skipAhead?: number): Hex {
  return concatHex([
    `0x${kind}`,
    encodePoolKey(poolKey),
    encodeSqrtRatioLimit(sqrtRatioLimit),
    encodeSkipAhead(skipAhead),
  ]);
}

function encodePoolKey(poolKey: PoolKey): Hex {
  const token0 = getAddress(poolKey.token0);
  const token1 = getAddress(poolKey.token1);
  if (hexToBigInt(token0) >= hexToBigInt(token1)) {
    throw new Error("poolKey tokens must be sorted");
  }
  const config = padHex(poolKey.config, { size: 32 });
  return concatHex([encodeAddress(token0), encodeAddress(token1), config]);
}

function encodeAddress(address: Address): Hex {
  return getAddress(address);
}

function encodeSqrtRatioLimit(value: bigint | undefined): Hex {
  if (value === undefined || value === 0n) {
    return "0x000000000000000000000000";
  }
  if (value < MIN_SQRT_RATIO || value > MAX_SQRT_RATIO) {
    throw new Error("invalid sqrtRatioLimit");
  }
  return numberToHex(value, { size: 12 });
}

function encodeSkipAhead(skipAhead = 0): Hex {
  if (!Number.isInteger(skipAhead) || skipAhead < 0 || skipAhead > 0x7fffffff) {
    throw new Error("skipAhead must fit into uint31");
  }
  return numberToHex(skipAhead, { size: 4 });
}

function assertInt128(value: bigint, name: string) {
  if (value < minInt128 || value > maxInt128) {
    throw new Error(`${name} must fit into int128`);
  }
}

function encodeInt128(value: bigint): Hex {
  assertInt128(value, "value");
  return numberToHex(BigInt.asUintN(128, value), { size: 16 });
}

export function calldataSize(data: Hex): number {
  return size(data);
}
