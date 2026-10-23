#!/usr/bin/env node
/**
 * popo — PoPo.meme from any terminal / AI harness.
 *
 * Every command prints JSON when piped (`--json` or non-TTY) and a compact
 * human block in a TTY. Writes are simulation-gated: without `--yes` the
 * process exits 3 after printing exactly what would happen.
 */

import { Command, Option } from "commander"
import { PopoError, formatP, parseP, shortAddr, type Address } from "../core/base"
import { getChain, listChains, type ChainConfig } from "../core/chains"
import { readConfig, writeConfig, type SignerKind } from "../core/config"
import { resolveSigner } from "../core/signer"
import {
  grantSession,
  probeZeroDev,
  readSession,
  revokeSession,
  sessionStatus,
} from "../core/signer/zerodev"
import { chainHealth, publicClientFor } from "../core/rpc"
import { executePlan, explainResults, type WritePlan } from "../core/tx"
import {
  makeCtx,
  faucetClaim,
  faucetStatus,
  hasAnyRole,
  readBalances,
  setCreateTokenFeePlan,
  status,
  usdpBalance,
  vaultDepositPlan,
  vaultWithdrawPlan,
  rawCall,
  listFunctions,
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
  lpPositions,
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
  beansTasks,
  billingHistory,
  bindReferralPlan,
  claimReferralPlan,
  dashboardStats,
  profileView,
  referralState,
} from "../modules/social"
import { c, emit, fail, kv, outputOptions, table, type OutputOptions } from "./render"

const program = new Command()

program
  .name("popo")
  .description("PoPo.meme for AI harnesses — hatch tokens, AMM, episodes, prediction, beans")
  .version("0.1.0")
  .option("--chain <id|key>", "chain id or key (421614 | 46630)")
  .option("--json", "machine-readable JSON output")
  .option("--signer <kind>", "auto | mm | zerodev | local | readonly")
  .option("--address <address>", "read as this address (implies read-only)")
  .addOption(new Option("--yes", "actually send writes").default(false))
  .option("--dry-run", "simulate only, never send", false)
  .option("--slippage-bps <bps>", "slippage guard in bps", "100")

interface GlobalOptions {
  chain?: string
  json?: boolean
  signer?: SignerKind
  address?: string
  yes: boolean
  dryRun: boolean
  slippageBps: string
}

function globalOpts(): GlobalOptions {
  return program.opts<GlobalOptions>()
}

async function context(): Promise<Ctx> {
  const opts = globalOpts()
  const cfg = readConfig()
  const chain = getChain(opts.chain ?? cfg.chainId)
  const signer = await resolveSigner(chain, {
    kind: opts.signer ?? cfg.signer,
    address: (opts.address as Address | undefined) ?? null,
  })
  return makeCtx(chain, signer)
}

async function runPlan(ctx: Ctx, plan: WritePlan): Promise<void> {
  const opts = globalOpts()
  const out = outputOptions(opts)
  const { simulated, results } = await executePlan(ctx.chain, ctx.signer, plan, {
    yes: Boolean(opts.yes),
    dryRun: Boolean(opts.dryRun),
  })

  emit(
    out,
    {
      action: plan.action,
      chainId: ctx.chain.chainId,
      signer: ctx.signer.kind,
      address: ctx.signer.onchainAddress,
      calls: results.map((r) => ({
        label: r.label,
        hash: r.hash,
        explorer: r.explorerUrl,
        status: r.status ?? null,
      })),
      gas: simulated.map((s) => s.gas?.toString() ?? null),
    },
    [
      ...plan.summary.map((line) => `  ${line}`),
      "",
      ...explainResults(ctx.chain, results).map((line) => `  ${line}`),
    ],
    `✔ ${plan.action}`,
  )
}

/** Re-wrap a confirmation_required error so it also carries the plan summary. */
async function planOrPreview(ctx: Ctx, build: () => Promise<WritePlan>): Promise<void> {
  const plan = await build()
  await runPlan(ctx, plan)
}

function withCommand(name: string, description: string): Command {
  return program.command(name).description(description)
}

/* ------------------------------------------------------------------ meta */

withCommand("status", "one call that returns everything worth knowing").action(
  async () => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const s = await status(ctx)
    emit(
      out,
      s as unknown as Record<string, unknown>,
      [
        `${c.bold("chain")}      ${s.chain.label} (${s.chain.chainId})`,
        `${c.bold("signer")}     ${s.identity.signer}${s.identity.requiresApproval ? " (approval per write)" : ""}`,
        `${c.bold("on-chain")}   ${s.identity.onchain.address}`,
        `${c.bold("off-chain")}  ${s.identity.offchain.address}${s.identity.offchain.sameAsOnchain ? " (same)" : " (EOA — PoPoAuth)"}`,
        `${c.bold("gas")}        ${s.balances.native.formatted} ${s.balances.native.symbol}`,
        `${c.bold("wallet $P")}  ${s.balances.walletP.formatted}`,
        `${c.bold("vault $P")}   ${s.balances.vaultP.formatted}`,
        `${c.bold("tokens")}     ${s.tokens.length} created by this wallet`,
        ...(s.next.length ? ["", ...s.next.map((h) => `→ ${h}`)] : []),
      ],
      "PoPo status",
    )
  },
)

withCommand("doctor", "environment self-check (safe to paste into a chat)")
  .option("--install-chains", "inject PoPo chains into ~/.metamask/wallets.json", false)
  .action(async (cmdOpts: { installChains: boolean }) => {
    const out = outputOptions(globalOpts())
    const cfg = readConfig()
    const chains = listChains()
    const health = await Promise.all(chains.map((chain) => chainHealth(chain)))
    const probes = await Promise.all(chains.map((chain) => probeZeroDev(chain).catch(() => null)))
    let mm: Record<string, unknown> = { installed: false }
    try {
      const signer = await resolveSigner(chains[0]!, { kind: "mm" })
      mm = { installed: true, address: signer.onchainAddress, ...(await signer.describe()) }
    } catch (error) {
      mm = { installed: false, error: (error as Error).message.slice(0, 200) }
    }
    const payload = {
      config: { path: "~/.popo/config.json", ...cfg },
      chains: chains.map((chain, i) => ({
        ...health[i],
        key: chain.key,
        label: chain.label,
        zeroDev: probes[i],
      })),
      signer: mm,
      session: sessionStatus(),
      node: process.version,
    }
    emit(
      out,
      payload,
      [
        ...table(
          payload.chains.map((ch) => [
            String(ch.chainId),
            ch.label,
            ch.ok ? "rpc ok" : "rpc FAIL",
            ch.blockNumber ?? "—",
            ch.zeroDev?.entryPointDeployed ? "entrypoint ✓" : "entrypoint ✗",
            ch.zeroDev?.bundlerReachable === null
              ? "no project id"
              : ch.zeroDev?.bundlerReachable
                ? "bundler ✓"
                : "bundler ✗",
          ]),
          ["chain", "label", "rpc", "block", "4337", "zerodev"],
        ),
        "",
        ...kv([
          ["mm", mm.installed ? String(mm.address) : "not available"],
          ["zeroDev session", sessionStatus() ? "granted" : "none"],
          ["default chain", cfg.chainId],
          ["max $P per write", cfg.maxP],
        ]),
        ...(cmdOpts.installChains
          ? ["", "note: chain injection into mm is documented in docs/mm-integration.md"]
          : []),
      ],
      "PoPo doctor",
    )
  })

withCommand("chains", "list supported networks").action(async () => {
  const out = outputOptions(globalOpts())
  const cfg = readConfig()
  emit(
    out,
    { chains: listChains() },
    table(
      listChains().map((ch) => [
        String(ch.chainId),
        ch.key,
        ch.label,
        ch.gasSymbol,
        ch.chainId === cfg.chainId ? "*" : "",
      ]),
      ["chainId", "key", "label", "gas", "default"],
    ),
    "chains",
  )
})

withCommand("use", "set the default chain").argument("<chain>").action(async () => {
  const opts = globalOpts()
  const chain = getChain(opts.chain ?? program.args[1])
  writeConfig({ chainId: chain.chainId })
  emit(outputOptions(opts), { chainId: chain.chainId }, [`default chain → ${chain.label}`])
})

withCommand("balance", "wallet + vault balances")
  .option("--token <sym>", "only this token (usdp|native)")
  .action(async (cmdOpts: { token?: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const balances = await readBalances(ctx)
    if (cmdOpts.token === "usdp") {
      const only = await usdpBalance(ctx)
      emit(out, only, [`wallet $P ${only.formatted}`])
      return
    }
    emit(
      out,
      balances as unknown as Record<string, unknown>,
      kv([
        ["address", balances.address],
        ["native", `${balances.native.formatted} ${balances.native.symbol}`],
        ["wallet $P", balances.walletP.formatted],
        ["vault $P", balances.vaultP.formatted],
        ["diamond operator", balances.isOperator ? "yes" : "no"],
      ]),
      `${ctx.chain.label} balances`,
    )
  })

/* ----------------------------------------------------------------- vault */

const vault = program.command("vault").description("trading vault ($P in/out)")

vault.command("show").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const balances = await readBalances(ctx)
  emit(
    out,
    balances as unknown as Record<string, unknown>,
    kv([
      ["wallet $P", balances.walletP.formatted],
      ["vault $P", balances.vaultP.formatted],
      ["operator", balances.isOperator ? "granted" : "missing"],
    ]),
    "vault",
  )
})

vault.command("deposit <amountP>").action(async (amountP: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => vaultDepositPlan(ctx, amountP))
})

vault.command("withdraw <amountP>").action(async (amountP: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => vaultWithdrawPlan(ctx, amountP))
})

/* ----------------------------------------------------------------- hatch */

const hatch = program.command("hatch").description("PPHatch bonding-curve tokens")

hatch
  .command("list")
  .option("--limit <n>", "how many", "20")
  .option("--q <text>", "search name/symbol")
  .option("--status <status>", "all|active|graduated", "all")
  .option("--sort <sort>", "newest|oldest", "newest")
  .action(async (cmdOpts: { limit: string; q?: string; status: string; sort: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const tokens = await listTokens(ctx, {
      limit: Number(cmdOpts.limit),
      q: cmdOpts.q,
      status: cmdOpts.status,
      sort: cmdOpts.sort,
    })
    emit(
      out,
      { chainId: ctx.chain.chainId, tokens },
      table(
        tokens.map((t) => [
          t.tokenId,
          t.symbol,
          t.name,
          t.status,
          `${t.progressPct}%`,
          shortAddr(t.creator),
        ]),
        ["id", "sym", "name", "status", "curve", "creator"],
      ),
      `${tokens.length} tokens on ${ctx.chain.label}`,
    )
  })

hatch.command("get <tokenId>").action(async (tokenId: string) => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const token = await getToken(ctx, BigInt(tokenId))
  emit(
    out,
    token as unknown as Record<string, unknown>,
    kv([
      ["id", token.tokenId],
      ["name", `${token.name} (${token.symbol})`],
      ["creator", token.creator],
      ["status", token.status],
      ["curve", `${token.progressPct}% of ${formatP(BigInt(token.graduationThreshold))} $P`],
      ["image", token.image ?? "—"],
    ]),
    `${token.name} (${token.symbol})`,
  )
})

hatch
  .command("quote <tokenId>")
  .addOption(new Option("--side <side>", "buy|sell").choices(["buy", "sell"]).default("buy"))
  .option("--amount <amount>", "how much ($P when buying, tokens when selling)")
  .option("--tokens <amount>", "alias for --amount on sell")
  .action(async (tokenId: string, cmdOpts: { side: "buy" | "sell"; amount?: string; tokens?: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const amount = cmdOpts.side === "buy" ? cmdOpts.amount : (cmdOpts.tokens ?? cmdOpts.amount)
    if (!amount) throw new PopoError("usage", "pass --amount")
    const quote =
      cmdOpts.side === "buy"
        ? await previewBuy(ctx, BigInt(tokenId), amount)
        : await previewSell(ctx, BigInt(tokenId), amount)
    emit(
      out,
      quote as unknown as Record<string, unknown>,
      kv(Object.entries(quote) as [string, unknown][]),
      `quote ${cmdOpts.side} #${tokenId}`,
    )
  })

hatch
  .command("create")
  .requiredOption("--name <name>")
  .requiredOption("--symbol <symbol>")
  .option("--uri <uri>", "metadata uri", "ipfs://")
  .action(async (cmdOpts: { name: string; symbol: string; uri: string }) => {
    const ctx = await context()
    await planOrPreview(ctx, () => createTokenPlan(ctx, cmdOpts))
  })

hatch
  .command("buy <tokenId>")
  .requiredOption("--p <amountP>", "how much $P to spend")
  .action(async (tokenId: string, cmdOpts: { p: string }) => {
    const ctx = await context()
    const slippage = Number(globalOpts().slippageBps)
    await planOrPreview(ctx, () => buyPlan(ctx, BigInt(tokenId), cmdOpts.p, slippage))
  })

hatch
  .command("sell <tokenId>")
  .requiredOption("--tokens <amount>", "how many tokens to sell")
  .action(async (tokenId: string, cmdOpts: { tokens: string }) => {
    const ctx = await context()
    const slippage = Number(globalOpts().slippageBps)
    await planOrPreview(ctx, () => sellPlan(ctx, BigInt(tokenId), cmdOpts.tokens, slippage))
  })

hatch.command("migrate <tokenId>").action(async (tokenId: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => migratePlan(ctx, BigInt(tokenId)))
})

hatch
  .command("holders <tokenId>")
  .option("--limit <n>", "how many", "20")
  .action(async (tokenId: string, cmdOpts: { limit: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const rows = await holders(ctx, BigInt(tokenId), Number(cmdOpts.limit))
    emit(out, { holders: rows }, table(rows.map((r: any) => [r.holder, String(r.balance)]), [
      "holder",
      "balance",
    ]))
  })

hatch
  .command("trades <tokenId>")
  .option("--limit <n>", "how many", "20")
  .action(async (tokenId: string, cmdOpts: { limit: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const rows = await trades(ctx, BigInt(tokenId), Number(cmdOpts.limit))
    emit(
      out,
      { trades: rows },
      table(
        rows.map((r: any) => [
          String(r.created_at ?? "").slice(0, 19),
          String(r.side ?? ""),
          String(r.quote_amount ?? ""),
          String(r.token_amount ?? ""),
          shortAddr(String(r.trader ?? "")),
        ]),
        ["time", "side", "$P", "tokens", "trader"],
      ),
    )
  })

/* ------------------------------------------------------------------- amm */

const amm = program.command("amm").description("post-graduation AMM + liquidity")

amm
  .command("quote <tokenId>")
  .addOption(new Option("--side <side>", "buy|sell").choices(["buy", "sell"]).default("buy"))
  .addOption(new Option("--exact <mode>", "in|out").choices(["in", "out"]).default("in"))
  .requiredOption("--amount <amount>")
  .action(async (tokenId: string, cmdOpts: { side: "buy" | "sell"; exact: "in" | "out"; amount: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const quote = await ammQuote(ctx, BigInt(tokenId), cmdOpts)
    emit(out, quote as unknown as Record<string, unknown>, kv(Object.entries(quote) as [string, unknown][]), `amm quote #${tokenId}`)
  })

amm
  .command("swap <tokenId>")
  .addOption(new Option("--side <side>", "buy|sell").choices(["buy", "sell"]).default("buy"))
  .addOption(new Option("--exact <mode>", "in|out").choices(["in", "out"]).default("in"))
  .requiredOption("--amount <amount>")
  .action(async (tokenId: string, cmdOpts: { side: "buy" | "sell"; exact: "in" | "out"; amount: string }) => {
    const ctx = await context()
    const slippage = Number(globalOpts().slippageBps)
    await planOrPreview(ctx, () =>
      ammSwapPlan(ctx, BigInt(tokenId), { ...cmdOpts, slippageBps: slippage }),
    )
  })

const lp = amm.command("lp").description("liquidity positions")

lp.command("list <tokenId>").action(async (tokenId: string) => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const positions = await lpPositions(ctx)
  emit(out, { tokenId, ...positions }, [], `lp positions #${tokenId}`)
})

lp
  .command("add <tokenId>")
  .requiredOption("--p <amountP>")
  .requiredOption("--tokens <amount>")
  .option("--tick-lower <tick>")
  .option("--tick-upper <tick>")
  .action(async (tokenId: string, cmdOpts: { p: string; tokens: string; tickLower?: string; tickUpper?: string }) => {
    const ctx = await context()
    await planOrPreview(ctx, () =>
      addLiquidityPlan(ctx, BigInt(tokenId), {
        amountP: cmdOpts.p,
        tokens: cmdOpts.tokens,
        ...(cmdOpts.tickLower ? { tickLower: Number(cmdOpts.tickLower) } : {}),
        ...(cmdOpts.tickUpper ? { tickUpper: Number(cmdOpts.tickUpper) } : {}),
      }),
    )
  })

lp
  .command("remove <tokenId>")
  .requiredOption("--tick-lower <tick>")
  .requiredOption("--tick-upper <tick>")
  .requiredOption("--liquidity <L>")
  .action(async (tokenId: string, cmdOpts: { tickLower: string; tickUpper: string; liquidity: string }) => {
    const ctx = await context()
    await planOrPreview(ctx, () =>
      removeLiquidityPlan(ctx, BigInt(tokenId), {
        tickLower: Number(cmdOpts.tickLower),
        tickUpper: Number(cmdOpts.tickUpper),
        liquidity: cmdOpts.liquidity,
        slippageBps: Number(globalOpts().slippageBps),
      }),
    )
  })

/* -------------------------------------------------------------- episodes */

const episode = program.command("episode").description("trailers and paid episodes")

episode.command("list <tokenId>").action(async (tokenId: string) => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const rows = await listEpisodes(ctx, BigInt(tokenId))
  emit(
    out,
    { episodes: rows },
    table(
      rows.map((e) => [
        String(e.no),
        e.title ?? "(untitled)",
        e.free ? "free" : `${e.priceP} $P`,
        e.hasVideo ? "video ✓" : "no video",
      ]),
      ["#", "title", "price", "media"],
    ),
    `episodes of #${tokenId}`,
  )
})

episode
  .command("watch <tokenId> <no>")
  .description("resolve a playable URL (checks your entitlement)")
  .action(async (tokenId: string, no: string) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const result = await watchEpisode(ctx, BigInt(tokenId), Number(no))
    emit(out, result as unknown as Record<string, unknown>, [
      `url: ${result.url ?? "(none)"}`,
      ...(result.trailer ? ["(trailer)"] : []),
    ])
  })

episode.command("unlock <tokenId> <no>").action(async (tokenId: string, no: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => unlockEpisodePlan(ctx, BigInt(tokenId), Number(no)))
})

/* ------------------------------------------------------------ prediction */

const predict = program.command("predict").description("YES/NO prediction markets")

predict
  .command("list")
  .option("--limit <n>", "how many", "20")
  .option("--start <n>", "offset", "0")
  .action(async (cmdOpts: { limit: string; start: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const markets = await listMarkets(ctx, {
      limit: Number(cmdOpts.limit),
      start: Number(cmdOpts.start),
    })
    emit(
      out,
      { markets },
      table(
        markets.map((m) => [
          String(m.index),
          String(m.digest).slice(0, 10),
          (m.title ?? "(metadata missing)").slice(0, 40),
          m.status,
          m.yesPct === null ? "—" : `${m.yesPct}% yes`,
          m.potP ?? "—",
        ]),
        ["#", "digest", "title", "status", "odds", "pot"],
      ),
      `${markets.length} markets on ${ctx.chain.label}`,
    )
  })

predict.command("get <digest>").action(async (digest: string) => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const market = await getMarket(ctx, digest as `0x${string}`)
  emit(out, market as unknown as Record<string, unknown>, kv(Object.entries(market) as [string, unknown][]), market.title ?? digest)
})

predict
  .command("quote <digest>")
  .addOption(new Option("--outcome <outcome>", "yes|no").choices(["yes", "no"]).makeOptionMandatory())
  .addOption(new Option("--side <side>", "buy|sell").choices(["buy", "sell"]).default("buy"))
  .requiredOption("--amount <shares>")
  .action(async (digest: string, cmdOpts: { outcome: "yes" | "no"; side: "buy" | "sell"; amount: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const quote = await quoteShares(ctx, digest as `0x${string}`, cmdOpts)
    emit(out, quote as unknown as Record<string, unknown>, kv(Object.entries(quote) as [string, unknown][]), "predict quote")
  })

/* ------------------------------------------------------- invite/beans/etc */

const invite = program.command("invite").description("referral rewards")

invite.command("show").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const state = await referralState(ctx)
  emit(out, state as unknown as Record<string, unknown>, kv(Object.entries(state) as [string, unknown][]), "invite")
})

invite.command("bind <referrer>").action(async (referrer: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => bindReferralPlan(ctx, referrer as Address))
})

invite.command("claim").action(async () => {
  const ctx = await context()
  await planOrPreview(ctx, () => claimReferralPlan(ctx))
})

const beans = program.command("beans").description("Earn Beans")

beans.command("status").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const result = await beansStatus(ctx)
  emit(out, result as Record<string, unknown>, kv(Object.entries(result as object) as [string, unknown][]), "beans")
})

beans.command("checkin").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const result = await beansCheckin(ctx)
  emit(out, result as Record<string, unknown>, kv(Object.entries(result as object) as [string, unknown][]), "beans check-in")
})

beans.command("tasks").action(async () => {
  const out = outputOptions(globalOpts())
  const result = await beansTasks()
  emit(out, result as Record<string, unknown>, [], "beans tasks")
})

const profile = program.command("profile").description("profiles")

profile.command("show [address]").action(async (address?: string) => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const view = await profileView(ctx, address)
  emit(out, view as Record<string, unknown>, kv(Object.entries(view) as [string, unknown][]), "profile")
})

withCommand("billing", "transaction ledger").option("--limit <n>", "rows", "20").action(
  async (cmdOpts: { limit: string }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const rows = await billingHistory(ctx, Number(cmdOpts.limit))
    emit(out, { entries: rows }, [], "billing")
  },
)

withCommand("stats", "chain-level totals").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const result = await dashboardStats(ctx)
  emit(out, result as Record<string, unknown>, kv(Object.entries(result) as [string, unknown][]), "stats")
})

/* ---------------------------------------------------------------- faucet */

withCommand("faucet", "claim testnet $P (signed drip, no gas needed)")
  .option("--status", "only print the cooldown status", false)
  .action(async (cmdOpts: { status: boolean }) => {
    const out = outputOptions(globalOpts())
    const ctx = await context()
    const result = cmdOpts.status ? await faucetStatus(ctx) : await faucetClaim(ctx)
    emit(out, result as Record<string, unknown>, kv(Object.entries(result as object) as [string, unknown][]), "faucet")
  })

/* ----------------------------------------------------------------- admin */

const admin = program.command("admin").description("on-chain admin (canCall-gated)")

admin.command("roles").action(async () => {
  const out = outputOptions(globalOpts())
  const ctx = await context()
  const result = await hasAnyRole(ctx)
  emit(out, result as unknown as Record<string, unknown>, kv(Object.entries(result) as [string, unknown][]), "admin roles")
})

admin.command("set-create-fee <amountP>").action(async (amountP: string) => {
  const ctx = await context()
  await planOrPreview(ctx, () => setCreateTokenFeePlan(ctx, amountP))
})

/* ------------------------------------------------------------- raw calls */

withCommand("call", "raw contract call (escape hatch) — `popo call --list` lists functions")
  .option("--list", "list every callable function", false)
  .option("--fn <name>", "function name")
  .option("--args <json>", "JSON array of arguments", "[]")
  .option("--to <address>", "target (defaults to the diamond)")
  .action(async (cmdOpts: { list: boolean; fn?: string; args: string; to?: string }) => {
    const out = outputOptions(globalOpts())
    if (cmdOpts.list) {
      const names = listFunctions()
      emit(out, { functions: names, count: names.length }, [...names], `${names.length} functions`)
      return
    }
    if (!cmdOpts.fn) throw new PopoError("usage", "pass --fn <name> (see --list)")
    const params = JSON.parse(cmdOpts.args) as unknown[]
    const ctx = await context()
    const result = await rawCall(ctx, {
      fn: cmdOpts.fn,
      params,
      ...(cmdOpts.to ? { target: cmdOpts.to as Address } : {}),
    })
    emit(out, result as unknown as Record<string, unknown>, [`raw: ${result.raw}`])
  })

/* --------------------------------------------------------------- zeroDev */

const zerodev = program.command("zerodev").description("Kernel smart account + session key")

zerodev
  .command("probe")
  .description("check EntryPoint v0.7 and the bundler on each supported chain")
  .action(async () => {
    const out = outputOptions(globalOpts())
    const probes = await Promise.all(listChains().map((chain) => probeZeroDev(chain)))
    emit(
      out,
      { probes },
      table(
        probes.map((p) => [
          String(p.chainId),
          p.entryPointDeployed ? "deployed" : "missing",
          String(p.entryPointCodeSize),
          p.bundlerEndpoint ? (p.bundlerReachable ? "reachable" : "unreachable") : "no project id",
        ]),
        ["chain", "entrypoint", "bytes", "bundler"],
      ),
      "ZeroDev probe",
    )
  })

zerodev
  .command("grant")
  .description("create a scoped session key (one-time owner approval)")
  .option("--owner-key <hex>", "owner private key for the enable signature (or POPO_OWNER_KEY)")
  .option("--project-id <id>", "ZeroDev project id")
  .option("--max-p <amount>", "per-write $P cap (default = config.maxP)")
  .option("--daily-p <amount>", "rolling daily $P cap", "200")
  .option("--days <n>", "validity in days", "7")
  .action(async (cmdOpts: { ownerKey?: string; projectId?: string; maxP?: string; dailyP: string; days: string }) => {
    const out = outputOptions(globalOpts())
    const cfg = readConfig()
    const chain = getChain(globalOpts().chain ?? cfg.chainId)
    const session = await grantSession(chain, {
      ...(cmdOpts.ownerKey ? { ownerKey: cmdOpts.ownerKey as `0x${string}` } : {}),
      ...(cmdOpts.projectId ? { projectId: cmdOpts.projectId } : {}),
      policy: {
        maxP: cmdOpts.maxP ?? cfg.maxP,
        dailyP: cmdOpts.dailyP,
        expiresAt: Date.now() + Number(cmdOpts.days) * 24 * 3600 * 1000,
      },
    })
    emit(
      out,
      {
        smartAccount: session.smartAccount,
        offchainAddress: session.owner,
        policy: session.policy,
        expiresAt: new Date(session.policy.expiresAt).toISOString(),
      },
      [
        `smart account (on-chain identity): ${session.smartAccount}`,
        `owner EOA (off-chain identity):   ${session.owner}`,
        `per-write cap: ${session.policy.maxP} $P · daily: ${session.policy.dailyP} $P`,
        `allowed contracts: ${session.policy.allow.join(", ")}`,
        `expires: ${new Date(session.policy.expiresAt).toISOString()}`,
      ],
      "✔ ZeroDev session granted",
    )
  })

zerodev
  .command("session")
  .argument("[action]", "status|revoke", "status")
  .action(async (action: string) => {
    const out = outputOptions(globalOpts())
    if (action === "revoke") {
      const revoked = revokeSession()
      emit(out, { revoked }, [revoked ? "session revoked (local)" : "no session to revoke"])
      return
    }
    const session = readSession()
    emit(out, { session: sessionStatus(), exists: Boolean(session && "sessionKey" in session) }, [
      ...(sessionStatus()
        ? kv(Object.entries(sessionStatus()!) as [string, unknown][])
        : ["no session — run `popo zerodev grant`"]),
    ])
  })

/* ------------------------------------------------------------------- ui */

withCommand("serve-mcp", "run the MCP server on stdio (what harnesses spawn)").action(
  async () => {
    await import("../mcp/server")
  },
)

withCommand("ui", "interactive TUI").action(async () => {
  const { runTui } = await import("../tui/main")
  await runTui({ chain: globalOpts().chain, signer: globalOpts().signer })
})

/* ---------------------------------------------------------------- main */

program.hook("postAction", () => undefined)

async function main() {
  const out = outputOptions(globalOpts())
  try {
    await program.parseAsync(process.argv)
    if (!process.argv.slice(2).length) program.help()
  } catch (error) {
    fail(out, error)
  }
}

process.on("unhandledRejection", (reason) => {
  fail(outputOptions(globalOpts()), reason)
})

void main()

export { program, context, parseP }
