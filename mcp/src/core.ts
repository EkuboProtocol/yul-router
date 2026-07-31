import {
  buildQuoterQuoteUrl,
  type EvmQuoterQuote,
  type EvmQuoterQuoteType,
  prepareSwapFromQuote,
  type PreparedSwap,
  YUL_ROUTER_ABI,
} from "@ekubo/yul-router-sdk";
import {
  type Address,
  decodeAbiParameters,
  decodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  stringToHex,
} from "viem";

export interface Env {
  EKUBO_API_URL: string;
  EKUBO_QUOTER_URL: string;
  ALLOWED_HOSTNAMES?: string;
  ALLOWED_ORIGINS?: string;
  RPC_URLS_JSON?: string;
  RATE_LIMITER?: RateLimit;
}

export interface QuoteIntent {
  chainId: string;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string;
}

export interface PrepareSwapIntent extends QuoteIntent {
  slippageBps: number;
  recipient?: Address;
  sender?: Address;
  simulate: boolean;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Fetcher = typeof fetch;

export async function searchTokens(
  env: Env,
  input: { chainId: string; query: string; pageSize: number },
  fetcher: Fetcher = fetch,
) {
  const url = new URL("/tokens", normalizedBase(env.EKUBO_API_URL));
  url.searchParams.set("chainId", input.chainId);
  url.searchParams.set("search", input.query);
  url.searchParams.set("pageSize", input.pageSize.toString());
  return fetchJson<unknown[]>(url.toString(), fetcher);
}

export async function getToken(
  env: Env,
  input: { chainId: string; address: string },
  fetcher: Fetcher = fetch,
) {
  const url = new URL(
    `/tokens/${encodeURIComponent(input.chainId)}/${encodeURIComponent(input.address)}`,
    normalizedBase(env.EKUBO_API_URL),
  );
  return fetchJson<Record<string, unknown>>(url.toString(), fetcher);
}

export async function getQuote(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher = fetch,
) {
  const url = buildQuoterQuoteUrl({
    quoterUrl: env.EKUBO_QUOTER_URL,
    chainId: intent.chainId,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    quoteType: intent.quoteType,
    amount: intent.amount,
  });
  const quote = await fetchJson<EvmQuoterQuote>(url, fetcher);
  return {
    request: {
      chain_id: intent.chainId,
      token_in: getAddress(intent.tokenIn),
      token_out: getAddress(intent.tokenOut),
      quote_type: intent.quoteType,
      amount: intent.amount,
    },
    source_url: url,
    quote,
  };
}

export async function prepareSwap(
  env: Env,
  intent: PrepareSwapIntent,
  fetcher: Fetcher = fetch,
) {
  const quoted = await getQuote(env, intent, fetcher);
  const prepared = prepareSwapFromQuote({
    quote: quoted.quote,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    quoteType: intent.quoteType,
    amount: intent.amount,
    slippageBps: intent.slippageBps,
    recipient: intent.recipient,
  });
  const simulation = intent.simulate
    ? await simulatePreparedSwap(env, intent.chainId, prepared, intent.sender, fetcher)
    : {
        status: "not_requested" as const,
        message: "Simulation was explicitly disabled by the caller",
      };
  const confirmationReady = simulation.status === "success";
  const identity = {
    chain_id: intent.chainId,
    block_number: prepared.block.number.toString(),
    block_hash: prepared.block.hash,
    sender: intent.sender ?? null,
    recipient: prepared.recipient,
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: prepared.transaction.value.toString(),
  };

  return {
    schema_version: "1",
    action: "ekubo_swap",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    requires_user_confirmation: true,
    confirmation_ready: confirmationReady,
    request: quoted.request,
    quote_source_url: quoted.source_url,
    quote: {
      amount_in: prepared.amountIn.toString(),
      amount_out: prepared.amountOut.toString(),
      minimum_amount_out: prepared.minimumAmountOut?.toString() ?? null,
      maximum_amount_in: prepared.maximumAmountIn?.toString() ?? null,
      slippage_bps: prepared.slippageBps.toString(),
      price_impact: prepared.priceImpact,
      estimated_route_gas: prepared.estimatedRouteGas,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
      raw: quoted.quote,
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
      instruction: confirmationReady
        ? "Ask the user to confirm this exact plan_id and slippage tolerance before submitting. Re-prepare after any change."
        : "Do not ask the user to submit this plan until it has been simulated successfully.",
      recipient: prepared.recipient ?? intent.sender ?? "transaction_sender",
      sender: intent.sender ?? null,
    },
  };
}

async function simulatePreparedSwap(
  env: Env,
  chainId: string,
  prepared: PreparedSwap,
  sender: Address | undefined,
  fetcher: Fetcher,
) {
  const rpcUrl = rpcUrlForChain(env, chainId);
  if (rpcUrl === undefined) {
    return {
      status: "not_configured" as const,
      message: `No allowlisted RPC is configured for chain ${chainId}`,
    };
  }

  try {
    const blockNumber = numberToHex(prepared.block.number);
    const block = await rpc<{ hash?: Hex | null }>(
      rpcUrl,
      "eth_getBlockByNumber",
      [blockNumber, false],
      fetcher,
    );
    if (block.hash == null || BigInt(block.hash) !== BigInt(prepared.block.hash)) {
      throw new ServiceError(
        "quote_block_mismatch",
        "The configured RPC returned a different hash for the quote block",
        { expected: prepared.block.hash, actual: block.hash ?? null },
      );
    }

    const routeCall = await rpc<Hex>(
      rpcUrl,
      "eth_call",
      [
        {
          to: prepared.transaction.to,
          data: prepared.quoteCalldata,
        },
        blockNumber,
      ],
      fetcher,
    );
    const [specifiedToken, calculatedToken, specifiedAmount, calculatedAmount] =
      decodeFunctionResult({
        abi: YUL_ROUTER_ABI,
        functionName: "quote",
        data: routeCall,
      });
    validateSimulation(
      prepared,
      specifiedToken,
      calculatedToken,
      specifiedAmount,
      calculatedAmount,
    );

    const routeResult = {
      specified_token: specifiedToken,
      calculated_token: calculatedToken,
      specified_amount: specifiedAmount.toString(),
      calculated_amount: calculatedAmount.toString(),
    };
    if (sender === undefined) {
      return {
        status: "success" as const,
        mode: "route_only" as const,
        block_number: prepared.block.number.toString(),
        block_hash: prepared.block.hash,
        result: routeResult,
        warning:
          "Route simulation does not prove that a particular sender has sufficient balance or allowance",
      };
    }

    const exactCall = await rpc<Hex>(
      rpcUrl,
      "eth_call",
      [
        {
          from: getAddress(sender),
          to: prepared.transaction.to,
          data: prepared.transaction.data,
          value: numberToHex(prepared.transaction.value),
        },
        blockNumber,
      ],
      fetcher,
    );
    const [actualSpecifiedToken, actualCalculatedToken, actualSpecifiedAmount, actualCalculatedAmount] =
      decodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "int256" },
          { type: "int256" },
        ],
        exactCall,
      );
    validateSimulation(
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
        ...routeResult,
        actual_specified_token: actualSpecifiedToken,
        actual_calculated_token: actualCalculatedToken,
        actual_specified_amount: actualSpecifiedAmount.toString(),
        actual_calculated_amount: actualCalculatedAmount.toString(),
      },
    };
  } catch (error) {
    const details = error instanceof ServiceError ? error.details : undefined;
    return {
      status: "failed" as const,
      code: error instanceof ServiceError ? error.code : "simulation_failed",
      message: error instanceof Error ? error.message : String(error),
      ...(details === undefined ? {} : { details }),
    };
  }
}

function validateSimulation(
  prepared: PreparedSwap,
  specifiedToken: Address,
  calculatedToken: Address,
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
    throw new ServiceError(
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

function rpcUrlForChain(env: Env, chainId: string): string | undefined {
  if (env.RPC_URLS_JSON === undefined || env.RPC_URLS_JSON.length === 0) {
    return undefined;
  }
  let urls: unknown;
  try {
    urls = JSON.parse(env.RPC_URLS_JSON);
  } catch {
    throw new ServiceError(
      "invalid_server_configuration",
      "RPC_URLS_JSON is not valid JSON",
    );
  }
  if (urls === null || typeof urls !== "object" || Array.isArray(urls)) {
    throw new ServiceError(
      "invalid_server_configuration",
      "RPC_URLS_JSON must be an object keyed by decimal chain ID",
    );
  }
  const candidate = (urls as Record<string, unknown>)[chainId];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate.startsWith("https://")) {
    throw new ServiceError(
      "invalid_server_configuration",
      `The RPC URL configured for chain ${chainId} must use HTTPS`,
    );
  }
  return candidate;
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string; data?: unknown };
  };
  if (!response.ok || body.error !== undefined || body.result == null) {
    throw new ServiceError(
      "rpc_error",
      body.error?.message ?? `${response.status} ${response.statusText}`,
      body.error,
    );
  }
  return body.result;
}

async function fetchJson<T>(url: string, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ServiceError(
      "invalid_upstream_response",
      `Upstream returned non-JSON content from ${url}`,
    );
  }
  if (!response.ok) {
    const upstream = body as { code?: unknown; error?: unknown };
    throw new ServiceError(
      typeof upstream.code === "string" ? upstream.code : "upstream_error",
      typeof upstream.error === "string"
        ? upstream.error
        : `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  return body as T;
}

function normalizedBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}
