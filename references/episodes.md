# Episodes (paid IP) reference

Numbering differs from the chain:

| page | on-chain index |
|---|---|
| 0 (trailer) | none — always free |
| 1 | 0 |
| N | N-1 |

## Flow

```bash
popo episode list <tokenId>            # price per episode, whether media exists
popo episode unlock <tokenId> 2        # purchaseEpisode(tokenId, 1) — permanent
popo episode watch <tokenId> 2         # signed check → playable capability URL
```

`watch` signs a PoPoAuth request (`action: "hatch-episode-watch"`,
`payload: {chainId, tokenId, episodeNo}`) and the Edge Function re-verifies the
on-chain entitlement before handing out a URL. A 401/403 there means the wallet
does not own that episode yet; a missing row means the creator never uploaded it.

Creators publish through the PoPo web app today (video upload + metadata). The CLI
reads and purchases; publishing is on the roadmap in `docs/scope.md`.

Never log or paste the returned URL into public channels — it is a capability link.
