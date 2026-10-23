/**
 * Social + economy surface: referral (Invite), Earn Beans (credit), profile and
 * the billing ledger.
 *
 * Rule that shapes this file: on-chain referral actions are signed by the
 * signer, while off-chain writes need a PoPoAuth signature from an EOA. With a
 * ZeroDev session the on-chain side is the smart account and the off-chain side
 * stays the owner EOA (docs/identity-model.md).
 */

import { POPO_ABI } from "../core/abi"
import { PopoError, formatP, parseP, shortAddr, type Address } from "../core/base"
import { authTypedData } from "../core/auth"
import { edge, select } from "../core/backend"
import { encodeCall, type WritePlan } from "../core/tx"
import type { Ctx } from "./chain"

/* ---------------------------------------------------------------- referral */

export async function referralState(ctx: Ctx) {
  const { chain, client, signer } = ctx
  const owner = signer.onchainAddress
  const [parent, pending, total, shares, goldShares, profile] = await Promise.all([
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "referralParentOf",
        args: [owner],
      })
      .catch(() => "0x0000000000000000000000000000000000000000"),
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "referralPendingTotal",
        args: [owner],
      })
      .catch(() => 0n),
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "referralTotalEarnedOf",
        args: [owner],
      })
      .catch(() => 0n),
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "referralSharesBps",
      })
      .catch(() => 0n),
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "goldReferralSharesBps",
      })
      .catch(() => 0n),
    select<Record<string, any>>("affiliate_accounts", {
      address: `eq.${owner.toLowerCase()}`,
      limit: "1",
    }).catch(() => []),
  ])

  return {
    address: owner,
    offchainAddress: signer.offchainAddress,
    boundTo:
      String(parent) === "0x0000000000000000000000000000000000000000" ? null : String(parent),
    pendingP: formatP(BigInt(pending as bigint)),
    earnedP: formatP(BigInt(total as bigint)),
    sharesBps: Number(shares as bigint),
    goldSharesBps: Number(goldShares as bigint),
    code: (profile[0]?.code as string | undefined) ?? null,
    note: "binding must happen before the invitee's first fee-paying trade, otherwise it is locked",
  }
}

export async function bindReferralPlan(ctx: Ctx, referrer: Address): Promise<WritePlan> {
  if (referrer.toLowerCase() === ctx.signer.onchainAddress.toLowerCase()) {
    throw new PopoError("usage", "you cannot bind your own address")
  }
  return {
    action: "referral.bind",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "bindReferral",
        params: [referrer],
        label: `bind referrer ${shortAddr(referrer)}`,
      }),
    ],
    summary: [
      `bind ${shortAddr(referrer)} as your referrer`,
      "this is permanent and must happen before your first trade",
    ],
  }
}

export async function claimReferralPlan(ctx: Ctx): Promise<WritePlan> {
  const state = await referralState(ctx)
  if (parseP(state.pendingP) === 0n) {
    throw new PopoError("unsupported", "nothing to claim yet", {
      hint: "referral rewards accrue from trade fees; check `popo invite show`",
    })
  }
  return {
    action: "referral.claim",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "claimReferral",
        params: [],
        label: `claim ${state.pendingP} $P of referral rewards`,
      }),
    ],
    summary: [`claim ${state.pendingP} $P into the trading vault`],
  }
}

/* ------------------------------------------------------------- earn (beans) */

export async function beansStatus(ctx: Ctx) {
  const address = ctx.signer.offchainAddress
  const timestampMs = Date.now()
  const signature = await ctx.signer.signTypedData(
    authTypedData({ action: "credit-checkin", address, timestampMs, payload: {} }),
    { intent: "beans status" },
  )
  return await edge("credit-checkin", {
    address,
    timestampMs,
    signature,
    action: "status",
  })
}

export async function beansCheckin(ctx: Ctx) {
  const address = ctx.signer.offchainAddress
  const timestampMs = Date.now()
  const signature = await ctx.signer.signTypedData(
    authTypedData({ action: "credit-checkin", address, timestampMs, payload: {} }),
    { intent: "daily check-in" },
  )
  return await edge("credit-checkin", { address, timestampMs, signature })
}

export async function beansTasks() {
  const [config, ledger] = await Promise.all([
    select<Record<string, any>>("credit_config", { limit: "5" }).catch(() => []),
    select<Record<string, any>>("credit_ledger", {
      order: "created_at.desc",
      limit: "10",
      select: "action,delta,balance,created_at,address",
    }).catch(() => []),
  ])
  return { config, recent: ledger }
}

/* ---------------------------------------------------------------- profile */

export async function profileView(ctx: Ctx, who?: string) {
  const address = (who ?? ctx.signer.offchainAddress).toLowerCase()
  const [profile, follow] = await Promise.all([
    select<Record<string, any>>("hatch_user_profiles", {
      address: `eq.${address}`,
      limit: "1",
    }).catch(() => []),
    select<Record<string, any>>("profile_follows", {
      follower: `eq.${ctx.signer.offchainAddress.toLowerCase()}`,
      following: `eq.${address}`,
      limit: "1",
    }).catch(() => []),
  ])
  return {
    address,
    profile: profile[0] ?? null,
    followedByMe: follow.length > 0,
  }
}

/* ---------------------------------------------------------------- billing */

export async function billingHistory(ctx: Ctx, limit = 20) {
  return select<Record<string, any>>("billing_entries", {
    chain_id: `eq.${ctx.chain.chainId}`,
    address: `eq.${ctx.signer.onchainAddress.toLowerCase()}`,
    order: "created_at.desc",
    limit: String(limit),
  }).catch(() => [])
}

export async function dashboardStats(ctx: Ctx) {
  const { chain, client } = ctx
  const [totalTokens, totalMarkets] = await Promise.all([
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "totalPPHatchSwapTokens",
      })
      .catch(() => 0n),
    client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "totalMarket",
      })
      .catch(() => 0n),
  ])
  return {
    chainId: chain.chainId,
    totalTokens: String(totalTokens),
    totalMarkets: String(totalMarkets),
  }
}
