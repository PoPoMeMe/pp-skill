# MetaMask Agent Wallet integration

`mm` is the default signer: this repo never sees a private key.

## What we use

| command | purpose |
|---|---|
`mm wallet address --json` | resolve the acting address |
`mm wallet send-transaction --chain-id … --payload '<json>' --wait --intent "…"` | every on-chain write (raw calldata built here) |
`mm wallet sign-typed-data --chain-id … --payload '<EIP-712 json>' --wait` | PoPoAuth off-chain writes |
`mm wallet requests list/watch --json` | resolve a request that is waiting for MFA |

We always compute EIP-1559 `maxFeePerGas` / `maxPriorityFeePerGas` and an explicit
gas limit from the public RPC before calling `send-transaction`. The remote signer
rejects requests without fee fields on chains its gas service does not know, which
is the failure mode we hit on smaller testnets.

## Chains

`421614` (Arbitrum Sepolia) is in the mm registry, so it works out of the box
(native balance was readable in our probe). `46630` (Robinhood Chain Testnet) is
not, and needs one `customEvmChains` entry in `~/.metamask/wallets.json`:

```jsonc
{
  "key": "robinhood-testnet",
  "chainId": 46630,
  "caip2": "eip155:46630",
  "name": "Robinhood Chain Testnet",
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
  "blockExplorer": "https://explorer.testnet.chain.robinhood.com",
  "rpcTarget": "https://rpc.testnet.chain.robinhood.com"
}
```

Verify with `mm wallet balance --chain 46630 --json`, then `popo doctor`.

## MFA behaviour

Server-wallet mode pauses each write as `AWAITING_MFA`; the request expires after
10 minutes. The CLI passes `--wait --wallet-timeout 600`, so a slow approval still
succeeds, and any request that returns without a hash is surfaced as
`signer_unavailable` with the `pollingId` so a human can finish it with
`mm wallet requests watch <id>`.

If you want multi-step flows without prompts, grant a ZeroDev session instead
(`docs/zerodev.md`) — that is the whole reason both signers exist.
