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
export const MAX_SKIP_AHEAD = 0xff;

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
  let maxSpecifiedAmount = 0n;
  let hasSqrtRatioLimits = false;

  for (const { specifiedAmount, hops } of multiHops) {
    assertInt128(specifiedAmount, "specifiedAmount");

    const specifiedMagnitude = abs(specifiedAmount);
    if (specifiedMagnitude > maxSpecifiedAmount) {
      maxSpecifiedAmount = specifiedMagnitude;
    }

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

    for (const hop of hops) {
      if ("sqrtRatioLimit" in hop && hop.sqrtRatioLimit !== undefined && hop.sqrtRatioLimit !== 0n) {
        hasSqrtRatioLimits = true;
      }
    }
  }

  if (calculatedAmountThreshold !== undefined) {
    assertInt128(calculatedAmountThreshold, "calculatedAmountThreshold");
    const thresholdExactOut = calculatedAmountThreshold < 0n;
    if (isExactOut !== undefined && calculatedAmountThreshold !== 0n && thresholdExactOut !== isExactOut) {
      throw new Error("calculatedAmountThreshold sign and specified amount signs have to match");
    }
    if (calculatedAmountThreshold !== 0n) {
      isExactOut ??= thresholdExactOut;
    }
  }
  isExactOut ??= false;

  const specifiedAmountBytes = byteSize(maxSpecifiedAmount);
  const thresholdMagnitude = calculatedAmountThreshold === undefined ? 0n : abs(calculatedAmountThreshold);
  const thresholdBytes = byteSize(thresholdMagnitude);

  if (specifiedAmountBytes > 16 || thresholdBytes > 16) {
    throw new Error("amounts must fit into int128");
  }

  const encodedMultiHops: Hex[] = [];
  for (const multiHop of multiHops) {
    const { specifiedAmount, hops } = multiHop;
    let currentToken = specified;
    const encodedHops: Hex[] = [];

    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const last = i === hops.length - 1;

      switch (hop.type) {
        case "core": {
          const { nextToken } = resolvePoolHop(currentToken, hop.poolKey);
          encodedHops.push(
            concatHex([
              encodeCoreHop(hop.poolKey, hop.skipAhead),
              encodeRouteSqrtRatioLimit(hasSqrtRatioLimits, hop.sqrtRatioLimit, currentToken, nextToken, isExactOut),
              ...(last ? [] : [encodePathToken(nextToken)]),
            ]),
          );
          currentToken = nextToken;
          break;
        }
        case "forwarded": {
          const { poolKey, forwardee } = hop;
          const { nextToken } = resolvePoolHop(currentToken, poolKey);
          encodedHops.push(
            concatHex([
              "0x02",
              encodeSkipAhead(hop.skipAhead),
              encodeAddress(forwardee),
              encodeConfig(poolKey.config),
              encodeRouteSqrtRatioLimit(hasSqrtRatioLimits, hop.sqrtRatioLimit, currentToken, nextToken, isExactOut),
              ...(last ? [] : [encodePathToken(nextToken)]),
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
              "0x04",
              encodeSkipAhead(hop.skipAhead),
              encodeAddress(forwardee),
              encodeVe33PoolTypeConfig(poolKey.config),
              encodeRouteSqrtRatioLimit(hasSqrtRatioLimits, hop.sqrtRatioLimit, currentToken, nextToken, isExactOut),
              ...(last ? [] : [encodePathToken(nextToken)]),
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

          let unwrap: boolean;
          if (currentToken === underlying) {
            currentToken = wrapped;
            unwrap = false;
          } else if (currentToken === wrapped) {
            currentToken = underlying;
            unwrap = true;
          } else {
            throw new Error("wrapper hop is disconnected");
          }

          encodedHops.push(
            concatHex([
              "0x03",
              numberToHex(unwrap ? 1 : 0, { size: 1 }),
              ...(last ? [] : [encodePathToken(currentToken)]),
            ]),
          );
          break;
        }
      }
    }

    if (currentToken !== calculated) {
      throw new Error("calculatedToken does not match multi-hop output");
    }

    encodedMultiHops.push(
      concatHex([
        encodeMagnitude(specifiedAmount, specifiedAmountBytes),
        numberToHex(hops.length - 1, { size: 1 }),
        ...encodedHops,
      ]),
    );
  }

  const flags =
    (recipient ? 1 : 0) |
    (isExactOut ? 2 : 0) |
    (hasSqrtRatioLimits ? 4 : 0) |
    (isNative(specified) ? 8 : 0) |
    (isNative(calculated) ? 16 : 0);

  const header = concatHex([
    numberToHex(flags, { size: 1 }),
    numberToHex(multiHops.length - 1, { size: 1 }),
    numberToHex(specifiedAmountBytes, { size: 1 }),
    numberToHex(thresholdBytes, { size: 1 }),
    encodeUnsigned(thresholdMagnitude, thresholdBytes),
    ...(isNative(specified) ? [] : [encodeAddress(specified)]),
    ...(isNative(calculated) ? [] : [encodeAddress(calculated)]),
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

function encodeCoreHop(poolKey: PoolKey, skipAhead?: number): Hex {
  const config = encodeConfig(poolKey.config);
  const extension = getAddress(`0x${config.slice(2, 42)}` as Address);
  if (isNative(extension)) {
    return concatHex(["0x00", encodeSkipAhead(skipAhead), `0x${config.slice(42)}`]);
  }

  return concatHex(["0x01", encodeSkipAhead(skipAhead), config]);
}

function encodeConfig(config: Hex): Hex {
  return padHex(config, { size: 32 });
}

function encodeVe33PoolTypeConfig(config: Hex): Hex {
  const full = encodeConfig(config);
  const fee = hexToBigInt(`0x${full.slice(42, 58)}`);
  if (fee !== 0n) {
    throw new Error("ve33 pool fee must be zero");
  }
  return `0x${full.slice(58)}`;
}

function encodeRouteSqrtRatioLimit(
  enabled: boolean,
  value: bigint | undefined,
  currentToken: Address,
  nextToken: Address,
  exactOut: boolean,
): Hex {
  if (!enabled) {
    return "0x";
  }

  const limit = value === undefined || value === 0n
    ? defaultSqrtRatioLimit(currentToken, nextToken, exactOut)
    : value;
  if (limit < MIN_SQRT_RATIO || limit > MAX_SQRT_RATIO) {
    throw new Error("invalid sqrtRatioLimit");
  }
  return numberToHex(limit, { size: 12 });
}

function defaultSqrtRatioLimit(currentToken: Address, nextToken: Address, exactOut: boolean): bigint {
  const isToken1 = hexToBigInt(currentToken) > hexToBigInt(nextToken);
  return exactOut !== isToken1 ? MAX_SQRT_RATIO : MIN_SQRT_RATIO;
}

function encodePathToken(token: Address): Hex {
  return isNative(token) ? "0x00" : concatHex(["0x01", encodeAddress(token)]);
}

function encodeAddress(address: Address): Hex {
  return getAddress(address);
}

function encodeSkipAhead(skipAhead = 0): Hex {
  if (!Number.isInteger(skipAhead) || skipAhead < 0 || skipAhead > MAX_SKIP_AHEAD) {
    throw new Error("skipAhead must fit into uint8");
  }
  return numberToHex(skipAhead, { size: 1 });
}

function encodeMagnitude(value: bigint, bytes: number): Hex {
  return encodeUnsigned(abs(value), bytes);
}

function encodeUnsigned(value: bigint, bytes: number): Hex {
  return bytes === 0 ? "0x" : numberToHex(value, { size: bytes });
}

function byteSize(value: bigint): number {
  return value === 0n ? 0 : size(numberToHex(value));
}

function assertInt128(value: bigint, name: string) {
  if (value < minInt128 || value > maxInt128) {
    throw new Error(`${name} must fit into int128`);
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function isNative(address: Address): boolean {
  return hexToBigInt(address) === 0n;
}

export function calldataSize(data: Hex): number {
  return size(data);
}
