# Phase-1 scope (frozen)

Status legend: **full** = first-class command, **read** = inspect/quote only,
**hatch** = usable through `popo call`, **no** = out of scope.

| # | Module | Scope | Notes |
|---|---|---|---|
| 1 | Environment (`doctor/status/chains/use/balance/stats`) | full | `status` is the single orient call |
| 2 | Trading vault (`vault show/deposit/withdraw`) | full | approve + setOperator folded into deposit |
| 3 | Hatch curve (`list/get/quote/create/buy/sell/migrate`) | full | slippage guard on every trade |
| 4 | Holders / trades | read | Supabase index, chain is source of truth |
| 5 | AMM (`amm quote/swap` exact-in + exact-out) | full | quote decoded from `RouterFacet_Quote` revert |
| 6 | LP (`lp list/add/remove`) | full | ranges from index, log-scan fallback; claim is part of remove |
| 7 | Episodes (`list/watch/unlock`) | full | publish stays in the web app (roadmap) |
| 8 | Prediction (`list/get/quote`) | read | orders via `popo call` until the NFT-amount semantics are verified |
| 9 | Referral (`invite show/bind/claim`) | full | bind must precede the first fee-paying trade |
| 10 | Earn Beans (`status/checkin/tasks`) | full | PoPoAuth write, off-chain identity only |
| 11 | Admin (`roles`, `set-create-fee`) | full | gated by on-chain `canCall`, not a frontend list |
| 12 | ZeroDev session (`probe/grant/session`) | full | on-chain identity only (see identity-model) |

## Explicitly out of scope

* Mainnet. The only mainnet PoPo deployment (Sei 1329) has no Diamond and no hatch
  contracts, so every write path would be dead. `unsupported_chain` is the answer.
* Other testnets (Monad, Arc, Base, ETH-Sepolia, HyperEVM, Tempo). The registry is
  a two-entry list on purpose: each chain needs its own RPC, gas model and 4337
  check, and a half-verified chain is worse than a missing one.
* Video upload for creators (`hatch-episode-upload-url` + register). The upload
  path needs a creator-signed multipart flow; phase 2.
* Prediction order submission (see row 8).
* TUI writes. `popo ui` is deliberately read-only so that the CLI's confirmation
  contract (exit 3) can never be bypassed by a screen.

## What must be verified on a real chain before release

1. `vault deposit` on both chains (approve + deposit + setOperator).
2. `hatch create` → `buy` → `sell` on both chains.
3. `migrate` on a completed curve, then `amm quote` + `swap`.
4. `episode unlock` + `watch` (entitlement round-trip).
5. ZeroDev: one userOp per chain, plus a **negative** test where a disallowed
   target must be refused by the policy.
