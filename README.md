# PoPo.meme skill — use PoPo from any AI harness

[![CI](https://github.com/PoPoMeMe/pp-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/PoPoMeMe/pp-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**PoPo.meme** is an IP-incubation and trading stack: coins fair-launch on a bonding
curve, graduate into a concentrated-liquidity AMM, and are surrounded by paid
episodes, YES/NO prediction markets, referral rewards and an on-chain vault that
settles everything in **$P**.

This repo makes the whole product usable *from inside an AI harness* — Claude Code,
Codex, Cursor, Cindy/Pi, or a plain shell — through three surfaces that share one
core:

| Surface | What it is | Use it when |
|---|---|---|
| `popo` CLI | deterministic commands, JSON when piped, exit code `3` = "confirm first" | an agent shells out and needs structured output |
| `popo-mcp` | MCP stdio server, ~30 `popo_*` tools with `readOnlyHint` annotations | the harness speaks MCP |
| `SKILL.md` | an Agent Skill that teaches the model the safe interactive flow | the harness supports skills |
| `popo ui` | small ink TUI for humans (status, tokens, markets, chain info) | a person wants to look around |

**Supported chains (phase 1):** `421614` Arbitrum Sepolia · `46630` Robinhood Chain Testnet.
Both testnets only. Mainnet PoPo deployments are intentionally out of scope.

---

## Install

Requires **Node ≥ 20.11** and, for the default signer, the MetaMask Agent Wallet CLI.

```bash
# 1) CLI you can call from a harness
npx -y github:PoPoMeMe/pp-skill --help          # or: git clone && npm i && npm run build

# 2) MetaMask Agent Wallet (default signer — no private key ever touches this repo)
npm install -g @metamask/agent-wallet
mm auth status
mm config set experimentalPlugins true          # only needed if you also use mm plugins
```

Optional, for the ZeroDev signer:

```bash
npm install @zerodev/sdk @zerodev/permissions @zerodev/ecdsa-validator
export POPO_ZERODEV_PROJECT_ID=<your-project-id>   # or: popo use 421614 && popo zerodev grant
```

## 60-second quickstart

```bash
popo doctor                     # RPC health, mm status, ZeroDev EntryPoint/bundler probe
popo status                     # chain, identities, gas, wallet $P, vault $P, next steps
popo faucet                     # claim 1,000,000 testnet $P (signed drip)
popo vault deposit 100          # wallet $P → trading vault (one-time approve + setOperator)
popo hatch list --limit 5       # what is live on the chain
popo hatch get 55               # curve reserves + graduation progress
popo hatch quote 55 --side buy --amount 10
popo hatch buy 55 --p 10        # dry-run first, then re-run with --yes
```

Every write prints the same block twice: once as a **simulation** (gas, balances
before/after, slippage guard, fees) and once, after `--yes`, as the broadcast
result with an explorer link.

## MCP setup

```jsonc
// ~/.pi/agent/mcp.json · ~/.claude/settings.json · .cursor/mcp.json · Codex config
{
  "mcpServers": {
    "popo": {
      "command": "npx",
      "args": ["-y", "github:PoPoMeMe/pp-skill", "serve-mcp"]
    }
  }
}
```

Reads (`popo_status`, `popo_hatch_list`, `popo_amm_quote`, …) are annotated
`readOnlyHint: true` so hosts may auto-approve them. Writes take
`confirm: false` by default and return the simulated plan; call again with
`confirm: true` once the human agrees.

## Agent Skill

Copy or symlink this repo into your skills directory and the model will load
`SKILL.md` when a request mentions PoPo, hatch coins, $P, episodes or prediction
markets:

```bash
ln -s "$PWD" ~/.agents/skills/popo      # Pi / Cindy / Claude
```

`SKILL.md` contains the mandatory flow: `popo status` → explain → `--dry-run` →
restate amounts → `--yes`. It never tells the model to skip the confirmation gate.

## What is covered

| Area | Commands |
|---|---|
| Environment | `doctor`, `status`, `chains`, `use`, `balance`, `stats` |
| Trading vault | `vault show/deposit/withdraw` |
| Hatch curve | `hatch list/get/quote/create/buy/sell/migrate/holders/trades` |
| AMM + LP | `amm quote/swap`, `amm lp list/add/remove` |
| Episodes | `episode list/watch/unlock` |
| Prediction | `predict list/get/quote` (orders via `popo call`, see `docs/scope.md`) |
| Referral | `invite show/bind/claim` |
| Earn Beans | `beans status/checkin/tasks` |
| Faucet | `faucet`, `faucet --status` |
| Admin | `admin roles`, `admin set-create-fee` (on-chain `canCall` gated) |
| ZeroDev | `zerodev probe/grant/session` |
| Escape hatch | `call --list`, `call --fn <name> --args '[...]'` |
| Human UI | `ui` |

## Signing model

```
                   on-chain identity            off-chain identity
mm (default)       MetaMask Agent Wallet        same EOA
zerodev            Kernel smart account          owner EOA  ← PoPoAuth is ecrecover-only
local (testnet)    ~/.popo/key                   same EOA
readonly           —                             — (reads only)
```

* `mm` asks for an email MFA on **every** write: correct for a human, painful for a
  5-step agent flow.
* `zerodev` grants a **session key** once, then the agent transacts inside a policy
  the toolkit encodes itself — only the PoPo diamond and `$P` token may be called,
  per-write and daily $P caps, hard expiry, one-command revocation.
* `local` exists for CI and the capability matrix, is refused on non-test chains,
  and must be requested explicitly.

Details: [`docs/identity-model.md`](docs/identity-model.md), [`docs/zerodev.md`](docs/zerodev.md).

## Safety rails

* Writes are simulated with `eth_call` first; a revert aborts before any wallet popup.
* Without `--yes` the process exits **3** and prints the plan — agents must ask.
* `~/.popo/config.json` carries a hard `maxP` cap (default 50 $P per write).
* No service-role keys anywhere; the Supabase key in `src/core/backend.ts` is the
  public publishable key that already ships in the web bundle.
* Paid-video URLs are capability links fetched only after an on-chain entitlement
  check, and are never written to logs.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test          # vitest: EIP-712 parity, units, chain registry, tick math
npm run check:drift   # chain registry + ABIs still match pp-all
npm run build         # dist/cli.js · dist/mcp.js · dist/ui.js
npm run smoke
```

Chain addresses and ABIs are copied from `pp-all` (the single source of truth).
`npm run check:drift` fails CI if they diverge; `npm run sync:abis` refreshes them.

## License

MIT — see [LICENSE](LICENSE).
