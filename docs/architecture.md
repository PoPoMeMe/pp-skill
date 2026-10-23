# Architecture

```
src/
├── core/                     no I/O assumptions beyond fetch + child_process
│   ├── base.ts               $P 18-decimal math, PopoError (code + hint + exit code)
│   ├── chains.ts             the ONLY registry: 421614, 46630
│   ├── abi.ts                merged Diamond ABI (210 fns) + ERC20/ERC6909 extras
│   ├── config.ts             ~/.popo/config.json (0600), key file
│   ├── rpc.ts                viem clients w/ fallback transport, adaptive getLogs
│   ├── auth.ts               PoPoAuth EIP-712 digest, byte-identical to the edge
│   ├── backend.ts            Supabase publishable key + edge/table helpers
│   ├── tx.ts                 WritePlan → simulate → confirm → send
│   └── signer/               mm · zerodev · local · readonly behind one interface
├── modules/                  product surface, plain functions returning JSON
│   ├── chain.ts              status, balances, vault, faucet, admin, raw call
│   ├── hatch.ts              curve + graduation + AMM + LP
│   ├── market.ts             episodes + prediction
│   └── social.ts             referral, beans, profile, billing, stats
├── cli/                      commander + render (JSON in pipes, tables in a TTY)
├── mcp/                      MCP stdio server (~30 tools, same modules)
└── tui/                      ink dashboard (read-only by design)
```

## The one rule every layer obeys

**Encoders never sign.** `modules/*` only produce a `WritePlan` (calldata +
human summary + $P amount). `core/tx.ts` simulates it, enforces the $P cap, and
only then hands the calls to a `Signer`. That is why the CLI, the MCP server and
any future surface cannot disagree about what a command does.

## Output contract

| context | stdout | exit code |
|---|---|---|
| pipe / `--json` | `{ ok, … }` JSON | 0 ok · 1 error · 2 usage · 3 confirmation required · 4 not ready |
| TTY | title + key/value or table | same |

Errors are `{ ok:false, code, message, hint? }` with `code` from a closed set
(`confirmation_required`, `insufficient_balance`, `contract_revert`,
`policy_blocked`, `unsupported_chain`, `signer_unavailable`, `backend_error`,
`not_found`, `unsupported`, `usage`, `rpc_error`, `internal`). Agents branch on
`code`, not on prose.

## Data sources

| data | source of truth |
|---|---|
balances, curve state, pools, positions, entitlements, fees | chain (RPC)
titles, images, trade history, holders, profiles, market metadata | Supabase (public SELECT)
drips, signed writes | Edge Functions with PoPoAuth verification

Supabase is a **cache/index only**: every command that acts on money re-reads the
chain immediately before building a plan.

## Why the modules are grouped by domain, not one file per command

A command is 10 lines of glue over a module function, and the dangerous part is
always the same three things: quote → guard → confirm. Keeping them adjacent makes
it obvious when a new command forgets one.
