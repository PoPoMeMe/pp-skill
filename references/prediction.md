# Prediction markets reference

Markets are keyed by `bytes32 digest` = `sha256(canonical metadata JSON)`; the
on-chain contract stores only the digest plus curve state, so titles come from
Supabase `prediction_market_applications.meta`.

## Lifecycle

```
applyMarket (pays fee + reward pool from the creator vault, market lands disabled)
  → admin review (enableMarket / disableMarket)
  → users buy YES / NO  (shares are ERC-6909 ids: yesNftId / noNftId)
  → endMarket(digest, resultNftId)      ← admin, sets the winning side
  → claimReward(digest)                 ← winners
  → claimFailedToken(digest)            ← special recovery cases
```

## Reads shipped in v0.1

* `popo predict list [--limit N] [--start N]` — digest, title, status, YES share
  of supply, pot, `yesNftId` / `noNftId`.
* `popo predict get <digest>` — one market in full.
* `popo predict quote <digest> --outcome yes --amount 100 [--side buy|sell]` —
  `quoteBuy` / `quoteSell` give exact cost, fee and post-trade supply.

`getMarket(digest, 0n)` is the app's pricing call (`targetSupply = 0`).

## Orders (deliberately not wrapped yet)

PoPo's prediction entrypoints take an **NFT id**, not an amount
(`buy(bytes32 digest, uint256 nftId)`), and the amount is resolved on the share
curve. Guessing that encoding would be worse than not shipping it, so v0.1 reads
and quotes, and points at the escape hatch:

```bash
popo call --list
popo call --fn buy --args '["0x<digest>", 56]'
```

See `docs/scope.md` for the condition to promote this to first-class commands.
