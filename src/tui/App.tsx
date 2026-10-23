/**
 * `popo ui` — a small interactive dashboard.
 *
 * Read-only by design in v0.1: every actionable write stays in the CLI so the
 * confirmation block (and the JSON exit-3 contract agents rely on) is never
 * bypassed. Keys: ←/→ switch tab, r refresh, q quit.
 */

import React, { useEffect, useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { getChain, listChains } from "../core/chains"
import { readConfig } from "../core/config"
import { resolveSigner } from "../core/signer"
import { makeCtx, readBalances, status } from "../modules/chain"
import { listTokens } from "../modules/hatch"
import { listMarkets } from "../modules/market"

const TABS = ["status", "hatch", "predict", "chain"] as const
type Tab = (typeof TABS)[number]

interface Panel {
  lines: string[]
  error?: string
}

async function loadPanel(tab: Tab, chainArg?: string, signerArg?: string): Promise<Panel> {
  const cfg = readConfig()
  const chain = getChain(chainArg ?? cfg.chainId)
  const signer = await resolveSigner(chain, {
    kind: (signerArg as never) ?? cfg.signer,
  })
  const ctx = await makeCtx(chain, signer)

  if (tab === "status") {
    const s = await status(ctx)
    return {
      lines: [
        `chain      ${s.chain.label} (${s.chain.chainId})`,
        `signer     ${s.identity.signer}${s.identity.requiresApproval ? " · approval per write" : ""}`,
        `on-chain   ${s.identity.onchain.address}`,
        `off-chain  ${s.identity.offchain.address}`,
        `gas        ${s.balances.native.formatted} ${s.balances.native.symbol}`,
        `wallet $P  ${s.balances.walletP.formatted}`,
        `vault $P   ${s.balances.vaultP.formatted}`,
        `tokens     ${s.tokens.length} created`,
        ...(s.next.length ? ["", ...s.next.map((h) => `→ ${h}`)] : []),
      ],
    }
  }
  if (tab === "hatch") {
    const tokens = await listTokens(ctx, { limit: 10 })
    return {
      lines: tokens.map(
        (t) => `${t.tokenId.padStart(4)}  ${t.symbol.padEnd(8)} ${t.progressPct
          .toString()
          .padStart(5)}%  ${t.status.padEnd(9)} ${t.name.slice(0, 28)}`,
      ),
    }
  }
  if (tab === "predict") {
    const markets = await listMarkets(ctx, { limit: 10 })
    return {
      lines: markets.map(
        (m) =>
          `${String(m.index).padStart(3)}  ${(m.title ?? "(no metadata)").slice(0, 40).padEnd(42)} ${
            m.yesPct === null ? "—" : `${m.yesPct}%`
          }`,
      ),
    }
  }
  const balances = await readBalances(ctx)
  return {
    lines: [
      ...listChains().map(
        (ch) =>
          `${ch.chainId === chain.chainId ? "▸" : " "} ${String(ch.chainId).padEnd(9)} ${ch.label.padEnd(24)} ${ch.gasSymbol}`,
      ),
      "",
      `diamond    ${chain.contracts.diamond}`,
      `$P token   ${chain.contracts.usdp}`,
      `operator   ${balances.isOperator ? "granted" : "missing"}`,
    ],
  }
}

export function App(props: { chain?: string; signer?: string }) {
  const { exit } = useApp()
  const [tab, setTab] = useState<Tab>("status")
  const [panel, setPanel] = useState<Panel>({ lines: ["loading…"] })
  const [refreshing, setRefreshing] = useState(false)

  const refresh = React.useCallback(
    async (next: Tab) => {
      setRefreshing(true)
      try {
        setPanel(await loadPanel(next, props.chain, props.signer))
      } catch (error) {
        setPanel({ lines: [], error: (error as Error).message.slice(0, 200) })
      } finally {
        setRefreshing(false)
      }
    },
    [props.chain, props.signer],
  )

  useEffect(() => {
    void refresh(tab)
  }, [tab, refresh])

  useInput((input, key) => {
    if (input === "q") exit()
    if (input === "r") void refresh(tab)
    if (key.rightArrow) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]!)
    if (key.leftArrow) {
      setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]!)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          PoPo{" "}
        </Text>
        <Text dimColor>hatch · amm · episodes · prediction</Text>
      </Box>
      <Box marginBottom={1}>
        {TABS.map((name) => (
          <Box key={name} marginRight={2}>
            <Text bold={name === tab} color={name === tab ? "cyan" : undefined}>
              {name === tab ? `[${name}]` : name}
            </Text>
          </Box>
        ))}
        {refreshing ? <Text dimColor>refreshing…</Text> : null}
      </Box>
      {panel.error ? (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">{panel.error}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {panel.lines.map((line, i) => (
            <Text key={i}>{line || " "}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>← → tab · r refresh · q quit · writes stay in the CLI for confirmation</Text>
      </Box>
    </Box>
  )
}
