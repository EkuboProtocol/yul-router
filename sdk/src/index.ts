import {
  Address,
  concatHex,
  encodeFunctionData,
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
export const YUL_ROUTER_ADDRESS: Address =
  "0x7B2aA7Ecc0B5936b7C52E6259A19C3BA557d0748";

export const YUL_ROUTER_ABI = [
  {
    type: "function",
    name: "quote",
    stateMutability: "nonpayable",
    inputs: [{ name: "route", type: "bytes" }],
    outputs: [
      { name: "specifiedToken", type: "address" },
      { name: "calculatedToken", type: "address" },
      { name: "specifiedAmount", type: "int256" },
      { name: "calculatedAmount", type: "int256" },
    ],
  },
] as const;

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
  /**
   * Accept a partial fill and account for the amount actually swapped.
   * Only valid for single-hop paths with a nonzero specified amount.
   */
  allowPartial?: boolean;
}

export interface ForwardedHop {
  type: "forwarded";
  /**
   * Core forward target. Defaults to the extension encoded in poolKey.config.
   * Set this when routing through an adapter instead of the pool extension.
   */
  forwardee?: Address;
  poolKey: PoolKey;
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
  /**
   * Accept a partial fill and account for the amount actually swapped.
   * Only valid for single-hop paths with a nonzero specified amount.
   */
  allowPartial?: boolean;
}

export interface SignedExclusiveSwapHop {
  type: "signedExclusiveSwap";
  /**
   * Core forward target. Defaults to the extension encoded in poolKey.config.
   */
  forwardee?: Address;
  poolKey: PoolKey;
  meta: bigint | Hex;
  minBalanceUpdate: Hex;
  signature: Hex;
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
}

export interface WrapperHop {
  type: "wrapper";
  underlying: Address;
  wrapped: Address;
}

export type Hop = CoreHop | ForwardedHop | SignedExclusiveSwapHop | WrapperHop;

export interface MultiHop {
  specifiedAmount: bigint;
  hops: readonly Hop[];
}

export interface EncodeRoutesParameters {
  specifiedToken: Address;
  calculatedToken: Address;
  /**
   * Minimum output for exact-in routes or maximum input for exact-out routes.
   * Pass false to explicitly use the legacy unbounded threshold.
   */
  calculatedAmountThreshold: bigint | false;
  recipient?: Address;
  multiHops: readonly MultiHop[];
}

export interface EncodeRouteParameters {
  specifiedToken: Address;
  calculatedToken: Address;
  specifiedAmount: bigint;
  /**
   * Minimum output for exact-in routes or maximum input for exact-out routes.
   * Pass false to explicitly use the legacy unbounded threshold.
   */
  calculatedAmountThreshold: bigint | false;
  recipient?: Address;
  hops: readonly Hop[];
}

export type Parameters = EncodeRoutesParameters;

export interface EvmQuoterPoolKey {
  token0: Address;
  token1: Address;
  config: Hex;
}

export type EvmQuoterRouteNode =
  | {
      swap: {
        type: "core" | "forwarded";
        pool_key: EvmQuoterPoolKey;
        sqrt_ratio_limit: Hex;
        skip_ahead: number;
      };
      wrapped_token?: never;
    }
  | {
      wrapped_token: {
        underlying: Address;
        wrapped: Address;
      };
      swap?: never;
    };

export type EvmQuoterQuoteType = "exact_input" | "exact_output";

export interface EvmQuoterQuote {
  block_number: number | string | bigint;
  block_hash: Hex;
  total_calculated: string;
  estimated_gas_cost: number;
  price_impact: number | null;
  splits: readonly {
    amount_specified: string;
    amount_calculated: string;
    route: readonly EvmQuoterRouteNode[];
  }[];
}

export interface PrepareSwapFromQuoteParameters {
  quote: EvmQuoterQuote;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  /** Positive exact-input or exact-output amount in base units. */
  amount: string | bigint;
  slippageBps: number | bigint;
  recipient?: Address;
  routerAddress?: Address;
}

export interface BuildQuoterQuoteUrlParameters {
  quoterUrl: string;
  chainId: number | string | bigint;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  /** Positive exact-input or exact-output amount in base units. */
  amount: string | bigint;
}

export interface PreparedSwap {
  quoteType: EvmQuoterQuoteType;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint | null;
  maximumAmountIn: bigint | null;
  calculatedAmountThreshold: bigint;
  slippageBps: bigint;
  block: {
    number: bigint;
    hash: Hex;
  };
  route: Hex;
  quoteCalldata: Hex;
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
  };
  approval: {
    token: Address;
    spender: Address;
    amount: bigint;
  } | null;
  recipient: Address | null;
  estimatedRouteGas: number;
  priceImpact: number | null;
}

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

export function encodeQuoteCalldata(route: Hex): Hex {
  return encodeFunctionData({
    abi: YUL_ROUTER_ABI,
    functionName: "quote",
    args: [route],
  });
}

export function generateQuoteCalldata(params: EncodeRoutesParameters): Hex {
  return encodeQuoteCalldata(encodeRoutes(params));
}

/**
 * Maps explicit swap intent to the quoter's canonical signed-amount URL.
 */
export function buildQuoterQuoteUrl({
  quoterUrl,
  chainId,
  tokenIn,
  tokenOut,
  quoteType,
  amount,
}: BuildQuoterQuoteUrlParameters): string {
  const chain = parseUnsignedRawAmount(chainId, "chainId");
  if (chain === 0n) {
    throw new Error("chainId must be greater than zero");
  }
  if (quoteType !== "exact_input" && quoteType !== "exact_output") {
    throw new Error(`unsupported quote type: ${String(quoteType)}`);
  }

  const input = getAddress(tokenIn);
  const output = getAddress(tokenOut);
  if (input === output) {
    throw new Error("quote input and output tokens must differ");
  }

  const positiveAmount = parsePositiveAmount(amount, "amount");
  const exactOutput = quoteType === "exact_output";
  const signedAmount = exactOutput ? -positiveAmount : positiveAmount;
  assertInt128(signedAmount, "signed quote amount");
  const specifiedToken = exactOutput ? output : input;
  const otherToken = exactOutput ? input : output;
  const base = quoterUrl.replace(/\/+$/, "");
  if (base.length === 0) {
    throw new Error("quoterUrl must not be empty");
  }

  return `${base}/${chain}/${signedAmount}/${specifiedToken}/${otherToken}`;
}

/**
 * Converts a canonical EVM quoter response and its request intent into
 * validated Yul router calldata.
 * The result is unsigned and contains both the executable route and calldata
 * for the router's read-only quote(bytes) simulation entrypoint.
 */
export function prepareSwapFromQuote({
  quote,
  tokenIn: requestedTokenIn,
  tokenOut: requestedTokenOut,
  quoteType,
  amount,
  slippageBps,
  recipient,
  routerAddress = YUL_ROUTER_ADDRESS,
}: PrepareSwapFromQuoteParameters): PreparedSwap {
  if (quoteType !== "exact_input" && quoteType !== "exact_output") {
    throw new Error(`unsupported quote type: ${String(quoteType)}`);
  }
  if (!Array.isArray(quote.splits) || quote.splits.length === 0) {
    throw new Error("quote must contain at least one split");
  }
  if (
    !Number.isSafeInteger(quote.estimated_gas_cost) ||
    quote.estimated_gas_cost < 0
  ) {
    throw new Error("estimated_gas_cost must be a nonnegative safe integer");
  }
  if (
    quote.price_impact !== null &&
    (typeof quote.price_impact !== "number" ||
      !Number.isFinite(quote.price_impact))
  ) {
    throw new Error("price_impact must be a finite number or null");
  }

  const tokenIn = getAddress(requestedTokenIn);
  const tokenOut = getAddress(requestedTokenOut);
  if (tokenIn === tokenOut) {
    throw new Error("quote input and output tokens must differ");
  }

  const requestedAmount = parsePositiveAmount(amount, "amount");
  const bps = parseSlippageBps(slippageBps);
  const isExactOutput = quoteType === "exact_output";
  const expectedSpecified = isExactOutput ? -requestedAmount : requestedAmount;
  assertInt128(expectedSpecified, "specified amount");
  const quotedCalculated = parseSignedRawAmount(
    quote.total_calculated,
    "total_calculated",
  );
  if (
    quotedCalculated === 0n ||
    (isExactOutput ? quotedCalculated > 0n : quotedCalculated < 0n)
  ) {
    throw new Error("total_calculated has the wrong sign for the quote type");
  }
  const amountIn = isExactOutput ? -quotedCalculated : requestedAmount;
  const amountOut = isExactOutput ? requestedAmount : quotedCalculated;

  const specifiedTotal = quote.splits.reduce(
    (total, split) =>
      total + parseSignedRawAmount(split.amount_specified, "amount_specified"),
    0n,
  );
  const calculatedTotal = quote.splits.reduce(
    (total, split) =>
      total + parseSignedRawAmount(split.amount_calculated, "amount_calculated"),
    0n,
  );
  if (specifiedTotal !== expectedSpecified) {
    throw new Error(
      `quote split specified total ${specifiedTotal} does not match ${expectedSpecified}`,
    );
  }
  if (calculatedTotal !== quotedCalculated) {
    throw new Error(
      `quote split calculated total ${calculatedTotal} does not match ${quotedCalculated}`,
    );
  }

  const calculatedAmountThreshold = isExactOutput
    ? -divideRoundingUp(amountIn * (10_000n + bps), 10_000n)
    : maxBigInt(1n, (amountOut * 10_000n) / (10_000n + bps));
  assertInt128(calculatedAmountThreshold, "calculatedAmountThreshold");

  const specifiedToken = isExactOutput ? tokenOut : tokenIn;
  const calculatedToken = isExactOutput ? tokenIn : tokenOut;
  const route = encodeRoutes({
    specifiedToken,
    calculatedToken,
    calculatedAmountThreshold,
    recipient,
    multiHops: quote.splits.map((split) => ({
      specifiedAmount: BigInt(split.amount_specified),
      hops: split.route.map(quoterNodeToHop),
    })),
  });

  const router = getAddress(routerAddress);
  const inputLimit = isExactOutput
    ? -calculatedAmountThreshold
    : amountIn;
  const isNativeInput = hexToBigInt(tokenIn) === 0n;

  return {
    quoteType,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    minimumAmountOut: isExactOutput ? null : calculatedAmountThreshold,
    maximumAmountIn: isExactOutput ? inputLimit : null,
    calculatedAmountThreshold,
    slippageBps: bps,
    block: {
      number: parseUnsignedRawAmount(quote.block_number, "block_number"),
      hash: normalizeBlockHash(quote.block_hash),
    },
    route,
    quoteCalldata: encodeQuoteCalldata(route),
    transaction: {
      to: router,
      data: route,
      value: isNativeInput ? inputLimit : 0n,
    },
    approval: isNativeInput
      ? null
      : {
          token: tokenIn,
          spender: router,
          amount: inputLimit,
        },
    recipient: recipient === undefined ? null : getAddress(recipient),
    estimatedRouteGas: quote.estimated_gas_cost,
    priceImpact: quote.price_impact,
  };
}

function quoterNodeToHop(node: EvmQuoterRouteNode): Hop {
  if (node.wrapped_token !== undefined) {
    return {
      type: "wrapper",
      underlying: node.wrapped_token.underlying,
      wrapped: node.wrapped_token.wrapped,
    };
  }
  if (node.swap === undefined) {
    throw new Error("unknown EVM quoter route node");
  }

  const common = {
    poolKey: node.swap.pool_key,
    sqrtRatioLimit: BigInt(node.swap.sqrt_ratio_limit),
    skipAhead: node.swap.skip_ahead,
  };
  switch (node.swap.type) {
    case "core":
      return { type: "core", ...common };
    case "forwarded":
      return { type: "forwarded", ...common };
    default:
      throw new Error(
        `unsupported EVM quoter swap type: ${String(node.swap.type)}`,
      );
  }
}

function parsePositiveAmount(value: string | bigint, name: string): bigint {
  const amount =
    typeof value === "bigint" ? value : parseSignedRawAmount(value, name);
  if (amount <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }
  return amount;
}

function parseSignedRawAmount(value: string, name: string): bigint {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a base-10 integer string`);
  }
  return BigInt(value);
}

function parseUnsignedRawAmount(
  value: number | string | bigint,
  name: string,
): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a nonnegative safe integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error(`${name} must be a nonnegative base-10 integer`);
    }
    return BigInt(value);
  }
  if (value < 0n) {
    throw new Error(`${name} must be nonnegative`);
  }
  return value;
}

function parseSlippageBps(value: number | bigint): bigint {
  const bps = parseUnsignedRawAmount(value, "slippageBps");
  if (bps > 10_000n) {
    throw new Error("slippageBps must be at most 10000");
  }
  return bps;
}

function divideRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function normalizeBlockHash(hash: Hex): Hex {
  try {
    return numberToHex(BigInt(hash), { size: 32 });
  } catch {
    throw new Error("block_hash must fit into bytes32");
  }
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
    throw new Error(
      `multiHops length must be between 1 and ${MAX_MULTIHOP_LENGTH}`,
    );
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
      throw new Error(
        `each multi-hop needs between 1 and ${MAX_HOP_LENGTH} hops`,
      );
    }

    const partialHop = hops.find(
      (hop) =>
        (hop.type === "core" || hop.type === "forwarded") && hop.allowPartial,
    );
    if (partialHop && (hops.length !== 1 || specifiedAmount === 0n)) {
      throw new Error(
        "allowPartial is only valid for single-hop paths with a nonzero specifiedAmount",
      );
    }

    let currentToken = specified;
    const encodedHops: Hex[] = [];

    for (const hop of hops) {
      switch (hop.type) {
        case "core": {
          const { nextToken } = resolvePoolHop(currentToken, hop.poolKey);
          encodedHops.push(
            encodeSwapHop(
              "00",
              hop.poolKey,
              hop.sqrtRatioLimit,
              hop.skipAhead,
              hop.allowPartial,
            ),
          );
          currentToken = nextToken;
          break;
        }
        case "forwarded": {
          const { poolKey } = hop;
          const forwardee = resolveForwardee(poolKey, hop.forwardee);
          const { nextToken } = resolvePoolHop(currentToken, poolKey);
          encodedHops.push(
            concatHex([
              "0x01",
              encodeAddress(forwardee),
              encodePoolKey(poolKey),
              encodeSqrtRatioLimit(hop.sqrtRatioLimit),
              encodeSwapControl(hop.skipAhead, hop.allowPartial),
            ]),
          );
          currentToken = nextToken;
          break;
        }
        case "signedExclusiveSwap": {
          const { poolKey } = hop;
          const forwardee = resolveForwardee(poolKey, hop.forwardee);
          const { nextToken } = resolvePoolHop(currentToken, poolKey);
          encodedHops.push(
            concatHex([
              "0x04",
              encodeAddress(forwardee),
              encodePoolKey(poolKey),
              encodeSqrtRatioLimit(hop.sqrtRatioLimit),
              encodeSwapControl(hop.skipAhead),
              encodeUint256(hop.meta, "meta"),
              encodeBytes32(hop.minBalanceUpdate, "minBalanceUpdate"),
              encodeSignature(hop.signature),
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
          encodedHops.push(
            concatHex([
              "0x02",
              encodeAddress(underlying),
              encodeAddress(wrapped),
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
        encodeInt128(specifiedAmount),
        numberToHex(hops.length - 1, { size: 1 }),
        ...encodedHops,
      ]),
    );
  }

  if (calculatedAmountThreshold === undefined) {
    throw new Error("calculatedAmountThreshold is required");
  }

  const threshold =
    calculatedAmountThreshold === false
      ? isExactOut === true
        ? MIN_CALCULATED_AMOUNT_THRESHOLD
        : 0n
      : calculatedAmountThreshold;
  assertInt128(threshold, "calculatedAmountThreshold");

  if (
    threshold !== 0n &&
    isExactOut !== undefined &&
    threshold < 0n !== isExactOut
  ) {
    throw new Error(
      "calculatedAmountThreshold sign and specified amount signs have to match",
    );
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

function resolveForwardee(
  poolKey: PoolKey,
  forwardee: Address | undefined,
): Address {
  const resolved =
    forwardee === undefined
      ? getAddress(`0x${padHex(poolKey.config, { size: 32 }).slice(2, 42)}`)
      : getAddress(forwardee);
  if (hexToBigInt(resolved) === 0n) {
    throw new Error(
      "forwarded hop needs a forwardee or a nonzero pool extension",
    );
  }
  return resolved;
}

function encodeSwapHop(
  kind: "00",
  poolKey: PoolKey,
  sqrtRatioLimit?: bigint,
  skipAhead?: number,
  allowPartial?: boolean,
): Hex {
  return concatHex([
    `0x${kind}`,
    encodePoolKey(poolKey),
    encodeSqrtRatioLimit(sqrtRatioLimit),
    encodeSwapControl(skipAhead, allowPartial),
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

function encodeUint256(value: bigint | Hex, name: string): Hex {
  if (typeof value === "bigint") {
    if (value < 0n || value > (1n << 256n) - 1n) {
      throw new Error(`${name} must fit into uint256`);
    }
    return numberToHex(value, { size: 32 });
  }
  return encodeBytes32(value, name);
}

function encodeBytes32(value: Hex, name: string): Hex {
  if (size(value) > 32) {
    throw new Error(`${name} must fit into bytes32`);
  }
  return padHex(value, { size: 32 });
}

function encodeSignature(signature: Hex): Hex {
  const signatureLength = size(signature);
  if (signatureLength > 0xffffffff) {
    throw new Error("signature length must fit into uint32");
  }
  return concatHex([numberToHex(signatureLength, { size: 4 }), signature]);
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

function encodeSwapControl(skipAhead = 0, allowPartial = false): Hex {
  if (!Number.isInteger(skipAhead) || skipAhead < 0 || skipAhead > 0x7fffffff) {
    throw new Error("skipAhead must fit into uint31");
  }
  const encoded =
    BigInt(skipAhead) | (allowPartial ? 0x80000000n : 0n);
  return numberToHex(encoded, { size: 4 });
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

export function encodePoolBalanceUpdate(delta0: bigint, delta1: bigint): Hex {
  assertInt128(delta0, "delta0");
  assertInt128(delta1, "delta1");
  return numberToHex(
    (BigInt.asUintN(128, delta0) << 128n) | BigInt.asUintN(128, delta1),
    {
      size: 32,
    },
  );
}

export interface EncodeSignedSwapMetaParameters {
  authorizedLocker?: Address;
  deadline: number;
  fee?: number;
  nonce: bigint;
}

export function encodeSignedSwapMeta(
  params: EncodeSignedSwapMetaParameters,
): Hex {
  const {
    authorizedLocker = "0x0000000000000000000000000000000000000000",
    deadline,
    fee = 0,
    nonce,
  } = params;

  if (!Number.isInteger(deadline) || deadline < 0 || deadline > 0xffffffff) {
    throw new Error("deadline must fit into uint32");
  }
  if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffffff) {
    throw new Error("fee must fit into uint32");
  }

  if (typeof nonce !== "bigint") {
    throw new Error("nonce must be a bigint");
  }
  if (nonce < 0n || nonce > (1n << 64n) - 1n) {
    throw new Error("nonce must fit into uint64");
  }

  const lockerLow128 =
    hexToBigInt(getAddress(authorizedLocker)) & ((1n << 128n) - 1n);
  const meta =
    (BigInt(deadline) << 224n) |
    (BigInt(fee) << 192n) |
    (nonce << 128n) |
    lockerLow128;

  return numberToHex(meta, { size: 32 });
}

export function calldataSize(data: Hex): number {
  return size(data);
}
