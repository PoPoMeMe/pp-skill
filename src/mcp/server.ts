#!/usr/bin/env node
/**
 * popo-mcp — the same capability surface as the CLI, exposed over MCP (stdio).
 *
 * Any MCP-capable harness (Cindy/Pi, Claude Code, Codex, Cursor, …) gets PoPo
 * as tools. Reads are annotated `readOnlyHint` so hosts may auto-approve them;
 * every write requires `confirm: true` and is simulated first, so a model can
 * never send a transaction by accident.
 *
 *   { "mcpServers": { "popo": { "command": "npx", "args": ["-y", "github:PoPoMeMe/pp-skill", "serve-mcp"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { PopoError, formatP } from "./../core/base"
import type { Address } from "./../core/base"
import { getChain, listChains } from "../core/chains"
import { readConfig } from "../core/config"
import { VERSION } from "../core/version"
import { resolveSigner } from "../core/signer"
import { probeZeroDev, sessionStatus } from "../core/signer/zerodev"
import { chainHealth } from "../core/rpc"
import { executePlan, type WritePlan } from "../core/tx"
import { jsonStringify } from "../cli/render"
import {
  makeCtx,
  faucetClaim,
  hasAnyRole,
  readBalances,
  listFunctions,
  rawCall,
  status,
  vaultDepositPlan,
  vaultWithdrawPlan,
  type Ctx,
} from "../modules/chain"
import {
  addLiquidityPlan,
  ammQuote,
  ammSwapPlan,
  buyPlan,
  createTokenPlan,
  getToken,
  holders,
  listTokens,
  migratePlan,
  previewBuy,
  previewSell,
  removeLiquidityPlan,
  sellPlan,
  trades,
} from "../modules/hatch"
import {
  getMarket,
  listEpisodes,
  listMarkets,
  quoteShares,
  unlockEpisodePlan,
  watchEpisode,
} from "../modules/market"
import {
  beansCheckin,
  beansStatus,
  billingHistory,
  claimReferralPlan,
  dashboardStats,
  profileView,
  referralState,
} from "../modules/social"

const chainArg = z
  .string()
  .optional()
  .describe("chain id or key: 421614 (Arbitrum Sepolia, default) or 46630 (Robinhood)")
const signerArg = z
  .enum(["auto", "mm", "zerodev", "local", "readonly"])
  .optional()
  .describe("signer backend; default 'auto' (ZeroDev session → mm → readonly)")
const confirmArg = z
  .boolean()
  .optional()
  .describe("false/omitted = simulate only and return the plan; true = actually send")

async function ctxFor(opts: { chain?: string; signer?: string }): Promise<Ctx> {
  const cfg = readConfig()
  const chain = getChain(opts.chain ?? cfg.chainId)
  const signer = await resolveSigner(chain, { kind: (opts.signer as never) ?? cfg.signer })
  return makeCtx(chain, signer)
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: jsonStringify(payload) }] }
}

function err(error: unknown) {
  const e = error instanceof PopoError ? error : new PopoError("internal", String(error))
  return {
    isError: true,
    content: [{ type: "text" as const, text: jsonStringify(e.toJSON()) }],
  }
}

/** Shared write path: simulate first, send only with confirm === true. */
async function runWrite(ctx: Ctx, build: () => Promise<WritePlan>, confirm?: boolean) {
  const plan = await build()
  const { simulated, results } = await executePlan(ctx.chain, ctx.signer, plan, {
    yes: confirm === true,
  })
  return {
    action: plan.action,
    chainId: ctx.chain.chainId,
    signer: ctx.signer.kind,
    summary: plan.summary,
    sent: confirm === true,
    gas: simulated.map((s) => s.gas?.toString() ?? null),
    results: results.map((r) => ({
      label: r.label,
      hash: r.hash,
      explorer: r.explorerUrl,
      status: r.status ?? null,
    })),
  }
}

/** Wrap a write so `confirm:false` returns the plan instead of throwing. */
async function writeTool(ctx: Ctx, build: () => Promise<WritePlan>, confirm?: boolean) {
  try {
    return ok(await runWrite(ctx, build, confirm))
  } catch (error) {
    if (error instanceof PopoError && error.code === "confirmation_required") {
      return ok({
        ok: true,
        simulated: true,
        sent: false,
        ...(error.details as Record<string, unknown>),
        next: "ask the user to confirm, then call again with confirm:true",
      })
    }
    return err(error)
  }
}

const server = new McpServer({
  name: "popo",
  version: VERSION,
})

const READ = { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

server.registerTool(
  "popo_status",
  {
    title: "PoPo status",
    description:
      "One call to orient: chain, signer, on-chain vs off-chain identity, gas, wallet $P, vault $P, created tokens and suggested next steps.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      return ok(await status(await ctxFor(args)))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_doctor",
  {
    title: "PoPo environment check",
    description:
      "Diagnose the local setup: RPC health per chain, ZeroDev EntryPoint/bundler availability, mm signer and session state. Safe to paste anywhere.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const chains = listChains()
      const health = await Promise.all(chains.map((c) => chainHealth(c)))
      const probes = await Promise.all(chains.map((c) => probeZeroDev(c).catch(() => null)))
      return ok({
        config: readConfig(),
        chains: chains.map((c, i) => ({ chainId: c.chainId, ...health[i], zeroDev: probes[i] })),
        session: sessionStatus(),
      })
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_balance",
  {
    title: "Balances",
    description: "Native gas, wallet $P and trading-vault $P for the active signer.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      return ok(await readBalances(await ctxFor(args)))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_list",
  {
    title: "List hatch tokens",
    description: "Bonding-curve tokens on the selected chain, newest first.",
    inputSchema: {
      chain: chainArg,
      limit: z.number().int().min(1).max(100).optional(),
      q: z.string().optional().describe("search name/symbol"),
      status: z.enum(["all", "active", "graduated"]).optional(),
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(
        await listTokens(ctx, { limit: args.limit ?? 20, q: args.q, status: args.status }),
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_get",
  {
    title: "Token detail",
    description: "On-chain state of one hatch token: reserves, curve progress, status, creator.",
    inputSchema: { tokenId: z.string(), chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await getToken(ctx, BigInt(args.tokenId)))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_quote",
  {
    title: "Quote a curve trade",
    description:
      "Exact bonding-curve quote via previewBuy/previewSell (tokens out or $P out plus fees).",
    inputSchema: {
      tokenId: z.string(),
      side: z.enum(["buy", "sell"]),
      amount: z.string().describe("$P amount when buying, token amount when selling"),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(
        args.side === "buy"
          ? await previewBuy(ctx, BigInt(args.tokenId), args.amount)
          : await previewSell(ctx, BigInt(args.tokenId), args.amount),
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_create",
  {
    title: "Create a hatch token",
    description:
      "Create a bonding-curve token (charges the on-chain create fee in $P from the vault). Simulated unless confirm:true.",
    inputSchema: {
      name: z.string(),
      symbol: z.string(),
      uri: z.string().optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () =>
          createTokenPlan(ctx, {
            name: args.name,
            symbol: args.symbol,
            uri: args.uri ?? "ipfs://",
          }),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_buy",
  {
    title: "Buy on the curve",
    description: "Buy a hatch token with $P from the trading vault, with a slippage guard.",
    inputSchema: {
      tokenId: z.string(),
      amountP: z.string(),
      slippageBps: z.number().int().min(0).max(5000).optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () => buyPlan(ctx, BigInt(args.tokenId), args.amountP, args.slippageBps ?? 100),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_sell",
  {
    title: "Sell on the curve",
    description: "Sell tokens back into the curve for $P, with a slippage guard.",
    inputSchema: {
      tokenId: z.string(),
      tokens: z.string(),
      slippageBps: z.number().int().min(0).max(5000).optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () => sellPlan(ctx, BigInt(args.tokenId), args.tokens, args.slippageBps ?? 100),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_migrate",
  {
    title: "Graduate a token",
    description:
      "Permissionless migrate: seeds the AMM pool once the curve is complete. Anyone can call it.",
    inputSchema: { tokenId: z.string(), chain: chainArg, signer: signerArg, confirm: confirmArg },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(ctx, () => migratePlan(ctx, BigInt(args.tokenId)), args.confirm)
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_hatch_market",
  {
    title: "Holders and trades",
    description: "Top holders and the most recent trades for a token (Supabase index).",
    inputSchema: {
      tokenId: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      const tokenId = BigInt(args.tokenId)
      const limit = args.limit ?? 20
      return ok({
        holders: await holders(ctx, tokenId, limit),
        trades: await trades(ctx, tokenId, limit),
      })
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_amm_quote",
  {
    title: "Quote an AMM swap",
    description:
      "Post-graduation swap quote. The router answers by reverting with RouterFacet_Quote; both numbers are decoded.",
    inputSchema: {
      tokenId: z.string(),
      side: z.enum(["buy", "sell"]),
      amount: z.string(),
      exact: z.enum(["in", "out"]).optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(
        await ammQuote(ctx, BigInt(args.tokenId), {
          side: args.side,
          amount: args.amount,
          exact: args.exact ?? "in",
        }),
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_amm_swap",
  {
    title: "Swap on the AMM",
    description: "Exact-in or exact-out swap on the graduated pool, settled in vault $P.",
    inputSchema: {
      tokenId: z.string(),
      side: z.enum(["buy", "sell"]),
      amount: z.string(),
      exact: z.enum(["in", "out"]).optional(),
      slippageBps: z.number().int().min(0).max(5000).optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () =>
          ammSwapPlan(ctx, BigInt(args.tokenId), {
            side: args.side,
            amount: args.amount,
            exact: args.exact ?? "in",
            slippageBps: args.slippageBps ?? 100,
          }),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_lp_add",
  {
    title: "Add liquidity",
    description: "Add concentrated liquidity to a graduated pool (ticks or full range).",
    inputSchema: {
      tokenId: z.string(),
      amountP: z.string(),
      tokens: z.string(),
      tickLower: z.number().int().optional(),
      tickUpper: z.number().int().optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () =>
          addLiquidityPlan(ctx, BigInt(args.tokenId), {
            amountP: args.amountP,
            tokens: args.tokens,
            ...(args.tickLower !== undefined ? { tickLower: args.tickLower } : {}),
            ...(args.tickUpper !== undefined ? { tickUpper: args.tickUpper } : {}),
          }),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_lp_remove",
  {
    title: "Remove liquidity",
    description: "Remove liquidity from a tick range; fees are settled in the same transaction.",
    inputSchema: {
      tokenId: z.string(),
      tickLower: z.number().int(),
      tickUpper: z.number().int(),
      liquidity: z.string().describe("liquidity L as an integer string"),
      slippageBps: z.number().int().min(0).max(5000).optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () =>
          removeLiquidityPlan(ctx, BigInt(args.tokenId), {
            tickLower: args.tickLower,
            tickUpper: args.tickUpper,
            liquidity: args.liquidity,
            slippageBps: args.slippageBps ?? 100,
          }),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_episode_list",
  {
    title: "List episodes",
    description: "Trailer + episodes for a token with prices and whether a video exists.",
    inputSchema: { tokenId: z.string(), chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await listEpisodes(ctx, BigInt(args.tokenId)))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_episode_watch",
  {
    title: "Resolve an episode URL",
    description:
      "Re-checks the on-chain entitlement and returns a playable URL (capability link) for a purchased or free episode.",
    inputSchema: {
      tokenId: z.string(),
      no: z.number().int().min(0),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await watchEpisode(ctx, BigInt(args.tokenId), args.no))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_episode_unlock",
  {
    title: "Unlock a paid episode",
    description: "Buy permanent access to one episode with vault $P.",
    inputSchema: {
      tokenId: z.string(),
      no: z.number().int().min(1),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(
        ctx,
        () => unlockEpisodePlan(ctx, BigInt(args.tokenId), args.no),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_predict_list",
  {
    title: "List prediction markets",
    description: "YES/NO markets with live supply, odds and pot.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      start: z.number().int().min(0).optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await listMarkets(ctx, { limit: args.limit ?? 20, start: args.start ?? 0 }))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_predict_quote",
  {
    title: "Quote prediction shares",
    description: "Exact cost or redemption for N YES/NO shares (quoteBuy / quoteSell).",
    inputSchema: {
      digest: z.string(),
      outcome: z.enum(["yes", "no"]),
      amount: z.string(),
      side: z.enum(["buy", "sell"]).optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(
        await quoteShares(ctx, args.digest as Address, {
          outcome: args.outcome,
          amount: args.amount,
          side: args.side ?? "buy",
        }),
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_vault",
  {
    title: "Trading vault",
    description: "Show vault $P, or move $P between the wallet and the vault (deposit/withdraw).",
    inputSchema: {
      action: z.enum(["show", "deposit", "withdraw"]).optional(),
      amountP: z.string().optional(),
      chain: chainArg,
      signer: signerArg,
      confirm: confirmArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      if (!args.action || args.action === "show") return ok(await readBalances(ctx))
      if (!args.amountP) throw new PopoError("usage", "amountP is required for deposit/withdraw")
      return await writeTool(
        ctx,
        () =>
          args.action === "deposit"
            ? vaultDepositPlan(ctx, args.amountP!)
            : vaultWithdrawPlan(ctx, args.amountP!),
        args.confirm,
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_faucet",
  {
    title: "Claim testnet $P",
    description:
      "Signed faucet drip (1,000,000 testnet $P per wallet per chain per day). No gas required for the drip itself.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await faucetClaim(ctx))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_invite",
  {
    title: "Referral state",
    description: "Referral code, bound referrer, pending and lifetime $P rewards.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await referralState(ctx))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_invite_claim",
  {
    title: "Claim referral rewards",
    description: "Claim earned referral $P into the trading vault.",
    inputSchema: { chain: chainArg, signer: signerArg, confirm: confirmArg },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return await writeTool(ctx, () => claimReferralPlan(ctx), args.confirm)
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_beans",
  {
    title: "Earn Beans",
    description: "Beans balance/status, or perform the daily check-in (off-chain PoPoAuth write).",
    inputSchema: {
      action: z.enum(["status", "checkin"]).optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: WRITE,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(args.action === "checkin" ? await beansCheckin(ctx) : await beansStatus(ctx))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_admin_roles",
  {
    title: "Admin role check",
    description: "Whether the active wallet passes the on-chain canCall() admin check.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await hasAnyRole(ctx))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_stats",
  {
    title: "Chain totals",
    description: "Total tokens and prediction markets deployed on the chain.",
    inputSchema: { chain: chainArg, signer: signerArg },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(await dashboardStats(ctx))
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_raw_call",
  {
    title: "Raw contract call",
    description:
      "Escape hatch: eth_call any function in the merged Diamond ABI. Use popo_call_list to discover names.",
    inputSchema: {
      fn: z.string(),
      args: z.array(z.any()).optional(),
      to: z.string().optional(),
      chain: chainArg,
      signer: signerArg,
    },
    annotations: READ,
  },
  async (args) => {
    try {
      const ctx = await ctxFor(args)
      return ok(
        await rawCall(ctx, {
          fn: args.fn,
          params: args.args ?? [],
          ...(args.to ? { target: args.to as Address } : {}),
        }),
      )
    } catch (error) {
      return err(error)
    }
  },
)

server.registerTool(
  "popo_call_list",
  {
    title: "List contract functions",
    description: "Every function available on the merged PoPoApp Diamond ABI.",
    inputSchema: {},
    annotations: READ,
  },
  async () => ok({ functions: listFunctions() }),
)

server.registerTool(
  "popo_zerodev_probe",
  {
    title: "ZeroDev feasibility",
    description:
      "EntryPoint v0.7 deployment and bundler reachability per supported chain — the evidence for the ZeroDev integration.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const probes = await Promise.all(listChains().map((c) => probeZeroDev(c)))
      return ok({ probes, session: sessionStatus() })
    } catch (error) {
      return err(error)
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr only: stdout is the MCP channel
  process.stderr.write(
    `popo-mcp ready · chains ${listChains()
      .map((c) => c.chainId)
      .join(", ")} · max $P per write ${formatP(0n) === "0" ? readConfig().maxP : ""}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`popo-mcp failed to start: ${(error as Error).message}\n`)
  process.exit(1)
})
