/**
 * PPHatch: bonding-curve tokens, graduation, and the post-graduation AMM
 * (router swaps + concentrated liquidity).
 *
 * Reads are on-chain (source of truth) with the Supabase index used only for
 * text search, creator profiles and trade history — exactly like the web app.
 */

import { parseAbiItem } from "viem"
import { POPO_ABI } from "../core/abi"
import {
  PopoError,
  formatUnits,
  bpsOf,
  formatP,
  parseP,
  shortAddr,
  type Address,
  type Hex,
} from "../core/base"
import { select } from "../core/backend"
import { explorerTx, type ChainConfig } from "../core/chains"
import { getLogsAdaptive } from "../core/rpc"
import { encodeCall, type WritePlan } from "../core/tx"
import type { Ctx } from "./chain"

export const TOKEN_STATUS = ["active", "graduated", "disabled"] as const

export interface TokenView {
  tokenId: string
  name: string
  symbol: string
  uri: string
  creator: Address
  status: string
  complete: boolean
  createdAt: string
  virtualQuoteReserves: string
  realQuoteReserves: string
  graduationThreshold: string
  progressPct: number
  marketCapP: string
  image?: string | null
}

function toTokenView(raw: any): TokenView {
  const threshold: bigint = raw.graduationThreshold ?? 0n
  const realQuote: bigint = raw.realQuoteReserves ?? 0n
  const virtualQuote: bigint = raw.virtualQuoteReserves ?? 0n
  const pct =
    threshold === 0n
      ? 0
      : Number(((realQuote > threshold ? threshold : realQuote) * 10000n) / threshold) / 100
  return {
    tokenId: String(raw.tokenId ?? raw[0]),
    name: String(raw.name ?? ""),
    symbol: String(raw.symbol ?? ""),
    uri: String(raw.uri ?? ""),
    creator: (raw.creator ?? "") as Address,
    status: TOKEN_STATUS[Number(raw.status ?? 0)] ?? "unknown",
    complete: Boolean(raw.complete),
    createdAt: String(raw.createdAt ?? 0),
    virtualQuoteReserves: virtualQuote.toString(),
    realQuoteReserves: realQuote.toString(),
    graduationThreshold: threshold.toString(),
    progressPct: Math.min(100, pct),
    marketCapP: formatP(realQuote, 2),
  }
}

export async function getToken(ctx: Ctx, tokenId: bigint): Promise<TokenView> {
  const raw = await ctx.client
    .readContract({
      address: ctx.chain.contracts.diamond,
      abi: POPO_ABI,
      functionName: "getToken",
      args: [tokenId],
    })
    .catch(() => null)
  if (!raw) {
    throw new PopoError("not_found", `token ${tokenId} not found on ${ctx.chain.label}`, {
      hint: "popo hatch list --json",
    })
  }
  const view = toTokenView(raw)
  const meta = await select<{ image_url: string | null; description: string | null }>(
    "hatch_tokens",
    {
      chain_id: `eq.${ctx.chain.chainId}`,
      token_id: `eq.${view.tokenId}`,
      select: "image_url,description",
      limit: "1",
    },
  ).catch(() => [])
  return { ...view, image: meta[0]?.image_url ?? null }
}

export async function listTokens(
  ctx: Ctx,
  opts: { limit?: number; sort?: string; q?: string; status?: string } = {},
): Promise<TokenView[]> {
  const limit = Math.min(opts.limit ?? 20, 100)
  const rows = await select<{ token_id: number }>("hatch_tokens", {
    chain_id: `eq.${ctx.chain.chainId}`,
    ...(opts.q ? { or: `(name.ilike.*${opts.q}*,symbol.ilike.*${opts.q}*)` } : {}),
    order: opts.sort === "oldest" ? "token_id.asc" : "token_id.desc",
    limit: String(limit),
    select: "token_id",
  })
  const ids = rows.map((r) => BigInt(r.token_id))
  const views = await Promise.all(ids.map((id) => getToken(ctx, id).catch(() => null)))
  const tokens = views.filter((v): v is TokenView => v !== null)
  return opts.status && opts.status !== "all"
    ? tokens.filter((t) => t.status === opts.status)
    : tokens
}

export async function previewBuy(ctx: Ctx, tokenId: bigint, amountP: string) {
  const quote = parseP(amountP)
  const [tokenAmount, platformFee, creatorFee] = (await ctx.client.readContract({
    address: ctx.chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "previewBuy",
    args: [tokenId, quote],
  })) as readonly [bigint, bigint, bigint]
  return {
    side: "buy",
    tokenId: String(tokenId),
    spendP: formatP(quote),
    tokensOut: formatUnits(tokenAmount, 18, 4),
    tokensOutRaw: tokenAmount.toString(),
    platformFeeP: formatP(platformFee, 6),
    creatorFeeP: formatP(creatorFee, 6),
    effectivePriceP: tokenAmount === 0n ? null : (quote * 10n ** 18n) / tokenAmount,
  }
}

export async function previewSell(ctx: Ctx, tokenId: bigint, tokensIn: string) {
  const amount = parseP(tokensIn)
  const [quoteOut, platformFee, creatorFee] = (await ctx.client.readContract({
    address: ctx.chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "previewSell",
    args: [tokenId, amount],
  })) as readonly [bigint, bigint, bigint]
  return {
    side: "sell",
    tokenId: String(tokenId),
    tokensIn: formatUnits(amount, 18, 4),
    receiveP: formatP(quoteOut),
    receiveRaw: quoteOut.toString(),
    platformFeeP: formatP(platformFee, 6),
    creatorFeeP: formatP(creatorFee, 6),
  }
}

export async function buyPlan(
  ctx: Ctx,
  tokenId: bigint,
  amountP: string,
  slippageBps: number,
): Promise<WritePlan> {
  const token = await getToken(ctx, tokenId)
  if (token.status !== "active" || token.complete) {
    throw new PopoError(
      "unsupported",
      `token ${tokenId} is not trading on the curve (status: ${token.status})`,
      { hint: token.complete ? "run `popo amm swap` after migration instead" : undefined },
    )
  }
  const quote = await previewBuy(ctx, tokenId, amountP)
  const minOut = bpsOf(BigInt(quote.tokensOutRaw), 10000 - slippageBps)
  return {
    action: "hatch.buy",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "buy",
        params: [tokenId, parseP(amountP), minOut],
        label: `buy ${token.symbol} with ${quote.spendP} $P`,
      }),
    ],
    summary: [
      `buy ${token.name} (${token.symbol}) #${tokenId}`,
      `spend ${quote.spendP} $P → ~${quote.tokensOut} ${token.symbol}`,
      `fees: platform ${quote.platformFeeP} $P + creator ${quote.creatorFeeP} $P`,
      `slippage guard: min ${formatUnits(minOut, 18, 4)} ${token.symbol} (${slippageBps / 100}%)`,
      `curve progress: ${token.progressPct}% of graduation`,
    ],
    spendP: parseP(amountP),
  }
}

export async function sellPlan(
  ctx: Ctx,
  tokenId: bigint,
  tokensIn: string,
  slippageBps: number,
): Promise<WritePlan> {
  const quote = await previewSell(ctx, tokenId, tokensIn)
  const minOut = bpsOf(BigInt(quote.receiveRaw), 10000 - slippageBps)
  return {
    action: "hatch.sell",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "sell",
        params: [tokenId, parseP(tokensIn), minOut],
        label: `sell ${quote.tokensIn} tokens for $P`,
      }),
    ],
    summary: [
      `sell ${quote.tokensIn} tokens of #${tokenId}`,
      `receive ~${quote.receiveP} $P (min ${formatP(minOut)}, ${slippageBps / 100}% slippage)`,
      `fees: platform ${quote.platformFeeP} $P + creator ${quote.creatorFeeP} $P`,
    ],
  }
}

export async function createTokenPlan(
  ctx: Ctx,
  args: { name: string; symbol: string; uri: string },
): Promise<WritePlan> {
  const { chain, client, signer } = ctx
  const fee = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "getConfig",
  })) as any
  const createFee: bigint = fee?.createTokenFee ?? 0n
  const vault = (await client
    .readContract({
      address: chain.contracts.diamond,
      abi: POPO_ABI,
      functionName: "balanceOf",
      args: [chain.quoteId, signer.onchainAddress],
    })
    .catch(() => 0n)) as bigint
  if (vault < createFee) {
    throw new PopoError("insufficient_balance", "not enough $P in the trading vault", {
      hint: `create fee is ${formatP(createFee)} $P, vault holds ${formatP(vault)} — run \`popo vault deposit ${formatP(createFee)} P\``,
    })
  }
  return {
    action: "hatch.create",
    calls: [
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "createToken",
        params: [args.name, args.symbol, args.uri],
        label: `create ${args.name} (${args.symbol})`,
      }),
    ],
    summary: [
      `create ${args.name} (${args.symbol})`,
      `uri: ${args.uri}`,
      `create fee: ${formatP(createFee)} $P from the vault (vault has ${formatP(vault)})`,
      "the curve starts at 0 — no initial buy is included",
    ],
    spendP: createFee,
  }
}

export async function migratePlan(ctx: Ctx, tokenId: bigint): Promise<WritePlan> {
  const token = await getToken(ctx, tokenId)
  if (!token.complete) {
    throw new PopoError("unsupported", `token ${tokenId} has not reached the graduation threshold`, {
      hint: `progress ${token.progressPct}% — keep buying on the curve`,
    })
  }
  if (token.status === "graduated") {
    throw new PopoError("unsupported", `token ${tokenId} is already graduated`)
  }
  return {
    action: "hatch.migrate",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "migrate",
        params: [tokenId],
        label: `migrate ${token.symbol} to the AMM`,
      }),
    ],
    summary: [
      `permissionless migrate of #${tokenId} (${token.symbol})`,
      "creates the $P/token pool and seeds it from the curve",
      "any wallet can run this once the curve is complete",
    ],
  }
}

export async function holders(ctx: Ctx, tokenId: bigint, limit = 20) {
  return select("hatch_holders", {
    chain_id: `eq.${ctx.chain.chainId}`,
    token_id: `eq.${tokenId.toString()}`,
    order: "balance.desc",
    limit: String(limit),
    select: "holder,balance,updated_at",
  })
}

export async function trades(ctx: Ctx, tokenId: bigint, limit = 20) {
  return select("hatch_trades", {
    chain_id: `eq.${ctx.chain.chainId}`,
    token_id: `eq.${tokenId.toString()}`,
    order: "created_at.desc",
    limit: String(limit),
    select: "tx_hash,trader,side,quote_amount,token_amount,price,created_at,type",
  })
}

/* --------------------------------------------------------------------- AMM */

/**
 * The router quotes by reverting with `RouterFacet_Quote(amountIn, amountOut)`.
 * We decode the two words out of the revert data.
 */
async function quoteOnChain(
  ctx: Ctx,
  tokenId: bigint,
  zeroForOne: boolean,
  amount: bigint,
  exact: "in" | "out",
): Promise<bigint> {
  const data = encodeCall({
    to: ctx.chain.contracts.diamond,
    functionName: exact === "in" ? "quoteSwap" : "quoteSwapExactOutput",
    params: [tokenId, zeroForOne, amount],
    label: "quote",
  }).data as Hex
  try {
    await ctx.client.call({
      to: ctx.chain.contracts.diamond,
      data,
      account: ctx.signer.onchainAddress,
    })
  } catch (error) {
    const raw = extractRevertData(error)
    if (raw && raw.length >= 10 + 128) {
      const first = BigInt(`0x${raw.slice(10, 74)}`)
      const second = BigInt(`0x${raw.slice(74, 138)}`)
      return exact === "in" ? second : first
    }
    throw new PopoError("contract_revert", "AMM quote failed (is the pool initialised?)", {
      details: (error as Error).message.slice(0, 200),
    })
  }
  throw new PopoError("contract_revert", "quoteSwap did not revert as expected", {
    hint: "the router quote helper always reverts with RouterFacet_Quote",
  })
}

function extractRevertData(error: unknown): Hex | null {
  const bag = error as Record<string, any>
  const candidates = [
    bag?.data,
    bag?.cause?.data,
    bag?.cause?.cause?.data,
    bag?.info?.error?.data,
    bag?.details,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]+$/.test(candidate)) {
      return candidate as Hex
    }
    if (candidate && typeof candidate === "object" && typeof candidate.data === "string") {
      return candidate.data as Hex
    }
  }
  return null
}

export async function ammQuote(
  ctx: Ctx,
  tokenId: bigint,
  opts: { side: "buy" | "sell"; amount: string; exact?: "in" | "out" },
) {
  const exact = opts.exact ?? "in"
  const zeroForOne = opts.side === "buy"
  const amount = parseP(opts.amount)
  const out = await quoteOnChain(ctx, tokenId, zeroForOne, amount, exact)
  return {
    side: opts.side,
    exact,
    tokenId: String(tokenId),
    ...(exact === "in"
      ? { amountInP: formatP(amount), amountOut: formatUnits(out, 18, 4) }
      : { amountOutP: formatP(amount), amountIn: formatUnits(out, 18, 4) }),
    raw: out.toString(),
  }
}

const ZERO_SQRT_LIMIT = 0n

export async function ammSwapPlan(
  ctx: Ctx,
  tokenId: bigint,
  opts: { side: "buy" | "sell"; amount: string; exact?: "in" | "out"; slippageBps?: number },
): Promise<WritePlan> {
  const { chain, client } = ctx
  const exact = opts.exact ?? "in"
  const slippage = opts.slippageBps ?? 100
  const zeroForOne = opts.side === "buy"
  const amount = parseP(opts.amount)
  const quoted = await quoteOnChain(ctx, tokenId, zeroForOne, amount, exact)
  const limit = bpsOf(quoted, exact === "in" ? 10000 - slippage : 10000 + slippage)
  const amountSpecified = exact === "in" ? amount : -amount
  const key = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "poolKeyOf",
    args: [tokenId],
  })) as any
  if (!key || (key.sqrtPriceX96 ?? 0) === 0n) {
    // poolKeyOf only returns the key; pool existence is checked separately
  }
  const state = (await client
    .readContract({
      address: chain.contracts.diamond,
      abi: POPO_ABI,
      functionName: "getPoolState",
      args: [key],
    })
    .catch(() => null)) as any
  const price = state?.sqrtPriceX96 ? BigInt(state.sqrtPriceX96) : 0n
  if (price === 0n) {
    throw new PopoError("unsupported", `the AMM pool for #${tokenId} is not initialised`, {
      hint: "the token must graduate and be migrated first (`popo hatch migrate <id>`)",
    })
  }

  const call = encodeCall({
    to: chain.contracts.diamond,
    functionName: "swap",
    params: [
      key,
      {
        zeroForOne,
        amountSpecified,
        sqrtPriceLimitX96: ZERO_SQRT_LIMIT,
        hookData: "0x",
      },
    ],
    label: `swap ${opts.amount} ${opts.side === "buy" ? "$P → token" : "token → $P"}`,
  })
  return {
    action: "amm.swap",
    calls: [call],
    summary: [
      `${exact === "in" ? "exact-in" : "exact-out"} ${opts.side} on the AMM for #${tokenId}`,
      exact === "in"
        ? `in ${formatP(amount)} → ~${formatUnits(quoted, 18, 4)} (${slippage / 100}% guard)`
        : `out ${formatP(amount)} ← ~${formatUnits(quoted, 18, 4)} (${slippage / 100}% guard)`,
      "settles against your trading-vault $P (ERC-6909)",
    ],
    spendP: zeroForOne && exact === "in" ? amount : undefined,
  }
}

const FULL_RANGE: [number, number] = [-887220, 887220]

export function tickForPercent(priceTick: number, pct: number): number {
  // 1 tick ≈ 1.0001 price step; ±pct maps to ±ln(1+pct)/ln(1.0001)
  const factor = Math.log(1 + pct / 100) / Math.log(1.0001)
  return Math.round(priceTick + factor)
}

export async function addLiquidityPlan(
  ctx: Ctx,
  tokenId: bigint,
  opts: { amountP: string; tokens: string; tickLower?: number; tickUpper?: number },
): Promise<WritePlan> {
  const { chain } = ctx
  const [tickLower, tickUpper] =
    opts.tickLower !== undefined && opts.tickUpper !== undefined
      ? [opts.tickLower, opts.tickUpper]
      : FULL_RANGE
  const amount0 = parseP(opts.amountP)
  const amount1 = parseP(opts.tokens)
  return {
    action: "amm.addLiquidity",
    calls: [
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "addLiquidity",
        params: [tokenId, tickLower, tickUpper, amount0, amount1],
        label: `add liquidity ${formatP(amount0)} $P + ${formatUnits(amount1, 18, 2)} tokens`,
      }),
    ],
    summary: [
      `add liquidity to #${tokenId}`,
      `ticks ${tickLower} … ${tickUpper}${tickLower === FULL_RANGE[0] ? " (full range)" : ""}`,
      `deposit up to ${formatP(amount0)} $P + ${formatUnits(amount1, 18, 2)} tokens`,
      "the contract mints against the smaller of the two sides",
    ],
    spendP: amount0,
  }
}

export async function removeLiquidityPlan(
  ctx: Ctx,
  tokenId: bigint,
  opts: { tickLower: number; tickUpper: number; liquidity: string; slippageBps?: number },
): Promise<WritePlan> {
  const { chain, client } = ctx
  const salt = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "positionSalt",
    args: [ctx.signer.onchainAddress, opts.tickLower, opts.tickUpper],
  })) as Hex
  const key = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "poolKeyOf",
    args: [tokenId],
  })) as any
  const [, amount0, amount1] = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "getPosition",
    args: [key, ctx.signer.onchainAddress, opts.tickLower, opts.tickUpper, salt],
  })) as readonly [bigint, bigint, bigint]
  const liquidity = BigInt(opts.liquidity)
  const slippage = opts.slippageBps ?? 100
  return {
    action: "amm.removeLiquidity",
    calls: [
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "removeLiquidity",
        params: [
          tokenId,
          opts.tickLower,
          opts.tickUpper,
          liquidity,
          bpsOf(amount0, 10000 - slippage),
          bpsOf(amount1, 10000 - slippage),
        ],
        label: `remove ${liquidity} liquidity (ticks ${opts.tickLower}…${opts.tickUpper})`,
      }),
    ],
    summary: [
      `remove liquidity from #${tokenId} ticks ${opts.tickLower}…${opts.tickUpper}`,
      `liquidity L=${liquidity.toString()}`,
      `expected out ≤ ${formatP(amount0)} $P + ${formatUnits(amount1, 18, 4)} tokens (fees are also settled)`,
      `min out after ${slippage / 100}% guard`,
    ],
  }
}

export async function lpPositions(ctx: Ctx) {
  const [indexed, onchain] = await Promise.all([
    select<Record<string, unknown>>("hatch_amm_user_positions", {
      chain_id: `eq.${ctx.chain.chainId}`,
      owner: `eq.${ctx.signer.onchainAddress.toLowerCase()}`,
      order: "updated_at.desc",
      limit: "50",
    }).catch(() => []),
    readPositionLogs(ctx).catch(() => []),
  ])
  return { indexed, rangesFromLogs: onchain }
}

/** Fallback discovery: positions are isolated by salt = keccak(user, lower, upper). */
async function readPositionLogs(ctx: Ctx) {
  const logs = await getLogsAdaptive(ctx.client, {
    address: ctx.chain.contracts.diamond,
    event: parseAbiItem(
      "event LiquidityModified(bytes32 indexed poolId, address indexed owner, int24 tickLower, int24 tickUpper, int128 liquidityDelta, uint256 amount0, uint256 amount1)",
    ),
    fromBlock: ctx.chain.startBlock,
  })
  const ranges = new Set<string>()
  for (const log of logs) {
    const args = (log as unknown as { args?: Record<string, unknown> }).args ?? {}
    const owner = args.owner
    if (!owner) continue
    if (String(owner).toLowerCase() !== ctx.signer.onchainAddress.toLowerCase()) continue
    ranges.add(`${String(args.tickLower)}:${String(args.tickUpper)}`)
  }
  return [...ranges]
}

export function tokensExplorer(chain: ChainConfig, tokenId: bigint): string {
  return `${chain.explorerUrl}/token/${chain.contracts.diamond}?a=${tokenId}`
}

export function tradeExplorer(chain: ChainConfig, hash: string): string {
  return explorerTx(chain, hash)
}

export { shortAddr }
