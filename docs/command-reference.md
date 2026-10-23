# Command reference

Global flags: `--chain <id|key>` · `--json` · `--signer auto|mm|zerodev|local|readonly`
· `--address <addr>` (read-only) · `--yes` · `--dry-run` · `--slippage-bps <n>` (default 100)

## Environment

```bash
popo doctor [--install-chains]     # RPC health, ZeroDev EntryPoint/bundler, mm, session
popo status                        # chain, identities, gas, wallet/vault $P, created tokens, next
popo chains                        # the two supported chains
popo use 46630                     # set default chain
popo balance [--token usdp]        # native / wallet $P / vault $P / operator
popo stats                         # totalTokens, totalMarkets
```

## Vault

```bash
popo vault show
popo vault deposit <amountP>       # approve (once) + deposit + setOperator (once)
popo vault withdraw <amountP>
```

## Hatch (bonding curve)

```bash
popo hatch list [--limit 20] [--q text] [--status all|active|graduated] [--sort newest|oldest]
popo hatch get <tokenId>
popo hatch quote <tokenId> --side buy --amount 10
popo hatch quote <tokenId> --side sell --amount 1000
popo hatch create --name "Name" --symbol "SYM" [--uri https://…]
popo hatch buy <tokenId> --p 10
popo hatch sell <tokenId> --tokens 1000
popo hatch migrate <tokenId>       # permissionless
popo hatch holders <tokenId> [--limit 20]
popo hatch trades <tokenId> [--limit 20]
```

## AMM + LP (post-graduation)

```bash
popo amm quote <tokenId> --side buy|sell --amount 10 [--exact in|out]
popo amm swap  <tokenId> --side buy|sell --amount 10 [--exact in|out]
popo amm lp list <tokenId>
popo amm lp add <tokenId> --p 10 --tokens 100 [--tick-lower -887220 --tick-upper 887220]
popo amm lp remove <tokenId> --tick-lower -100 --tick-upper 100 --liquidity 1234
```

## Episodes

```bash
popo episode list <tokenId>
popo episode watch <tokenId> <no>     # 0 = trailer
popo episode unlock <tokenId> <no>    # permanent, paid from the vault
```

## Prediction

```bash
popo predict list [--limit 20] [--start 0]
popo predict get <digest>
popo predict quote <digest> --outcome yes|no --amount 100 [--side buy|sell]
```

## Referral · Beans · Profile · Billing

```bash
popo invite show
popo invite bind <referrer>
popo invite claim
popo beans status | checkin | tasks
popo profile show [address]
popo billing [--limit 20]
```

## Faucet

```bash
popo faucet              # 1,000,000 testnet $P (signed drip)
popo faucet --status     # cooldown
```

## Admin (on-chain `canCall` gated)

```bash
popo admin roles
popo admin set-create-fee 10
```

## ZeroDev

```bash
popo zerodev probe
popo zerodev grant [--owner-key 0x…] [--project-id id] [--max-p 50] [--daily-p 200] [--days 7]
popo zerodev session [status|revoke]
```

## Escape hatch

```bash
popo call --list
popo call --fn previewBuy --args '[55, "1000000000000000000"]'
popo call --fn buy --args '[55, "1000000000000000000", "0"]'   # reads only (eth_call)
popo call --to 0x… --fn balanceOf --args '["0x…"]'
```

## Human TUI

```bash
popo ui        # ← → tabs · r refresh · q quit (read-only)
```
