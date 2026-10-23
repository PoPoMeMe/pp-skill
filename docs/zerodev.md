# ZeroDev integration

## Why

`mm` requires an email MFA per write. A realistic PoPo session is five writes
(create → buy → publish → add liquidity → predict), which is five emails. ZeroDev
replaces that with **one approval** and a policy that keeps the agent useful but
bounded — the "AI is the operator" story PoPo sells, made literal.

## What we verified

`popo zerodev probe` (pure RPC, no SDK, no project id needed):

| chain | EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | code size |
|---|---|---|
| 421614 Arbitrum Sepolia | deployed | 16,035 bytes |
| 46630 Robinhood Testnet | deployed | 16,035 bytes |

Both chains carry byte-identical EntryPoint code, so the 4337 stack is the same on
both. The remaining variable is the **bundler endpoint**, which needs a ZeroDev
project id:

```bash
popo config set zerodev.projectId <id>      # or export POPO_ZERODEV_PROJECT_ID
popo zerodev probe                          # bundler reachable? supported entry points?
```

## Grant a session

```bash
# owner key is only used for the one-time enable signature
popo zerodev grant --owner-key 0x… --max-p 50 --daily-p 200 --days 7
popo zerodev session status
```

The stored bundle (`~/.popo/session.json`, mode 0600) contains:

```jsonc
{
  "smartAccount": "0x…",     // on-chain identity
  "owner": "0x…",            // off-chain identity (EOA)
  "sessionKey": "0x…",       // hot key, bounded by policy
  "policy": {
    "allow": ["0xPoPoDiamond…", "0xUSDPApp…"],
    "maxP": "50",
    "dailyP": "200",
    "expiresAt": 1770000000000
  }
}
```

The policy is enforced **twice**: the ZeroDev permission validator enforces it
on-chain (call targets, timestamp, rate limit), and `enforceLocalPolicy` in
`src/core/signer/zerodev.ts` refuses to even build a userOp that violates the
allow-list or the per-write cap. The second check exists so failures are instant
and readable instead of a bundler `AA`-error.

## Safety properties

* The session key can only call the two PoPo contracts — it cannot drain an
  arbitrary token or interact with a random protocol.
* `maxP` caps a single write, `dailyP` caps a day, `expiresAt` caps the lifetime.
* `popo zerodev session revoke` clears it locally; revoking on-chain is the same
  permission-validator update PoPo would ship to users.
* The owner key is used **only** for the enable signature and is never needed for
  a transaction afterwards.

## Known limits (phase 1)

* Off-chain writes (Beans, invite, faucet, watch) cannot be signed by the smart
  account — see `docs/identity-model.md`.
* Gas is self-funded: the smart account needs native gas. A ZeroDev gas policy /
  paymaster is the phase-2 upgrade; the bundler endpoint already accepts one.
* The grant path needs a bundler endpoint to build the account; `probe` and policy
  enforcement work without it.
