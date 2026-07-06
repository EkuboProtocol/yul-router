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

export const ROUTER_SELECTOR = "0x00000002" as const;
export const MIN_SQRT_RATIO = 4611797791050542631n;
export const MAX_SQRT_RATIO = 79227682466138141934206691491n;

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

export interface EncodeRouteParameters {
  specifiedToken: Address;
  calculatedToken: Address;
  specifiedAmount: bigint;
  calculatedAmountThreshold?: bigint;
  recipient?: Address;
  hops: readonly Hop[];
}

export function encodeRoute(params: EncodeRouteParameters): Hex {
  const {
    specifiedToken,
    calculatedToken,
    specifiedAmount,
    calculatedAmountThreshold = 0n,
    recipient,
    hops,
  } = params;

  if (hops.length < 1 || hops.length > 255) {
    throw new Error("hops length must be between 1 and 255");
  }
  assertInt128(specifiedAmount, "specifiedAmount");
  assertInt128(calculatedAmountThreshold, "calculatedAmountThreshold");

  const specified = getAddress(specifiedToken);
  const calculated = getAddress(calculatedToken);

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
    throw new Error("calculatedToken does not match final hop output");
  }

  const flags = recipient ? 1 : 0;
  const header = concatHex([
    ROUTER_SELECTOR,
    numberToHex(flags, { size: 1 }),
    numberToHex(hops.length, { size: 1 }),
    encodeAddress(specified),
    encodeAddress(calculated),
    encodeInt128(specifiedAmount),
    encodeInt128(calculatedAmountThreshold),
    ...(recipient ? [encodeAddress(recipient)] : []),
  ]);

  return concatHex([header, ...encodedHops]);
}

function resolvePoolHop(currentToken: Address, poolKey: PoolKey) {
  const token0 = getAddress(poolKey.token0);
  const token1 = getAddress(poolKey.token1);
  if (hexToBigInt(token0) >= hexToBigInt(token1)) {
    throw new Error("poolKey tokens must be sorted");
  }

  if (currentToken === token0) {
    return { poolKey: { ...poolKey, token0, token1 }, isToken1: false, nextToken: token1 };
  }
  if (currentToken === token1) {
    return { poolKey: { ...poolKey, token0, token1 }, isToken1: true, nextToken: token0 };
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
