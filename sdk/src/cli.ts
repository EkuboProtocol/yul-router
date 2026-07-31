#!/usr/bin/env node

import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  Hex,
  keccak256,
  numberToHex,
  parseUnits,
  stringToHex,
} from "viem";
import {
  buildQuoterQuoteUrl,
  type EvmQuoterQuote,
  prepareSwapFromQuote,
  YUL_ROUTER_ABI,
} from "./index.js";

const DEFAULT_API_URL = "https://prod-api.ekubo.org";
const DEFAULT_QUOTER_URL = "https://prod-api-quoter.ekubo.org";
const PREPARE_FLAGS = new Set([
  "chain-id",
  "token-in",
  "token-out",
  "type",
  "amount",
  "amount-raw",
  "slippage-bps",
  "sender",
  "recipient",
  "rpc-url",
  "api-url",
  "quoter-url",
]);
const ROUTE_RESULT_PARAMETERS = [
  { type: "address" },
  { type: "address" },
  { type: "int256" },
  { type: "int256" },
] as const;

interface TokenInfo {
  chain_id: string;
  name: string;
  symbol: string;
  decimals: number;
  address: `0x${string}`;
  visibility_priority: number;
  usd_price: number | null;
}

interface PrepareArguments {
  chainId: string;
  tokenIn: string;
  tokenOut: string;
  quoteType: "exact_input" | "exact_output";
  amount?: string;
  amountRaw?: string;
  slippageBps: bigint;
  sender?: `0x${string}`;
  recipient?: `0x${string}`;
  rpcUrl?: string;
  apiUrl: string;
  quoterUrl: string;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function main() {
  const [command, ...rawArguments] = process.argv.slice(2);
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    rawArguments.includes("--help")
  ) {
    printHelp();
    return;
  }
  if (command !== "prepare") {
    throw new CliError("unknown_command", `Unknown command: ${command}`);
  }

  const args = parsePrepareArguments(rawArguments);
  const [tokenIn, tokenOut] = await Promise.all([
    resolveToken(args.apiUrl, args.chainId, args.tokenIn),
    resolveToken(args.apiUrl, args.chainId, args.tokenOut),
  ]);
  if (BigInt(tokenIn.address) === BigInt(tokenOut.address)) {
    throw new CliError(
      "identical_tokens",
      "Input and output token resolve to the same address",
    );
  }

  const specifiedToken =
    args.quoteType === "exact_input" ? tokenIn : tokenOut;
  const amountRaw = parseSpecifiedAmount(args, specifiedToken.decimals);
  const quote = await fetchQuote(args, tokenIn, tokenOut, amountRaw);
  let prepared: ReturnType<typeof prepareSwapFromQuote>;
  try {
    prepared = prepareSwapFromQuote({
      quote,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      quoteType: args.quoteType,
      amount: amountRaw,
      slippageBps: args.slippageBps,
      recipient: args.recipient,
    });
  } catch (error) {
    throw new CliError(
      "invalid_quote_response",
      error instanceof Error ? error.message : String(error),
    );
  }
  const simulation = args.rpcUrl
    ? await simulate(args.rpcUrl, prepared, args.sender)
    : {
        status: "not_run" as const,
        mode: "none" as const,
        reason: "Pass --rpc-url to simulate the route at its quote block",
      };

  const planIdentity = {
    chain_id: args.chainId,
    block_number: prepared.block.number.toString(),
    block_hash: prepared.block.hash,
    sender: args.sender ?? null,
    recipient: prepared.recipient,
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: prepared.transaction.value.toString(),
  };
  const planId = keccak256(stringToHex(JSON.stringify(planIdentity)));

  const minimumAmountOut = prepared.minimumAmountOut;
  const maximumAmountIn = prepared.maximumAmountIn;
  const output = {
    schema_version: "1",
    action: "ekubo_swap",
    plan_id: planId,
    requires_user_confirmation: true,
    chain_id: args.chainId,
    tokens: {
      input: tokenIn,
      output: tokenOut,
    },
    quote: {
      type: prepared.quoteType,
      amount_in: prepared.amountIn.toString(),
      amount_in_formatted: formatUnits(prepared.amountIn, tokenIn.decimals),
      amount_out: prepared.amountOut.toString(),
      amount_out_formatted: formatUnits(
        prepared.amountOut,
        tokenOut.decimals,
      ),
      minimum_amount_out: minimumAmountOut?.toString() ?? null,
      minimum_amount_out_formatted:
        minimumAmountOut === null
          ? null
          : formatUnits(minimumAmountOut, tokenOut.decimals),
      maximum_amount_in: maximumAmountIn?.toString() ?? null,
      maximum_amount_in_formatted:
        maximumAmountIn === null
          ? null
          : formatUnits(maximumAmountIn, tokenIn.decimals),
      slippage_bps: prepared.slippageBps.toString(),
      price_impact: prepared.priceImpact,
      estimated_route_gas: prepared.estimatedRouteGas,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
    },
    transaction: {
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      value: prepared.transaction.value.toString(),
    },
    approval:
      prepared.approval === null
        ? null
        : {
            token: prepared.approval.token,
            spender: prepared.approval.spender,
            amount: prepared.approval.amount.toString(),
          },
    simulation,
    confirmation: {
      summary:
        prepared.quoteType === "exact_input"
          ? `Swap exactly ${formatUnits(prepared.amountIn, tokenIn.decimals)} ${tokenIn.symbol} for at least ${formatUnits(minimumAmountOut!, tokenOut.decimals)} ${tokenOut.symbol}`
          : `Spend at most ${formatUnits(maximumAmountIn!, tokenIn.decimals)} ${tokenIn.symbol} to receive exactly ${formatUnits(prepared.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`,
      slippage_bps: prepared.slippageBps.toString(),
      recipient: prepared.recipient ?? args.sender ?? "transaction_sender",
      input_token_address: tokenIn.address,
      output_token_address: tokenOut.address,
      simulation_status: simulation.status,
      instruction:
        "Confirm this exact plan_id and slippage tolerance before submitting the unsigned transaction. Re-prepare after any change.",
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

function parsePrepareArguments(rawArguments: string[]): PrepareArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < rawArguments.length; index += 2) {
    const flag = rawArguments[index];
    const value = rawArguments[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new CliError(
        "invalid_arguments",
        `Expected --name value pairs, received ${flag ?? "end of input"}`,
      );
    }
    const name = flag.slice(2);
    if (!PREPARE_FLAGS.has(name)) {
      throw new CliError("unknown_argument", `Unknown argument: --${name}`);
    }
    if (values.has(name)) {
      throw new CliError("duplicate_argument", `Duplicate argument: --${name}`);
    }
    values.set(name, value);
  }

  const chainId = required(values, "chain-id");
  if (!/^[0-9]+$/.test(chainId)) {
    throw new CliError("invalid_chain_id", "--chain-id must be decimal digits");
  }
  const rawQuoteType = required(values, "type").replaceAll("-", "_");
  if (rawQuoteType !== "exact_input" && rawQuoteType !== "exact_output") {
    throw new CliError(
      "invalid_quote_type",
      "--type must be exact-input or exact-output",
    );
  }
  const amount = values.get("amount");
  const amountRaw = values.get("amount-raw");
  if ((amount === undefined) === (amountRaw === undefined)) {
    throw new CliError(
      "invalid_amount",
      "Provide exactly one of --amount or --amount-raw",
    );
  }
  const rawSlippage = required(values, "slippage-bps");
  if (!/^[0-9]+$/.test(rawSlippage)) {
    throw new CliError(
      "invalid_slippage",
      "--slippage-bps must be a nonnegative integer",
    );
  }
  const slippageBps = BigInt(rawSlippage);
  if (slippageBps > 10_000n) {
    throw new CliError(
      "invalid_slippage",
      "--slippage-bps must be at most 10000",
    );
  }

  return {
    chainId,
    tokenIn: required(values, "token-in"),
    tokenOut: required(values, "token-out"),
    quoteType: rawQuoteType,
    amount,
    amountRaw,
    slippageBps,
    sender: optionalAddress(values, "sender"),
    recipient: optionalAddress(values, "recipient"),
    rpcUrl: values.get("rpc-url"),
    apiUrl: values.get("api-url") ?? process.env.EKUBO_API_URL ?? DEFAULT_API_URL,
    quoterUrl:
      values.get("quoter-url") ??
      process.env.EKUBO_QUOTER_URL ??
      DEFAULT_QUOTER_URL,
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new CliError("missing_argument", `Missing required --${name}`);
  }
  return value;
}

function optionalAddress(
  values: Map<string, string>,
  name: string,
): `0x${string}` | undefined {
  const value = values.get(name);
  if (value === undefined) return undefined;
  try {
    return getAddress(value);
  } catch {
    throw new CliError("invalid_address", `--${name} must be an EVM address`);
  }
}

function parseSpecifiedAmount(args: PrepareArguments, decimals: number): bigint {
  let amount: bigint;
  try {
    amount =
      args.amountRaw === undefined
        ? parseUnits(args.amount!, decimals)
        : /^[0-9]+$/.test(args.amountRaw)
          ? BigInt(args.amountRaw)
          : -1n;
  } catch {
    throw new CliError(
      "invalid_amount",
      `Amount cannot be represented with ${decimals} token decimals`,
    );
  }
  if (amount <= 0n) {
    throw new CliError("invalid_amount", "Amount must be greater than zero");
  }
  return amount;
}

async function resolveToken(
  apiUrl: string,
  chainId: string,
  identifier: string,
): Promise<TokenInfo> {
  if (/^0x[0-9a-fA-F]+$/.test(identifier)) {
    const token = await fetchJson<TokenInfo>(
      `${apiUrl}/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(identifier)}`,
    );
    return validateEvmToken(token, chainId);
  }

  const url = new URL(`${apiUrl}/tokens`);
  url.searchParams.set("chainId", chainId);
  url.searchParams.set("search", identifier);
  url.searchParams.set("pageSize", "50");
  const matches = await fetchJson<TokenInfo[]>(url.toString());
  if (!Array.isArray(matches)) {
    throw new CliError(
      "invalid_token_list_response",
      "Token-list search did not return an array",
    );
  }
  const normalized = identifier.toLocaleLowerCase("en-US");
  const exact = matches
    .filter(
      (token) =>
        (typeof token.symbol === "string" &&
          token.symbol.toLocaleLowerCase("en-US") === normalized) ||
        (typeof token.name === "string" &&
          token.name.toLocaleLowerCase("en-US") === normalized),
    )
    .sort((left, right) => right.visibility_priority - left.visibility_priority);

  if (exact.length !== 1) {
    throw new CliError(
      exact.length === 0 ? "token_not_found" : "ambiguous_token",
      exact.length === 0
        ? `No exact token symbol or name matches ${identifier}`
        : `${identifier} matches more than one token; retry with an address`,
      {
        candidates: (exact.length === 0 ? matches : exact).map((token) => ({
          name: token.name,
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          visibility_priority: token.visibility_priority,
        })),
      },
    );
  }
  return validateEvmToken(exact[0]!, chainId);
}

function validateEvmToken(token: TokenInfo, chainId: string): TokenInfo {
  let tokenChainId: bigint;
  let address: `0x${string}`;
  try {
    tokenChainId = BigInt(token.chain_id);
    address = getAddress(token.address);
  } catch {
    throw new CliError(
      "unsupported_token",
      "The token-list result is not an EVM token",
      { token },
    );
  }
  if (tokenChainId !== BigInt(chainId)) {
    throw new CliError(
      "token_chain_mismatch",
      "The token-list result belongs to a different chain",
      { requested_chain_id: chainId, token_chain_id: token.chain_id },
    );
  }
  if (
    typeof token.name !== "string" ||
    typeof token.symbol !== "string" ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    !Number.isFinite(token.visibility_priority)
  ) {
    throw new CliError(
      "invalid_token_list_response",
      "Token metadata is incomplete or invalid",
      { token },
    );
  }
  return { ...token, address };
}

async function fetchQuote(
  args: PrepareArguments,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountRaw: bigint,
): Promise<EvmQuoterQuote> {
  const url = buildQuoterQuoteUrl({
    quoterUrl: args.quoterUrl,
    chainId: args.chainId,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    quoteType: args.quoteType,
    amount: amountRaw,
  });
  return fetchJson<EvmQuoterQuote>(url, {
    headers: { accept: "application/json" },
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) {
    let details: unknown = body;
    try {
      details = JSON.parse(body);
    } catch {
      // Keep the raw response body.
    }
    throw new CliError(
      "http_error",
      `${response.status} ${response.statusText} from ${url}`,
      details,
    );
  }
  return JSON.parse(body) as T;
}

async function simulate(
  rpcUrl: string,
  prepared: ReturnType<typeof prepareSwapFromQuote>,
  sender: `0x${string}` | undefined,
) {
  const rpc = createRpcClient(rpcUrl);
  const blockNumber = numberToHex(prepared.block.number);
  const block = await rpc<{ hash: Hex }>("eth_getBlockByNumber", [
    blockNumber,
    false,
  ]);
  if (BigInt(block.hash) !== BigInt(prepared.block.hash)) {
    throw new CliError(
      "quote_block_mismatch",
      `RPC block ${blockNumber} does not match quote block hash`,
      { expected: prepared.block.hash, actual: block.hash },
    );
  }

  const routeResult = await rpc<Hex>("eth_call", [
    {
      to: prepared.transaction.to,
      data: prepared.quoteCalldata,
    },
    blockNumber,
  ]);
  const [specifiedToken, calculatedToken, specifiedAmount, calculatedAmount] =
    decodeFunctionResult({
      abi: YUL_ROUTER_ABI,
      functionName: "quote",
      data: routeResult,
    });
  const routeSimulation = {
    specified_token: specifiedToken,
    calculated_token: calculatedToken,
    specified_amount: specifiedAmount.toString(),
    calculated_amount: calculatedAmount.toString(),
  };
  validateRouteResult(
    prepared,
    specifiedToken,
    calculatedToken,
    specifiedAmount,
    calculatedAmount,
  );

  if (sender === undefined) {
    return {
      status: "success" as const,
      mode: "route_only" as const,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
      result: routeSimulation,
      warning:
        "Route simulation does not prove that a specific sender has sufficient balance or allowance",
    };
  }

  const account = await readAccountRequirements(
    rpc,
    blockNumber,
    sender,
    prepared,
  );
  try {
    const result = await rpc<Hex>("eth_call", [
      {
        from: sender,
        to: prepared.transaction.to,
        data: prepared.transaction.data,
        value: numberToHex(prepared.transaction.value),
      },
      blockNumber,
    ]);
    const [
      actualSpecifiedToken,
      actualCalculatedToken,
      actualSpecifiedAmount,
      actualCalculatedAmount,
    ] = decodeAbiParameters(ROUTE_RESULT_PARAMETERS, result);
    validateRouteResult(
      prepared,
      actualSpecifiedToken,
      actualCalculatedToken,
      actualSpecifiedAmount,
      actualCalculatedAmount,
    );
    return {
      status: "success" as const,
      mode: "exact_sender" as const,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
      result: {
        ...routeSimulation,
        actual_specified_token: actualSpecifiedToken,
        actual_calculated_token: actualCalculatedToken,
        actual_specified_amount: actualSpecifiedAmount.toString(),
        actual_calculated_amount: actualCalculatedAmount.toString(),
      },
      account,
    };
  } catch (error) {
    return {
      status: "failed" as const,
      mode: "exact_sender" as const,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
      route_result: routeSimulation,
      account,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateRouteResult(
  prepared: ReturnType<typeof prepareSwapFromQuote>,
  specifiedToken: `0x${string}`,
  calculatedToken: `0x${string}`,
  specifiedAmount: bigint,
  calculatedAmount: bigint,
) {
  const exactOutput = prepared.quoteType === "exact_output";
  const expectedSpecifiedToken = exactOutput
    ? prepared.tokenOut
    : prepared.tokenIn;
  const expectedCalculatedToken = exactOutput
    ? prepared.tokenIn
    : prepared.tokenOut;
  const expectedSpecifiedAmount = exactOutput
    ? -prepared.amountOut
    : prepared.amountIn;
  if (
    getAddress(specifiedToken) !== expectedSpecifiedToken ||
    getAddress(calculatedToken) !== expectedCalculatedToken ||
    specifiedAmount !== expectedSpecifiedAmount ||
    calculatedAmount < prepared.calculatedAmountThreshold
  ) {
    throw new CliError(
      "simulation_mismatch",
      "Router simulation returned an unexpected or unprotected result",
      {
        expected: {
          specified_token: expectedSpecifiedToken,
          calculated_token: expectedCalculatedToken,
          specified_amount: expectedSpecifiedAmount.toString(),
          calculated_amount_at_least:
            prepared.calculatedAmountThreshold.toString(),
        },
        actual: {
          specified_token: specifiedToken,
          calculated_token: calculatedToken,
          specified_amount: specifiedAmount.toString(),
          calculated_amount: calculatedAmount.toString(),
        },
      },
    );
  }
}

async function readAccountRequirements(
  rpc: ReturnType<typeof createRpcClient>,
  blockNumber: Hex,
  sender: `0x${string}`,
  prepared: ReturnType<typeof prepareSwapFromQuote>,
) {
  const required = prepared.maximumAmountIn ?? prepared.amountIn;
  if (prepared.approval === null) {
    const balance = BigInt(
      await rpc<Hex>("eth_getBalance", [sender, blockNumber]),
    );
    return {
      input_balance: balance.toString(),
      required_input: required.toString(),
      sufficient_balance: balance >= required,
      allowance: null,
      sufficient_allowance: true,
    };
  }

  const [balanceResult, allowanceResult] = await Promise.all([
    rpc<Hex>("eth_call", [
      {
        to: prepared.approval.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [sender],
        }),
      },
      blockNumber,
    ]),
    rpc<Hex>("eth_call", [
      {
        to: prepared.approval.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "allowance",
          args: [sender, prepared.approval.spender],
        }),
      },
      blockNumber,
    ]),
  ]);
  const balance = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: balanceResult,
  });
  const allowance = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data: allowanceResult,
  });

  return {
    input_balance: balance.toString(),
    required_input: required.toString(),
    sufficient_balance: balance >= required,
    allowance: allowance.toString(),
    sufficient_allowance: allowance >= required,
  };
}

function createRpcClient(rpcUrl: string) {
  let id = 0;
  return async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (!response.ok || payload.error !== undefined || payload.result == null) {
      throw new CliError(
        "rpc_error",
        payload.error?.message ?? `${response.status} ${response.statusText}`,
        payload.error,
      );
    }
    return payload.result;
  };
}

function printHelp() {
  console.log(`Prepare and simulate an unsigned Ekubo swap plan.

Usage:
  ekubo-swap prepare \\
    --chain-id 1 \\
    --token-in ETH \\
    --token-out USDC \\
    --type exact-input \\
    --amount 0.1 \\
    --slippage-bps 25 \\
    [--sender 0x...] \\
    [--recipient 0x...] \\
    [--rpc-url https://...]

Use --amount-raw instead of --amount to provide base units. Token symbols must
resolve uniquely through the Ekubo token list; otherwise retry with an address.
The command never signs or submits a transaction.`);
}

main().catch((error: unknown) => {
  const output =
    error instanceof CliError
      ? {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        }
      : {
          error: {
            code: "unexpected_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
  console.error(JSON.stringify(output, null, 2));
  process.exitCode = 1;
});
