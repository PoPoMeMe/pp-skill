# Security notes

## What this repo holds

| secret | where | risk |
|---|---|---|
Supabase publishable key | `src/core/backend.ts` | none — it already ships in the public web bundle and is RLS-protected
local testnet key | `~/.popo/key` (0600), never in git | testnet only, refused on non-test chains
ZeroDev session key | `~/.popo/session.json` (0600) | bounded by policy; revocable
ZeroDev owner key | `~/.popo/owner.key` or `POPO_OWNER_KEY` | only used for the one-time grant

No service-role key, no API secret, no mainnet key is ever required.

## Rails, in order of defence

1. **Simulation** — every write is `eth_call`ed first; a revert stops the flow
   before a wallet popup appears.
2. **Confirmation gate** — without `--yes` the process exits 3 and prints the plan;
   the MCP layer mirrors this with `confirm: false`.
3. **Spend cap** — `config.maxP` (default 50 $P) is checked against the plan's
   declared spend, independent of `--yes`.
4. **Signer policy** — mm enforces its own policy + MFA; a ZeroDev session is
   limited to two contracts, two spend caps and an expiry.
5. **No address hard-coding** — one registry, drift-checked against `pp-all` in CI.

## Things the model must never do

* Pass `--yes` on a command whose dry-run the user has not seen.
* Raise `maxP`, extend a session, or edit `session.json` to bypass a refusal.
* Paste episode capability URLs, private keys or signatures into public output.
* Use `popo call` to work around a `policy_blocked` error.

## Reporting

`popo doctor` output is designed to be shareable (no secrets, no keys). Include its
JSON plus the failing command's `{code, message}` when reporting a bug.
