# Troubleshooting

| symptom | cause | fix |
|---|---|---|
`Error: cannot find module 'mm'` / `signer_unavailable` | MetaMask Agent Wallet missing | `npm i -g @metamask/agent-wallet && mm auth status` |
`mm did not broadcast` with a `pollingId` | request is waiting for email MFA | approve it, or `mm wallet requests watch <id> --json` |
`confirmation_required` (exit 3) | by design: dry-run | confirm with the user, then add `--yes` |
`insufficient_balance` | vault $P too low | `popo vault deposit <amt>` or `popo faucet` |
`no ETH for gas` | faucet mints $P only | use the gas faucet link in `popo status` |
`contract_revert: CurveClosed` | curve already complete | `popo hatch migrate <id>` then trade on the AMM |
`contract_revert: PoolNotInitialized` | not migrated | migrate first |
`contract_revert: TooMuchIn/TooLittleOut` | slippage guard | raise `--slippage-bps` or reduce size |
`policy_blocked` | $P cap / ZeroDev session policy | raise `maxP` deliberately, or re-grant a session |
`unsupported_chain` | not 421614 / 46630 | `popo chains`, then `popo use <chain>` |
`backend_error 401` | signature expired (>10 min) or wrong realm | retry; the CLI re-signs per call |
`not_found: market` | digest not in the local index | `popo predict list` for valid digests |
`rpc_error eth_getLogs` | range cap on the node | pass a closer `--from-block` (LP scans) |
