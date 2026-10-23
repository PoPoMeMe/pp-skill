/**
 * Chain-level surface: context, status, balances, the $P vault, the faucet,
 * the raw escape hatch and admin (canCall-gated) operations.
 */

import {
  ERC20_ABI,
  ERC6909_ABI,
  POPO_ABI,
  USDP_ABI,
  abiFunctionNames,
} from "../core/abi"
import {
  PopoError,
  formatP,
  formatUnits,
  isoNow,
  parseP,
  shortAddr,
  type Address,
  type Hex,
} from "../core/base"
import { edge, select } from "../core/backend"
import { explorerAddress, explorerTx, type ChainConfig } from "../core/chains"
import { readConfig } from "../core/config"
import { authTypedData, type AuthInput } from "../core/auth"
import { publicClientFor } from "../core/rpc"
import type { Signer } from "../core/signer/types"
import { encodeCall, type WritePlan } from "../core/tx"
import { readSession, sessionStatus } from "../core/signer/zerodev"

export interface Ctx {
  chain: ChainConfig
  signer: Signer
  client: ReturnType<typeof publicClientFor>
}

export async function makeCtx(chain: ChainConfig, signer: Signer): Promise<Ctx> {
  return { chain, signer, client: publicClientFor(chain) }
}

export interface Balances {
  address: Address
  native: { raw: string; formatted: string; symbol: string }
  walletP: { raw: string; formatted: string }
  vaultP: { raw: string; formatted: string }
  pAllowance: string
  isOperator: boolean
}

export async function readBalances(ctx: Ctx): Promise<Balances> {
  const { chain, client, signer } = ctx
  const owner = signer.onchainAddress
  const diamond = chain.contracts.diamond
  const usdp = chain.contracts.usdp

  const [native, walletP, vaultP, allowance, isOperator] = await Promise.all([
    client.getBalance({ address: owner }).catch(() => 0n),
    client
      .readContract({
        address: usdp,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      })
      .catch(() => 0n),
    client
      .readContract({
        address: diamond,
        abi: ERC6909_ABI,
        functionName: "balanceOf",
        args: [chain.quoteId, owner],
      })
      .catch(() => 0n),
    client
      .readContract({
        address: usdp,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, diamond],
      })
      .catch(() => 0n),
    client
      .readContract({
        address: diamond,
        abi: ERC6909_ABI,
        functionName: "isOperator",
        args: [owner, diamond],
      })
      .catch(() => false),
  ])

  return {
    address: owner,
    native: {
      raw: native.toString(),
      formatted: formatUnits(native, 18, 6),
      symbol: chain.gasSymbol,
    },
    walletP: { raw: walletP.toString(), formatted: formatP(walletP) },
    vaultP: { raw: vaultP.toString(), formatted: formatP(vaultP) },
    pAllowance: allowance.toString(),
    isOperator: Boolean(isOperator),
  }
}

export async function status(ctx: Ctx) {
  const balances = await readBalances(ctx)
  const { chain, signer } = ctx
  const offchain = signer.offchainAddress
  const [identity, admin, beans, tokens] = await Promise.all([
    Promise.resolve(identitySnapshot(signer, chain)),
    hasAnyRole(ctx).catch(() => ({ canCallAdmin: false, checked: false })),
    readBeans(offchain).catch(() => null),
    readMyTokens(chain, balances.address).catch(() => []),
  ])

  const hints: string[] = []
  if (BigInt(balances.native.raw) === 0n) {
    hints.push(
      `no ${chain.gasSymbol} for gas — ${chain.gasFaucetUrl ?? "use a faucet"} then retry`,
    )
  }
  if (BigInt(balances.walletP.raw) === 0n && BigInt(balances.vaultP.raw) === 0n) {
    hints.push(`no $P yet — run \`popo faucet\` (${chain.faucetUrl})`)
  }
  if (BigInt(balances.vaultP.raw) === 0n && BigInt(balances.walletP.raw) > 0n) {
    hints.push("$P is in the wallet but not the trading vault — run `popo vault deposit <amt>`")
  }
  if (!balances.isOperator) {
    hints.push("the diamond is not yet an operator of your $P — `popo vault deposit` fixes it")
  }

  return {
    ok: true,
    chain: {
      chainId: chain.chainId,
      key: chain.key,
      label: chain.label,
      gasSymbol: chain.gasSymbol,
      explorer: chain.explorerUrl,
      diamond: chain.contracts.diamond,
      usdp: chain.contracts.usdp,
    },
    identity,
    balances,
    admin,
    beans,
    tokens,
    next: hints,
    asOf: isoNow(),
  }
}

function identitySnapshot(signer: Signer, chain: ChainConfig) {
  const session = readSession()
  return {
    signer: signer.kind,
    requiresApproval: signer.requiresApproval,
    onchain: {
      address: signer.onchainAddress,
      role: "on-chain identity — vault, tokens, LP, episodes",
      explorer: explorerAddress(chain, signer.onchainAddress),
    },
    offchain: {
      address: signer.offchainAddress,
      role: "off-chain identity — PoPoAuth (beans, invite, faucet signature)",
      sameAsOnchain: signer.offchainAddress === signer.onchainAddress,
    },
    zeroDevSession: session && "sessionKey" in session ? sessionStatus() : null,
  }
}

async function readBeans(address: Address) {
  const rows = await select<{ balance: number; address: string }>("credit_accounts", {
    address: `eq.${address.toLowerCase()}`,
    select: "address,balance",
  })
  return rows[0] ?? null
}

async function readMyTokens(chain: ChainConfig, owner: Address) {
  const rows = await select<{
    token_id: number
    name: string
    symbol: string
    status: string
    creator: string
  }>("hatch_tokens", {
    chain_id: `eq.${chain.chainId}`,
    creator: `eq.${owner.toLowerCase()}`,
    order: "token_id.desc",
    limit: "10",
    select: "token_id,name,symbol,status,creator",
  })
  return rows
}

/* ------------------------------------------------------------------ vault */

export async function vaultDepositPlan(ctx: Ctx, amountP: string): Promise<WritePlan> {
  const { chain, signer } = ctx
  const amount = parseP(amountP)
  if (amount <= 0n) throw new PopoError("usage", "amount must be greater than 0")
  const balances = await readBalances(ctx)
  if (BigInt(balances.walletP.raw) < amount) {
    throw new PopoError("insufficient_balance", "not enough $P in the wallet", {
      hint: `wallet $P ${balances.walletP.formatted}, needed ${formatP(amount)} — run \`popo faucet\``,
    })
  }

  const calls = []
  if (BigInt(balances.pAllowance) < amount) {
    calls.push(
      encodeCall({
        to: chain.contracts.usdp,
        functionName: "approve",
        params: [chain.contracts.diamond, amount],
        label: `approve ${formatP(amount)} $P to the diamond`,
      }),
    )
  }
  calls.push(
    encodeCall({
      to: chain.contracts.diamond,
      functionName: "deposit",
      params: [chain.quoteId, amount],
      label: `deposit ${formatP(amount)} $P into the trading vault`,
    }),
  )
  if (!balances.isOperator) {
    calls.push(
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "setOperator",
        params: [chain.contracts.diamond, true],
        label: "authorise the diamond to move your vault $P (one-time)",
      }),
    )
  }

  return {
    action: "vault.deposit",
    calls,
    summary: [
      `deposit ${formatP(amount)} $P from wallet → trading vault`,
      `wallet $P before: ${balances.walletP.formatted}`,
      `vault $P before: ${balances.vaultP.formatted}`,
      `after: wallet ${formatP(BigInt(balances.walletP.raw) - amount)} / vault ${formatP(
        BigInt(balances.vaultP.raw) + amount,
      )}`,
      `signer: ${signer.kind} (${shortAddr(signer.onchainAddress)})`,
    ],
    context: { amountP: formatP(amount), chainId: chain.chainId },
  }
}

export async function vaultWithdrawPlan(ctx: Ctx, amountP: string): Promise<WritePlan> {
  const { chain } = ctx
  const amount = parseP(amountP)
  const balances = await readBalances(ctx)
  if (BigInt(balances.vaultP.raw) < amount) {
    throw new PopoError("insufficient_balance", "not enough $P in the trading vault", {
      hint: `vault $P ${balances.vaultP.formatted}`,
    })
  }
  return {
    action: "vault.withdraw",
    calls: [
      encodeCall({
        to: chain.contracts.diamond,
        functionName: "withdraw",
        params: [chain.quoteId, amount],
        label: `withdraw ${formatP(amount)} $P to the wallet`,
      }),
    ],
    summary: [
      `withdraw ${formatP(amount)} $P from trading vault → wallet`,
      `vault $P after: ${formatP(BigInt(balances.vaultP.raw) - amount)}`,
    ],
    context: { amountP: formatP(amount) },
  }
}

/* ----------------------------------------------------------------- faucet */

export async function faucetClaim(ctx: Ctx, opts: { domainChainId?: boolean } = {}) {
  const { chain, signer } = ctx
  const address = signer.offchainAddress
  const timestampMs = Date.now()
  // MetaMask Agent Wallet refuses a typed-data request whose domain has no
  // chainId ("requires typedData.domain.chainId to match chainId"), so the mm
  // path always signs the chain-scoped variant. The faucet edge function accepts
  // it explicitly via domainChainId; legacy Privy callers keep the chainless one.
  const withChainId = opts.domainChainId ?? signer.kind === "mm"
  const input: AuthInput = {
    action: "testnet-faucet-claim",
    address,
    timestampMs,
    payload: { chainId: chain.chainId },
    ...(withChainId ? { domainChainId: chain.chainId } : {}),
  }
  const signature = await signer.signTypedData(authTypedData(input), {
    intent: `PoPo faucet claim on ${chain.label}`,
  })
  const result = await edge<{
    txHash?: string
    amountP?: string
    amount?: string
    recipient?: string
    error?: string
    status?: { canClaim?: boolean; nextClaimAt?: string }
  }>("testnet-faucet-claim", {
    chainId: chain.chainId,
    address,
    timestampMs,
    signature,
    ...(withChainId ? { domainChainId: chain.chainId } : {}),
  })
  return {
    ok: true,
    chainId: chain.chainId,
    recipient: result.recipient ?? address,
    txHash: result.txHash ?? null,
    explorer: result.txHash ? explorerTx(chain, result.txHash) : null,
    amountP: result.amountP ?? result.amount ?? null,
    next: result.txHash
      ? "funds are minted by the faucet hot wallet — check with `popo balance` in ~10s"
      : (result.error ?? "no tx returned; the faucet may be cooling down"),
  }
}

export async function faucetStatus(ctx: Ctx) {
  const { chain, signer } = ctx
  const address = signer.offchainAddress
  const timestampMs = Date.now()
  const withChainId = signer.kind === "mm"
  const signature = await signer.signTypedData(
    authTypedData({
      action: "testnet-faucet-claim",
      address,
      timestampMs,
      payload: { chainId: chain.chainId },
      ...(withChainId ? { domainChainId: chain.chainId } : {}),
    }),
    { intent: "PoPo faucet status" },
  )
  return await edge("testnet-faucet-claim", {
    chainId: chain.chainId,
    address,
    timestampMs,
    signature,
    ...(withChainId ? { domainChainId: chain.chainId } : {}),
    action: "status",
  })
}

/* ------------------------------------------------------------------- admin */

const ADMIN_SELECTORS: { name: string; selector: Hex }[] = [
  { name: "setCreateTokenFee", selector: "0x00000000" },
]

/**
 * Role check: pp-all gates admin UI on the on-chain `canCall(address, selector)`
 * mapping, never on a frontend allow-list. We expose the same primitive and
 * additionally probe a couple of concrete admin selectors.
 */
export async function hasAnyRole(ctx: Ctx): Promise<{
  canCallAdmin: boolean
  checked: boolean
  selectors?: Record<string, boolean>
}> {
  const { chain, client, signer } = ctx
  const owner = signer.onchainAddress
  const selectors: Record<string, boolean> = {}
  let any = false
  for (const item of ADMIN_SELECTORS) {
    const allowed = await client
      .readContract({
        address: chain.contracts.diamond,
        abi: POPO_ABI,
        functionName: "canCall",
        args: [owner, item.selector],
      })
      .catch(() => null)
    if (allowed === null) continue
    selectors[item.name] = Boolean(allowed)
    any = any || Boolean(allowed)
  }
  return { canCallAdmin: any, checked: Object.keys(selectors).length > 0, selectors }
}

export async function requireAdmin(ctx: Ctx, what: string): Promise<void> {
  const role = await hasAnyRole(ctx)
  if (!role.canCallAdmin) {
    throw new PopoError("policy_blocked", `${what} requires an on-chain admin role`, {
      hint: "the wallet must pass AccessControlFacet.canCall(address, selector)",
    })
  }
}

export async function setCreateTokenFeePlan(ctx: Ctx, amountP: string): Promise<WritePlan> {
  await requireAdmin(ctx, "setCreateTokenFee")
  const amount = parseP(amountP)
  return {
    action: "admin.setCreateTokenFee",
    calls: [
      encodeCall({
        to: ctx.chain.contracts.diamond,
        functionName: "setCreateTokenFee",
        params: [amount],
        label: `set create-token fee to ${formatP(amount)} $P`,
      }),
    ],
    summary: [`new create-token fee: ${formatP(amount)} $P (applies to future tokens only)`],
  }
}

/* -------------------------------------------------------------- raw escape */

export async function rawCall(
  ctx: Ctx,
  args: { fn: string; params: unknown[]; target?: Address },
) {
  const { chain, client } = ctx
  const target = args.target ?? chain.contracts.diamond
  const call = encodeCall({
    to: target,
    functionName: args.fn,
    params: args.params,
    label: `${args.fn}(${args.params.map((p) => String(p)).join(", ")})`,
  })
  const result = await client.call({
    to: target,
    data: call.data,
    account: ctx.signer.onchainAddress,
  })
  return { ok: true, to: target, fn: args.fn, raw: result.data ?? "0x" }
}

export function listFunctions() {
  return abiFunctionNames()
}

/** ERC20 $P balance helper used by `popo balance --token usdp`. */
export async function usdpBalance(ctx: Ctx, owner?: Address) {
  const who = owner ?? ctx.signer.onchainAddress
  const value = (await ctx.client.readContract({
    address: ctx.chain.contracts.usdp,
    abi: USDP_ABI,
    functionName: "balanceOf",
    args: [who],
  })) as bigint
  return { owner: who, raw: value.toString(), formatted: formatP(value) }
}

export { readConfig }
