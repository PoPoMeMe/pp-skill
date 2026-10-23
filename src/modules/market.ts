/**
 * Market-side surface: paid episodes (series) and prediction markets.
 *
 * Episodes: metadata lives in Supabase, access is on-chain (`purchaseEpisode`),
 * and the private video URL is only handed out by the `hatch-episode-watch`
 * Edge Function after it re-checks the on-chain entitlement.
 *
 * Prediction: markets are keyed by a `digest` (sha256 of the canonical
 * metadata). v0.1 ships full reads + exact quotes; order submission goes
 * through the `popo call` escape hatch because PoPo's prediction entrypoint
 * takes an NFT id rather than an amount (see docs/scope.md).
 */


import { POPO_ABI } from "../core/abi"
import { PopoError, formatP, formatUnits, parseP, type Address } from "../core/base"
import { authTypedData } from "../core/auth"
import { edge, select } from "../core/backend"
import { encodeCall, type WritePlan } from "../core/tx"
import type { Ctx } from "./chain"

/* ---------------------------------------------------------------- episodes */

export interface EpisodeView {
  tokenId: string
  /** 0 = trailer, 1..n = episodes (on-chain index = no - 1). */
  no: number
  title: string | null
  description: string | null
  priceP: string
  free: boolean
  hasVideo: boolean
  thumbnail: string | null
  createdAt: string | null
}

export async function listEpisodes(ctx: Ctx, tokenId: bigint): Promise<EpisodeView[]> {
  const [count, rows] = await Promise.all([
    ctx.client
      .readContract({
        address: ctx.chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "episodeCount",
        args: [tokenId],
      })
      .catch(() => 0n) as Promise<bigint>,
    select<Record<string, any>>("hatch_episodes", {
      chain_id: `eq.${ctx.chain.chainId}`,
      token_id: `eq.${tokenId.toString()}`,
      order: "episode_no.asc",
      limit: "200",
    }).catch(() => []),
  ])

  const meta = new Map<number, Record<string, any>>()
  for (const row of rows) meta.set(Number(row.episode_no), row)

  const episodes: EpisodeView[] = []
  // trailer (no = 0) is implicit and always free
  const trailer = meta.get(0)
  episodes.push({
    tokenId: String(tokenId),
    no: 0,
    title: trailer?.title ?? "Trailer",
    description: trailer?.description ?? null,
    priceP: "0",
    free: true,
    hasVideo: Boolean(trailer?.video_path ?? trailer?.video_url),
    thumbnail: trailer?.thumbnail_url ?? null,
    createdAt: trailer?.created_at ?? null,
  })

  for (let index = 0; index < Number(count); index++) {
    const [price] = (await ctx.client.readContract({
      address: ctx.chain.contracts.diamond,
      abi: POPO_ABI,
      functionName: "getEpisode",
      args: [tokenId, BigInt(index)],
    })) as readonly [{ price: bigint; createdAt: bigint; exists: boolean }]
    const row = meta.get(index + 1)
    episodes.push({
      tokenId: String(tokenId),
      no: index + 1,
      title: row?.title ?? null,
      description: row?.description ?? null,
      priceP: formatP(price.price),
      free: price.price === 0n,
      hasVideo: Boolean(row?.video_path ?? row?.video_url),
      thumbnail: row?.thumbnail_url ?? null,
      createdAt: price.createdAt ? price.createdAt.toString() : null,
    })
  }
  return episodes
}

/** Signed entitlement check → capability URL for the actual video. */
export async function watchEpisode(ctx: Ctx, tokenId: bigint, no: number) {
  const { chain, signer } = ctx
  if (no < 1) {
    const rows = await select<Record<string, any>>("hatch_episodes", {
      chain_id: `eq.${chain.chainId}`,
      token_id: `eq.${tokenId.toString()}`,
      episode_no: "eq.0",
      limit: "1",
    })
    return { trailer: true, url: rows[0]?.video_url ?? null }
  }
  const address = signer.offchainAddress
  const timestampMs = Date.now()
  const signature = await signer.signTypedData(
    authTypedData({
      action: "hatch-episode-watch",
      address,
      timestampMs,
      payload: { chainId: chain.chainId, tokenId: Number(tokenId), episodeNo: no },
    }),
    { intent: `watch ${tokenId} episode ${no}` },
  )
  const result = await edge<{ url?: string; error?: string; expiresAt?: string }>(
    "hatch-episode-watch",
    {
      chainId: chain.chainId,
      tokenId: Number(tokenId),
      episodeNo: no,
      address,
      timestampMs,
      signature,
    },
  )
  if (!result?.url) {
    throw new PopoError("backend_error", result?.error ?? "no video url returned", {
      hint: "the wallet may not own this episode yet — run `popo episode unlock <id> <no>`",
    })
  }
  return { trailer: false, url: result.url, expiresAt: result.expiresAt ?? null }
}

export async function unlockEpisodePlan(
  ctx: Ctx,
  tokenId: bigint,
  no: number,
): Promise<WritePlan> {
  const { chain, client, signer } = ctx
  if (no < 1) throw new PopoError("usage", "the trailer is free — nothing to unlock")
  const [episode] = (await client.readContract({
    address: chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "getEpisode",
    args: [tokenId, BigInt(no - 1)],
  })) as readonly [{ price: bigint; createdAt: bigint; exists: boolean }]
  if (!episode.exists) {
    throw new PopoError("not_found", `episode ${no} does not exist for token ${tokenId}`)
  }
  const vault = (await client
    .readContract({
      address: chain.contracts.diamond,
      abi: POPO_ABI,
      functionName: "balanceOf",
      args: [chain.quoteId, signer.onchainAddress],
    })
    .catch(() => 0n)) as bigint
  if (vault < episode.price) {
    throw new PopoError("insufficient_balance", "not enough $P in the trading vault", {
      hint: `price ${formatP(episode.price)} $P, vault ${formatP(vault)} — run \`popo vault deposit\``,
    })
  }
  return {
    action: "episode.unlock",
    calls: [
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "purchaseEpisode",
        params: [tokenId, BigInt(no - 1)],
        label: `unlock episode ${no}`,
      }),
    ],
    summary: [
      `unlock episode ${no} of token #${tokenId}`,
      `price: ${formatP(episode.price)} $P from the trading vault`,
      "access is recorded on-chain for this wallet (re-watchable forever)",
    ],
    spendP: episode.price,
  }
}

/* -------------------------------------------------------------- prediction */

export interface MarketView {
  digest: string
  index: number
  title: string | null
  category: string | null
  status: "unknown" | "pending" | "enabled" | "ended" | "finalized"
  yesSupply: string | null
  noSupply: string | null
  potP: string | null
  yesPct: number | null
  yesNftId: string | null
  noNftId: string | null
  meta: Record<string, unknown> | null
}

export async function listMarkets(
  ctx: Ctx,
  opts: { limit?: number; start?: number } = {},
): Promise<MarketView[]> {
  const start = BigInt(opts.start ?? 0)
  const limit = BigInt(Math.min(opts.limit ?? 20, 100))
  const digests = (await ctx.client.readContract({
    address: ctx.chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: "getMarketList",
    args: [start, limit],
  })) as readonly `0x${string}`[]

  const byDigest = await marketMetadata(ctx.chain.chainId)

  const out: MarketView[] = []
  for (let i = 0; i < digests.length; i++) {
    const digest = digests[i]!
    const meta = byDigest.get(digest.toLowerCase()) ?? null
    // The web app prices markets with targetSupply = 0 (see use-prediction.ts).
    const state = await ctx.client
      .readContract({
        address: ctx.chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "getMarket",
        args: [digest, 0n],
      })
      .catch(() => null)
    out.push(toMarketView(digest, Number(start) + i, meta, state))
  }
  return out
}

/** Applicant metadata is stored as a JSON column (`meta`) keyed by digest. */
async function marketMetadata(chainId: number) {
  const rows = await select<Record<string, any>>("prediction_market_applications", {
    chain_id: `eq.${chainId}`,
    select: "digest,meta,status,reward_total_amount,applicant,created_at",
    limit: "500",
  }).catch(() => [])
  const map = new Map<string, Record<string, any>>()
  for (const row of rows) {
    const digest = String(row.digest ?? "").toLowerCase()
    if (!digest) continue
    map.set(digest, { ...(row.meta ?? {}), ...row, metaParsed: row.meta ?? {} })
  }
  return map
}

function toMarketView(
  digest: string,
  index: number,
  meta: Record<string, any> | null,
  state: any,
): MarketView {
  const market = state?.[0] ?? state ?? null
  const yes = market?.yesSupply ? BigInt(market.yesSupply) : null
  const no = market?.noSupply ? BigInt(market.noSupply) : null
  const total = yes !== null && no !== null ? yes + no : null
  const status: MarketView["status"] = !market
    ? meta
      ? "pending"
      : "unknown"
    : market.isFinalized
      ? "finalized"
      : market.isEnded
        ? "ended"
        : market.isEnabled
          ? "enabled"
          : "pending"
  const title = (meta?.title as string | undefined) ?? (meta?.metaParsed?.title as string | undefined) ?? null
  const category =
    (meta?.category as string | undefined) ?? (meta?.metaParsed?.category as string | undefined) ?? null
  return {
    digest,
    index,
    title,
    category,
    status,
    yesSupply: yes?.toString() ?? null,
    noSupply: no?.toString() ?? null,
    potP: market?.poolTotalAmount ? formatP(BigInt(market.poolTotalAmount)) : null,
    yesPct:
      total && total > 0n ? Number(((yes ?? 0n) * 10000n) / total) / 100 : null,
    yesNftId: market?.yesNftId !== undefined ? String(market.yesNftId) : null,
    noNftId: market?.noNftId !== undefined ? String(market.noNftId) : null,
    meta: meta
      ? {
          title,
          category,
          status: meta.status ?? null,
          rewardP: meta.reward_total_amount
            ? formatP(BigInt(meta.reward_total_amount))
            : null,
          applicant: meta.applicant ?? null,
        }
      : null,
  }
}

export async function getMarket(ctx: Ctx, digest: `0x${string}`) {
  const byDigest = await marketMetadata(ctx.chain.chainId)
  const meta = byDigest.get(digest.toLowerCase()) ?? null
  const state = ctx.signer
    ? await ctx.client
        .readContract({
          address: ctx.chain.contracts.diamond,
          abi: POPO_ABI,
          functionName: "getMarket",
          args: [digest, 0n],
        })
        .catch(() => null)
    : null
  if (!meta && !state) {
    throw new PopoError("not_found", `market ${digest} not found on ${ctx.chain.label}`, {
      hint: "popo predict list --json",
    })
  }
  return toMarketView(digest, -1, meta, state)
}

export async function quoteShares(
  ctx: Ctx,
  digest: `0x${string}`,
  opts: { outcome: "yes" | "no"; amount: string; side?: "buy" | "sell" },
) {
  const market = await getMarket(ctx, digest)
  const nftId = opts.outcome === "yes" ? market.yesNftId : market.noNftId
  if (!nftId) {
    throw new PopoError("unsupported", "this market has no share NFT yet (not enabled)")
  }
  const amount = parseP(opts.amount)
  const side = opts.side ?? "buy"
  const result = (await ctx.client.readContract({
    address: ctx.chain.contracts.diamond,
    abi: POPO_ABI,
    functionName: side === "buy" ? "quoteBuy" : "quoteSell",
    args: [
      digest,
      BigInt(nftId),
      amount,
      side === "buy" ? ctx.signer.onchainAddress : (ctx.signer.onchainAddress as Address),
    ],
  })) as readonly [bigint, bigint, bigint]
  return {
    market: market.title ?? digest,
    outcome: opts.outcome,
    side,
    shares: formatUnits(amount, 18, 4),
    ...(side === "buy"
      ? { totalCostP: formatP(result[0]), feeP: formatP(result[1]) }
      : { totalOutP: formatP(result[0]), feeP: formatP(result[1]) }),
    newSupply: formatUnits(result[2], 18, 4),
    note:
      "v0.1 is read + quote only for prediction orders; submit with `popo call --fn buy --args '[<digest>,<nftId>]'` once the amount semantics are confirmed",
  }
}
