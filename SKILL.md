---
name: popo
description: Use PoPo.meme from the terminal — browse and trade launchpad coins on the bonding curve, graduate them into the AMM, add liquidity, unlock paid episodes, read prediction markets, claim testnet $P, earn Beans, check referral rewards. Load this when a user mentions PoPo, popo.meme, hatch coins, $P, curve trades, graduation/migration, LP positions, episodes/series, prediction markets on PoPo, or the Arbitrum Sepolia / Robinhood Chain testnets in a PoPo context.
license: MIT
compatibility: Requires Node >= 20.11 and the `popo` CLI (npx -y github:PoPoMeMe/pp-skill). Writes need a signer (MetaMask Agent Wallet, or a granted ZeroDev session).
metadata:
  homepage: https://github.com/PoPoMeMe/pp-skill
  chains: "421614 arbitrum-sepolia, 46630 robinhood-testnet"
---

# PoPo.meme

PoPo is an IP-incubation trading stack on two testnets. One wallet can:

- launch a coin on a **bonding curve** (10 $P creation fee, paid from the vault)
- buy/sell on the curve until it **graduates** (14,000 $P of net buys)
- **migrate** it permissionlessly into a concentrated-liquidity AMM
- swap exact-in or exact-out, add/remove concentrated liquidity, claim fees
- publish and unlock **paid episodes** (the IP layer)
- read **YES/NO prediction markets** and quote exact prices
- earn **Beans** and referral rewards

Everything settles in the internal ERC-6909 **$P** vault. `$P` in the *wallet* is
not spendable — it must be deposited into the *trading vault* first. That single
distinction causes most user confusion; check it early.

## Supported chains

| chainId | key | label |
|---|---|---|
| `421614` (default) | `arbitrumSepolia` | Arbitrum Sepolia |
| `46630` | `robinhoodTestnet` | Robinhood Chain Testnet |

Anything else is refused with `unsupported_chain`. Never invent addresses — the
CLI holds the registry.

## Rule 0 — the confirmation gate (non-negotiable)

Every write follows the same five steps. Do not compress them.

1. **Orient.** Run `popo status --json`. It returns the chain, both identities,
   gas, wallet $P, vault $P and a `next` array of concrete suggestions.
2. **Explain** what the user is about to do, in their language, with real numbers.
3. **Simulate.** Run the write **without** `--yes`. The CLI eth_calls every step,
   prints gas/balance deltas and exits with code **3** (`confirmation_required`).
   If it exits with `contract_revert`, nothing was sent — fix the input instead of
   retrying blindly.
4. **Ask.** Show the simulated numbers and wait for an explicit yes.
5. **Send.** Re-run with `--yes`. Report the tx hash + explorer link.

Never batch several writes behind one "yes". Never set `--yes` on a command the
user has not seen the dry-run of.

## Rule 1 — identity is two addresses

```
on-chain  (vault, tokens, LP, episodes)  → signer.onchainAddress
off-chain (beans, invite, faucet, watch) → signer.offchainAddress (always an EOA)
```

With `mm` they are the same address. With a ZeroDev session the smart account
holds the money and the owner EOA holds the social identity — say this plainly
whenever a user asks "why is my Beans balance different from this address".

## Rule 2 — money lives in the vault

| symptom | fix |
|---|---|
| "not enough $P" while the wallet shows $P | `popo vault deposit <amt>` (wallet → vault) |
| `insufficient_balance` on create/buy/unlock | same: vault is short |
| no gas at all | `popo faucet` mints $P but **not** native gas — use the chain's gas faucet link printed by `popo status` |
| approval loop | the first `vault deposit` also sets the ERC-6909 operator, so it normally happens once |

## Command map

Run `popo <area> --help` for flags. JSON is on by default when piped.

| Intent | Command |
|---|---|
| what's going on | `popo status` · `popo balance` · `popo stats` |
| fix my environment | `popo doctor` |
| get testnet $P | `popo faucet` · `popo faucet --status` |
| move $P | `popo vault deposit 50` · `popo vault withdraw 50` |
| discover coins | `popo hatch list --limit 20 [--q text] [--status active]` |
| inspect a coin | `popo hatch get <id>` · `popo hatch holders <id>` · `popo hatch trades <id>` |
| price a curve trade | `popo hatch quote <id> --side buy --amount 10` |
| trade the curve | `popo hatch buy <id> --p 10` · `popo hatch sell <id> --tokens 1000` |
| launch | `popo hatch create --name "X" --symbol "X" --uri https://…` |
| graduate | `popo hatch migrate <id>` (permissionless, anyone) |
| AMM price | `popo amm quote <id> --side buy --amount 10 [--exact out]` |
| AMM trade | `popo amm swap <id> --side buy --amount 10 [--exact in\|out]` |
| LP | `popo amm lp list <id>` · `add <id> --p 10 --tokens 100` · `remove <id> --tick-lower … --tick-upper … --liquidity …` |
| series | `popo episode list <id>` · `watch <id> <no>` · `unlock <id> <no>` |
| prediction | `popo predict list` · `get <digest>` · `quote <digest> --outcome yes --amount 100` |
| referral | `popo invite show` · `bind <addr>` · `claim` |
| Beans | `popo beans status` · `checkin` · `tasks` |
| admin | `popo admin roles` · `admin set-create-fee <p>` |
| anything else | `popo call --list` then `popo call --fn <name> --args '[…]'` |

## Failure triage (in this order)

1. `popo doctor` — RPC down? mm logged out? ZeroDev bundler unreachable?
2. `popo status` — right chain? gas? vault funded? operator granted?
3. Re-read the error `code`:
   - `confirmation_required` → expected; add `--yes` after the user agrees
   - `insufficient_balance` → deposit or faucet
   - `contract_revert` → the simulation explained why (curve closed, pool not
     initialised, slippage too tight, not the creator)
   - `policy_blocked` → the $P cap or the ZeroDev policy refused; do not try to
     work around it, ask the human to raise it deliberately (`popo config`, or a
     new session grant)
   - `unsupported_chain` → only 421614 and 46630 exist in this release
   - `signer_unavailable` → run `popo doctor`; mm may need `mm auth status`
4. Only then touch `popo call` — it bypasses the helpers, not the safety rails.

## Interactive patterns that work well

**"Launch a coin"** → ask for name/symbol/art URL → `popo hatch create …` dry-run →
show the 10 $P fee and the vault balance → confirm → then ask whether to seed a
first buy (`popo hatch buy`) so the coin is not empty in listings.

**"Is this coin worth watching?"** → `popo hatch get` for curve progress and
`popo hatch trades` for recent flow; a coin above ~80% of the graduation threshold
is a different conversation than one at 2%.

**"What can I do with 20 $P?"** → `popo status` + `popo hatch list` and quote two
candidates; present the effective price and the fee split, not just the token count.

**"Buy me 5 $P of #55"** → quote → dry-run → restate "≈X tokens, min Y after 1%
slippage, N $P fees" → confirm → send → link.

**"Show me episode 2"** → `popo episode list` → if locked, quote the price and
explain the unlock is permanent; `watch` only after the purchase.
