#!/usr/bin/env node
/**
 * Real-chain end-to-end run (docs/scope.md §5).
 *
 * Drives the *installed CLI* (not the modules directly), so it exercises the
 * same path a user or an agent takes: quote → simulate → confirm → broadcast.
 *
 *   npm run e2e -- --chain 421614 [--yes] [--skip-create]
 *
 * Without --yes every step stops at the confirmation gate (exit 3); with --yes
 * the run needs gas, and a human to approve each MetaMask MFA prompt.
 *
 * Prints a JSON report and exits non-zero on the first failing step.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith("--") ? next : true
}
const has = (name) => argv.includes(`--${name}`)

const CHAIN = String(flag("chain", "421614"))
const YES = has("yes")
const SKIP_CREATE = has("skip-create")
const BUY_P = String(flag("buy-p", "5"))
const SLIPPAGE = String(flag("slippage-bps", "200"))

const report = { chain: CHAIN, startedAt: new Date().toISOString(), steps: [] }

function record(step, status, detail) {
  report.steps.push({ step, status, ...(detail === undefined ? {} : { detail }) })
  const icon = status === "ok" ? "✔" : status === "skip" ? "•" : status === "gate" ? "⏸" : "✖"
  console.log(`${icon} ${step}${detail && typeof detail === "string" ? ` — ${detail}` : ""}`)
}

/** Run the CLI and parse its JSON envelope. */
async function popo(args, { allowGate = false, timeout = 660_000 } = {}) {
  try {
    const { stdout } = await run("node", ["dist/cli.js", ...args, "--json"], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    const start = stdout.indexOf("{")
    return { ok: true, data: JSON.parse(stdout.slice(start)) }
  } catch (error) {
    const stdout = error.stdout ?? ""
    const start = stdout.indexOf("{")
    const parsed = start >= 0 ? JSON.parse(stdout.slice(start)) : null
    const exitCode = error.code ?? null
    if (allowGate && exitCode === 3) return { ok: false, gate: true, data: parsed, exitCode }
    return { ok: false, data: parsed, exitCode, stderr: (error.stderr ?? "").slice(0, 400) }
  }
}

/** Run a write: dry-run gate first, then the real thing when --yes is present. */
async function write(step, args) {
  const preview = await popo(args, { allowGate: true })
  if (!preview.gate && !preview.ok) {
    record(step, "fail", preview.data ?? preview.stderr)
    return null
  }
  if (!preview.gate) {
    // Already executed (e.g. faucet, which takes no --yes).
    record(step, "ok", { sent: true, ...preview.data })
    return preview.data
  }
  if (!YES) {
    record(step, "gate", preview.data?.details?.summary ?? "confirmation required")
    return null
  }
  const sent = await popo([...args, "--yes"])
  if (!sent.ok) {
    record(step, "fail", sent.data ?? sent.stderr)
    return null
  }
  const hash = sent.data?.calls?.find((c) => c.hash)?.hash ?? null
  record(step, "ok", hash ? { hash, explorer: sent.data.calls[0]?.explorer } : sent.data)
  return sent.data
}

async function main() {
  console.log(`\nPoPo real-chain E2E · chain ${CHAIN} · ${YES ? "SEND" : "DRY-RUN"}\n`)

  // 1. orient
  const status = await popo(["status", "--chain", CHAIN])
  if (!status.ok) {
    record("status", "fail", status.data ?? status.stderr)
    return finish(1)
  }
  const s = status.data
  record("status", "ok", {
    signer: s.identity.signer,
    onchain: s.identity.onchain.address,
    gas: `${s.balances.native.formatted} ${s.balances.native.symbol}`,
    walletP: s.balances.walletP.formatted,
    vaultP: s.balances.vaultP.formatted,
  })

  const gas = Number(s.balances.native.formatted)
  if (gas === 0) {
    record("gas precheck", "fail", "no native gas on the signer address — fund it first")
    return finish(1)
  }

  // 2. faucet (needs no gas; skip when the wallet already holds $P)
  if (Number(s.balances.walletP.formatted) < 5) {
    const faucet = await popo(["faucet", "--chain", CHAIN])
    record(
      "faucet",
      faucet.ok ? "ok" : "fail",
      faucet.ok ? { txHash: faucet.data.txHash, amountP: faucet.data.amountP } : faucet.data,
    )
    if (!faucet.ok) return finish(1)
    await new Promise((r) => setTimeout(r, 12_000))
  } else {
    record("faucet", "skip", `wallet already holds ${s.balances.walletP.formatted} $P`)
  }

  // 3. vault deposit
  const deposited = await write("vault deposit", ["vault", "deposit", "20", "--chain", CHAIN])
  if (!deposited) return finish(YES ? 1 : 0)

  // 4. create a token
  let tokenId = null
  if (!SKIP_CREATE) {
    const name = `E2E ${new Date().toISOString().slice(11, 19)}`
    const symbol = `E2E${Math.floor(Math.random() * 900 + 100)}`
    const created = await write("hatch create", [
      "hatch",
      "create",
      "--name",
      name,
      "--symbol",
      symbol,
      "--chain",
      CHAIN,
    ])
    if (!created) return finish(YES ? 1 : 0)
    const stats = await popo(["stats", "--chain", CHAIN])
    tokenId = stats.ok ? String(BigInt(stats.data.totalTokens) - 1n) : null
    record("new tokenId", tokenId ? "ok" : "fail", tokenId)
  }

  // 5. quote → buy → sell on the curve
  if (tokenId) {
    const quote = await popo([
      "hatch",
      "quote",
      tokenId,
      "--side",
      "buy",
      "--amount",
      BUY_P,
      "--chain",
      CHAIN,
    ])
    record("hatch quote (buy)", quote.ok ? "ok" : "fail", quote.data)

    const bought = await write("hatch buy", [
      "hatch",
      "buy",
      tokenId,
      "--p",
      BUY_P,
      "--chain",
      CHAIN,
      "--slippage-bps",
      SLIPPAGE,
    ])
    if (!bought) return finish(YES ? 1 : 0)

    const sellAmount = quote.ok ? (Number(quote.data.tokensOut) * 0.5).toFixed(6) : "1"
    const sold = await write("hatch sell", [
      "hatch",
      "sell",
      tokenId,
      "--tokens",
      sellAmount,
      "--chain",
      CHAIN,
      "--slippage-bps",
      SLIPPAGE,
    ])
    if (!sold) return finish(YES ? 1 : 0)
  }

  // 6. AMM precondition: current token is far from graduation — report state only
  if (tokenId) {
    const token = await popo(["hatch", "get", tokenId, "--chain", CHAIN])
    record("curve state", token.ok ? "ok" : "fail", {
      progressPct: token.data?.progressPct,
      status: token.data?.status,
      note: "migrate needs a completed curve (14,000 $P of net buys)",
    })

    const amm = await popo([
      "amm",
      "quote",
      tokenId,
      "--side",
      "buy",
      "--amount",
      "1",
      "--chain",
      CHAIN,
    ])
    record(
      "amm quote",
      amm.ok ? "ok" : "skip",
      amm.ok ? amm.data : "pool not initialised yet (expected before graduation)",
    )
  }

  // 7. prediction: list + exact quote
  const markets = await popo(["predict", "list", "--limit", "5", "--chain", CHAIN])
  if (markets.ok && markets.data.markets.length > 0) {
    const market = markets.data.markets.find((m) => m.status === "enabled")
    record("predict list", "ok", { count: markets.data.markets.length, potP: market?.potP ?? null })
    if (market) {
      const q = await popo([
        "predict",
        "quote",
        market.digest,
        "--outcome",
        "yes",
        "--amount",
        "1",
        "--chain",
        CHAIN,
      ])
      record("predict quote", q.ok ? "ok" : "fail", q.data)
    }
  } else {
    record("predict list", "fail", markets.data)
  }

  // 8. episodes: find a token that actually has one, then quote the unlock
  const withEpisodes = await findTokenWithEpisodes()
  if (withEpisodes) {
    const list = await popo(["episode", "list", withEpisodes.tokenId, "--chain", CHAIN])
    if (list.ok) {
      const paid = list.data.episodes.find((e) => !e.free)
      record("episode list", "ok", {
        tokenId: withEpisodes.tokenId,
        episodes: list.data.episodes.length,
        paidPrice: paid?.priceP ?? null,
      })
      if (paid) {
        const unlock = await write("episode unlock", [
          "episode",
          "unlock",
          withEpisodes.tokenId,
          String(paid.no),
          "--chain",
          CHAIN,
        ])
        if (!unlock) return finish(YES ? 1 : 0)
        const watch = await popo([
          "episode",
          "watch",
          withEpisodes.tokenId,
          String(paid.no),
          "--chain",
          CHAIN,
        ])
        record(
          "episode watch",
          watch.ok ? "ok" : "fail",
          watch.ok ? "capability url received (not logged)" : watch.data,
        )
      }
    }
  } else {
    record("episode list", "skip", "no token with episodes on this chain")
  }

  // 9. off-chain write: beans check-in (PoPoAuth)
  const beans = await popo(["beans", "checkin", "--chain", CHAIN])
  record(
    "beans checkin",
    beans.ok ? "ok" : "skip",
    beans.ok
      ? beans.data
      : `${beans.data?.code ?? "error"}: ${beans.data?.message ?? ""}`,
  )

  // 10. final balances
  const after = await popo(["status", "--chain", CHAIN])
  if (after.ok) {
    record("final balances", "ok", {
      walletP: after.data.balances.walletP.formatted,
      vaultP: after.data.balances.vaultP.formatted,
    })
  }

  return finish(report.steps.some((st) => st.status === "fail") ? 1 : 0)
}

async function findTokenWithEpisodes() {
  const res = await fetch(
    "https://novxohcvvpoqcfkpsvcj.supabase.co/rest/v1/hatch_episodes?select=token_id,episode_no,title&order=episode_no.desc&limit=20",
    {
      headers: {
        apikey: "sb_publishable_A2-HZxZTl7BerXI0-dW9jg__1BaYK-T",
        Authorization: "Bearer sb_publishable_A2-HZxZTl7BerXI0-dW9jg__1BaYK-T",
      },
    },
  ).catch(() => null)
  if (!res?.ok) return null
  const rows = await res.json().catch(() => [])
  const row = rows.find((r) => Number(r.episode_no) > 0)
  return row ? { tokenId: String(row.token_id) } : null
}

function finish(code) {
  report.finishedAt = new Date().toISOString()
  report.ok = code === 0
  console.log(`\n${JSON.stringify(report, null, 2)}`)
  if (!YES) console.log("\nDry-run only. Re-run with --yes to broadcast.")
  process.exit(code)
}

main().catch((error) => {
  console.error("e2e crashed:", error?.message ?? error)
  process.exit(1)
})
