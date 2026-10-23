# Hatch + AMM reference

## Curve lifecycle

```
createToken (10 $P fee from the vault)
  → buy/sell on the curve (platform fee 1% + creator fee 0.5% of the input)
  → realQuoteReserves ≥ graduationThreshold (14,000 $P)
  → complete = true, curve closed
  → migrate(tokenId)   permissionless: seeds the $P/token pool
  → status = graduated → AMM swap + LP
```

States: `0 active` · `1 graduated` · `2 disabled`. `complete` flips at the
threshold while `status` stays `0` until `migrate` succeeds — a coin can be
"complete but not tradeable", which the UI shows as "Migrate".

## Pricing

`previewBuy(tokenId, quoteAmount)` and `previewSell(tokenId, tokenAmount)` are the
only trustworthy quotes; fees come out of the input. `popo hatch quote` prints
`tokensOut`, `platformFeeP`, `creatorFeeP` and the effective price.

## AMM (after graduation)

| parameter | value |
|---|---|
| currency0 | internal $P (`quoteId = 1`) |
| currency1 | the hatch token |
| fee | 25 (0.25%) |
| tick spacing | 60 |
| full range | -887220 … 887220 |

* Exact-in: pass a positive `amountSpecified`, guard with `minAmountOut`.
* Exact-out: pass a **negative** `amountSpecified`, guard with `maxAmountIn`
  (reverts `RouterFacet_TooMuchIn` when exceeded).
* Quotes are produced by intentionally reverting with `RouterFacet_Quote`
  (`quoteSwap` / `quoteSwapExactOutput`); the CLI decodes the two words.

## LP

Positions are owned by the diamond but isolated per user by
`salt = keccak256(user, tickLower, tickUpper)`; `popo amm lp list` reads the index
first and falls back to scanning `LiquidityModified` logs in adaptive chunks.
Removing liquidity settles accrued fees in the same transaction.

## Reverts you will actually see

| revert | meaning |
|---|---|
`PPHatchSwap_CurveClosed` | the curve is complete — use the AMM after `migrate`
`RouterFacet_PoolNotInitialized` | not migrated yet
`RouterFacet_TooMuchIn` / `TooLittleOut` | slippage guard tripped — retry with a wider guard or a smaller size
`Vault_InsufficientBalance` | deposit $P into the vault first
`PPHatchSwap_NotCreator` | only the creator can manage episodes
