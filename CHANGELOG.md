# Changelog

## 0.1.0 — 2026-10-23

First public release. Two chains, four surfaces, one core.

### Added

* **CLI** (`popo`) — 40+ commands across status, vault, hatch, AMM/LP, episodes,
  prediction, referral, Beans, faucet, admin and a raw `call` escape hatch.
  JSON when piped; exit code `3` means "simulated, confirm with --yes".
* **MCP server** (`popo-mcp`) — ~30 `popo_*` tools, `readOnlyHint` on reads,
  `confirm` on writes.
* **Agent Skill** (`SKILL.md` + `references/`) — the confirmation flow, identity
  rules and failure triage an agent needs to drive PoPo safely.
* **TUI** (`popo ui`) — read-only ink dashboard.
* **Signers** — MetaMask Agent Wallet (default), ZeroDev Kernel + scoped session
  key, local testnet key for CI, read-only mode.
* **ZeroDev probe** — verifies EntryPoint v0.7 on both chains (16,035 bytes,
  byte-identical) and bundler reachability when a project id is configured.
* **PoPoAuth** — EIP-712 writer byte-identical to pp-all's `_shared/auth.ts`,
  asserted by a unit test against `hashDigest`/`recoverTypedDataAddress`.
* **Safety** — simulation gate, `maxP` spend cap, per-call slippage guards.

### Known limits

* Prediction orders are read + quote only (see `docs/scope.md`).
* Creator video upload stays in the PoPo web app.
* ZeroDev smart accounts cannot sign PoPoAuth (ecrecover) — off-chain identity
  stays on the owner EOA (`docs/identity-model.md`).
* Chains: Arbitrum Sepolia (421614) and Robinhood Chain Testnet (46630) only.
