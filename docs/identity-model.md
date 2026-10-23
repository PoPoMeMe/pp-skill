# Identity model — two addresses, on purpose

PoPo's off-chain writes are authorised by an EIP-712 `PoPoAuth` signature that the
edge functions verify with **plain `ecrecover`** (`_shared/auth.ts`). A smart
account cannot satisfy that: its signature is validated by ERC-1271, not by
recovering a key.

So the toolkit splits identity:

```
on-chain  (money)                      off-chain (social)
vault $P, tokens, LP, episodes,        Beans, referral code/bind, faucet
prediction shares, creator fees        request, episode watch URL
        │                                       │
signer.onchainAddress                  signer.offchainAddress
```

| signer | on-chain | off-chain | per-write approval |
|---|---|---|---|
| `mm` | MetaMask Agent Wallet EOA | same | email MFA |
| `zerodev` | Kernel smart account | owner EOA | none (policy-bounded) |
| `local` (testnet) | `~/.popo/key` | same | none |
| `readonly` | `--address` or zero | `config.offchainAddress` | n/a |

## Consequences you must tell the user about

* With a ZeroDev session, the address that holds coins is **not** the address that
  owns Beans or the referral code. `popo status` prints both, and every command
  that needs the other identity says so (`unsupported` with a hint, not a silent
  fallback).
* A paid episode bought by the smart account is watchable only through the smart
  account's entitlement; the watch URL is requested with the owner EOA signature
  but the edge function checks *that* address's entitlement. Until the server
  supports ERC-1271 (see roadmap), buy and watch with the same signer.
* Funding: send testnet $P and gas to the **on-chain** address (the smart account),
  not the owner EOA.

## Roadmap for unification

Adding ERC-1271 support to `verifySignature` (try `ecrecover`, then
`isValidSignature` on the claimed address) would let one smart account hold both
identities. It is a change inside `pp-all`'s production edge functions, so it is
tracked separately and deliberately not part of this repo's phase 1.
