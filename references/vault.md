# Vault reference

## Two balances, one token

| balance | where | spendable |
|---|---|---|
| wallet $P | ERC-20 `USDPApp` on the signer address | no — deposit first |
| vault $P | ERC-6909 id `1` inside the diamond, per address | yes |

```bash
popo vault show
popo vault deposit 100     # approve (once) → deposit → setOperator (once)
popo vault withdraw 100    # vault → wallet
```

## Why one deposit does three things

`vault deposit` also grants the diamond ERC-6909 operator rights, because every
trade pulls $P from the vault. `popo status` reports `isOperator`; if it is
`false`, run a deposit (even 0.0001 $P) to grant it.

## Accounting notes

* Trading fees, episode purchases and market applications are all charged from
  the vault, never from the wallet.
* Proceeds (sells, LP principal and fees, creator fees, referral claims) land back
  in the vault, so `withdraw` is the only step that moves value to the wallet.
* Nothing in this CLI can move another address's vault balance — every write is
  signed by the acting address.
