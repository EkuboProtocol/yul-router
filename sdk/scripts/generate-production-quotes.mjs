import { encodeAbiParameters, getAddress, numberToHex } from "viem";
import { encodeRoutes } from "../src/index.ts";

const CHAIN_ID = 1;
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const QUOTER_URL =
  process.env.EKUBO_QUOTER_URL ?? "https://prod-api-quoter.ekubo.org";
const SLIPPAGE_DENOMINATOR = 10_000n;
const SLIPPAGE_BPS = 500n;

const requests = [
  {
    name: "ETH to USDC exact input",
    inputToken: NATIVE,
    outputToken: USDC,
    amount: 100_000_000_000_000_000n,
  },
  {
    name: "USDC to ETH exact output",
    inputToken: USDC,
    outputToken: NATIVE,
    amount: -50_000_000_000_000_000n,
  },
  {
    name: "USDC to ETH exact input",
    inputToken: USDC,
    outputToken: NATIVE,
    amount: 100_000_000n,
  },
  {
    name: "USDC to WBTC exact input",
    inputToken: USDC,
    outputToken: WBTC,
    amount: 100_000_000n,
  },
];

function quoteUrl({ inputToken, outputToken, amount }) {
  const [specifiedToken, calculatedToken] =
    amount < 0n
      ? [outputToken, inputToken]
      : [inputToken, outputToken];
  return `${QUOTER_URL}/${CHAIN_ID}/${amount}/${specifiedToken}/${calculatedToken}`;
}

async function fetchQuote(request) {
  const url = quoteUrl(request);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await Bun.sleep(attempt * 1_000);
    }
  }

  throw new Error(`quote request failed for ${request.name}: ${lastError}`);
}

function extensionFromConfig(config) {
  return getAddress(numberToHex(BigInt(config) >> 96n, { size: 20 }));
}

function toSdkHop(node) {
  if (node.wrapped_token !== undefined) {
    return {
      type: "wrapper",
      underlying: node.wrapped_token.underlying,
      wrapped: node.wrapped_token.wrapped,
    };
  }

  if (node.swap === undefined) throw new Error("unknown quote route node");

  const {
    type,
    pool_key: poolKey,
    sqrt_ratio_limit: sqrtRatioLimit,
    skip_ahead: skipAhead,
  } = node.swap;
  const common = {
    poolKey,
    sqrtRatioLimit: BigInt(sqrtRatioLimit),
    skipAhead,
  };

  if (type === "core") return { type, ...common };
  if (type === "forwarded") {
    return {
      type,
      forwardee: extensionFromConfig(poolKey.config),
      ...common,
    };
  }
  throw new Error(`unsupported quote swap type: ${type}`);
}

function calculatedAmountThreshold(totalCalculated) {
  return totalCalculated < 0n
    ? (totalCalculated * (SLIPPAGE_DENOMINATOR + SLIPPAGE_BPS)) /
        SLIPPAGE_DENOMINATOR
    : (totalCalculated * SLIPPAGE_DENOMINATOR) /
        (SLIPPAGE_DENOMINATOR + SLIPPAGE_BPS);
}

async function buildCase(request) {
  const quote = await fetchQuote(request);
  if (!Array.isArray(quote.splits) || quote.splits.length === 0) {
    throw new Error(`production quoter returned no route for ${request.name}`);
  }

  const exactOutput = request.amount < 0n;
  const specifiedToken = exactOutput ? request.outputToken : request.inputToken;
  const calculatedToken = exactOutput ? request.inputToken : request.outputToken;
  const specifiedAmount = quote.splits.reduce(
    (sum, split) => sum + BigInt(split.amount_specified),
    0n,
  );
  const quotedCalculated = BigInt(quote.total_calculated);
  const threshold = calculatedAmountThreshold(quotedCalculated);

  if (specifiedAmount !== request.amount) {
    throw new Error(
      `${request.name}: split amounts sum to ${specifiedAmount}, expected ${request.amount}`,
    );
  }
  if ((quotedCalculated < 0n) !== exactOutput || quotedCalculated === 0n) {
    throw new Error(`${request.name}: invalid total_calculated sign`);
  }

  const data = encodeRoutes({
    specifiedToken,
    calculatedToken,
    calculatedAmountThreshold: threshold,
    multiHops: quote.splits.map((split) => ({
      specifiedAmount: BigInt(split.amount_specified),
      hops: split.route.map(toSdkHop),
    })),
  });

  return {
    name: request.name,
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    specifiedAmount,
    quotedCalculated,
    threshold,
    data,
  };
}

const cases = await Promise.all(requests.map(buildCase));

process.stdout.write(
  encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "name", type: "string" },
          { name: "inputToken", type: "address" },
          { name: "outputToken", type: "address" },
          { name: "specifiedAmount", type: "int256" },
          { name: "quotedCalculated", type: "int256" },
          { name: "threshold", type: "int256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [cases],
  ),
);
