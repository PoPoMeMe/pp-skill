# Changelog

## 0.1.1 — 2026-10-23

First real on-chain transaction, plus the runner that covers the rest.

### Fixed

* **mm typed data rejected without `domain.chainId`** — MetaMask Agent Wallet
  answers `SIGNATURE_REQUEST_INVALID_PAYLOAD: "eth_signTypedData_v4 requires
  typedData.domain.chainId to match chainId"`. The faucet path now signs the
  chain-scoped PoPoAuth variant and forwards `domainChainId`, which the faucet
  Edge Function already validates.
* **`signTypedData` result parsing** — mm returns a flat
  `{ mode, address, status, signature }`; the parser only looked at nested shapes
  and discarded a good signature.
* **BigInt in EIP-712 messages** — `JSON.stringify` had no replacer, so any
  uint256 field (the auth timestamp) crashed the write path.

### Added

* `npm run e2e` (`scripts/e2e.mjs`) — drives the installed CLI through
  status → faucet → vault deposit → hatch create → buy → sell → curve state →
  AMM quote → predict list/quote → episode list/unlock/watch → Beans check-in.
  Gas precheck first, dry-run gate per step, JSON report at the end, `--yes` to
  broadcast.
* `docs/scope.md` §5 is the acceptance list this runner implements.

### Verified on Arbitrum Sepolia (421614)

| step | result |
|---|---|
| `popo status` | signer `mm`, address `0xb81f…c88d` |
| `popo faucet` (PoPoAuth, real edge function) | 1,000,000 testnet $P minted, tx `0xfaf3244b…b0c4` |
| `popo vault deposit` onwards | blocked — the signer address has no native gas yet |

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
