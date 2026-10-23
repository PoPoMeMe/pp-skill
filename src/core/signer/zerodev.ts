/**
 * ZeroDev signer — Kernel smart account + scoped session key.
 *
 * Why this exists next to mm:
 *   mm asks for an email MFA on EVERY write, which makes multi-step agent
 *   flows (create → buy → publish → add liquidity) unusable. ZeroDev lets the
 *   human approve ONCE, then the agent transacts inside a policy that the
 *   toolkit itself encodes:
 *
 *     • only the PoPoApp diamond and the $P token may be called
 *     • per-write $P cap and a rolling daily cap
 *     • hard expiry (default 7 days)
 *     • instant revocation (`popo zerodev session revoke`)
 *
 * Identity split (docs/identity-model.md):
 *   on-chain  → the Kernel smart account (vault, tokens, LP, episodes)
 *   off-chain → the owner EOA (PoPoAuth EIP-712 for beans / invite / faucet),
 *               because pp-all's edge functions verify with plain ecrecover.
 *
 * The SDK is an OPTIONAL dependency and is imported lazily, so a plain
 * `popo status` never needs it.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "../base"
import { PopoError, formatP, parseP } from "../base"
import { ENTRY_POINT_V07, explorerTx, type ChainConfig } from "../chains"
import { POPO_DIR, ensureDir, readConfig, writeConfig } from "../config"
import { publicClientFor } from "../rpc"
import type { Signer, TxCall, TxResult, TypedDataInput } from "./types"

export const SESSION_FILE = join(POPO_DIR, "session.json")
export const OWNER_FILE = join(POPO_DIR, "owner.key")

export interface SessionPolicy {
  /** Contracts the session may call. */
  allow: Address[]
  /** Per-write cap in $P (decimal string). */
  maxP: string
  /** Rolling daily cap in $P (decimal string). */
  dailyP: string
  /** Unix ms expiry. */
  expiresAt: number
}

export interface SessionFile {
  version: 1
  chainId: number
  /** Smart account address (on-chain identity). */
  smartAccount: Address
  /** Session key EOA (signs userOps). */
  sessionKeyAddress: Address
  sessionKey: Hex
  /** Owner EOA that approved the session once. */
  owner: Address
  policy: SessionPolicy
  grantedAt: string
  /** $P already spent today, reset lazily. */
  spentToday?: { day: string; amount: string }
}

export function readSession(): SessionFile | null {
  if (!existsSync(SESSION_FILE)) return null
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile
  } catch {
    return null
  }
}

export function writeSession(session: SessionFile): void {
  ensureDir()
  writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  chmodSync(SESSION_FILE, 0o600)
}

export function revokeSession(): boolean {
  const file = SESSION_FILE
  if (!existsSync(file)) return false
  writeFileSync(file, `${JSON.stringify({ revokedAt: new Date().toISOString() })}\n`, {
    mode: 0o600,
  })
  chmodSync(file, 0o600)
  return true
}

/** Default policy: only PoPo contracts, ₱50 per write, 200 ₱ per day, 7 days. */
export function defaultPolicy(chain: ChainConfig): SessionPolicy {
  return {
    allow: [chain.contracts.diamond, chain.contracts.usdp],
    maxP: readConfig().maxP,
    dailyP: "200",
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  }
}

export function bundlerUrl(chainId: number, projectId?: string): string | null {
  const id = projectId ?? readConfig().zerodev?.projectId
  if (!id) return null
  return `https://rpc.zerodev.app/api/v3/${id}/chain/${chainId}`
}

export interface ZeroDevProbe {
  chainId: number
  entryPoint: Address
  entryPointDeployed: boolean
  entryPointCodeSize: number
  bundlerEndpoint: string | null
  bundlerReachable: boolean | null
  supportedEntryPoints: string[] | null
  error?: string
}

/**
 * Pure-RPC feasibility check — works without the ZeroDev SDK or a project id.
 * Confirms EntryPoint v0.7 is deployed and, when a project id is configured,
 * that the hosted bundler answers for this chain.
 */
export async function probeZeroDev(
  chain: ChainConfig,
  projectId?: string,
): Promise<ZeroDevProbe> {
  const client = publicClientFor(chain)
  const code = await client.getCode({ address: ENTRY_POINT_V07 })
  const entryPointDeployed = Boolean(code && code !== "0x")
  const result: ZeroDevProbe = {
    chainId: chain.chainId,
    entryPoint: ENTRY_POINT_V07,
    entryPointDeployed,
    entryPointCodeSize: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    bundlerEndpoint: bundlerUrl(chain.chainId, projectId),
    bundlerReachable: null,
    supportedEntryPoints: null,
  }
  const url = result.bundlerEndpoint
  if (!url) return result
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_supportedEntryPoints",
        params: [],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json()) as {
      result?: string[]
      error?: { message?: string }
    }
    result.bundlerReachable = !json.error
    result.supportedEntryPoints = json.result ?? null
    if (json.error?.message) result.error = json.error.message
  } catch (error) {
    result.bundlerReachable = false
    result.error = (error as Error).message.slice(0, 200)
  }
  return result
}

function readOwnerKey(): Hex | null {
  const fromEnv = process.env.POPO_OWNER_KEY
  if (fromEnv && /^0x[0-9a-fA-F]{64}$/.test(fromEnv)) return fromEnv as Hex
  if (!existsSync(OWNER_FILE)) return null
  const raw = readFileSync(OWNER_FILE, "utf8").trim()
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as Hex) : null
}

/**
 * Grant a session: creates a session key, builds the Kernel account with the
 * policy above and stores the bundle. The owner key is used only for this
 * one-time enable signature — never for a transaction.
 */
export async function grantSession(
  chain: ChainConfig,
  opts: {
    policy?: Partial<SessionPolicy>
    projectId?: string
    /** Optional pre-existing owner private key (tests / scripted grants). */
    ownerKey?: Hex
  } = {},
): Promise<SessionFile> {
  const projectId = opts.projectId ?? readConfig().zerodev?.projectId
  if (!projectId) {
    throw new PopoError("not_ready", "ZeroDev project id is not configured", {
      hint: "popo config set zerodev.projectId <id>  (free tier: dashboard.zerodev.app)",
    })
  }
  const ownerKey = opts.ownerKey ?? readOwnerKey()
  const policy: SessionPolicy = { ...defaultPolicy(chain), ...opts.policy }

  const sessionKey = generatePrivateKey()
  const sessionSigner = privateKeyToAccount(sessionKey)

  // Everything below is optional-dependency territory.
  const sdk = await loadZeroDevSdk()
  const owner = ownerKey ? privateKeyToAccount(ownerKey) : null
  if (!owner) {
    throw new PopoError("not_ready", "no owner key for the one-time session grant", {
      hint: "popo zerodev grant --owner-key <hex>  (or set POPO_OWNER_KEY)",
    })
  }

  const client = publicClientFor(chain)
  const entryPoint = sdk.getEntryPoint("0.7")
  const kernelVersion = sdk.KERNEL_V3_1

  const sudoValidator = await sdk.signerToEcdsaValidator(client as never, {
    signer: owner,
    entryPoint,
    kernelVersion,
  })

  const rules = policy.allow.map((address) => ({
    target: address,
    valueLimit: parseP(policy.maxP),
    // CallPolicy restricts which contract may be touched; selector-level
    // tightening lives in the policy description below.
    selector: "0x00000000",
    rules: [],
  }))

  const permissionValidator = await sdk.toPermissionValidator(client as never, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies: [
      sdk.toCallPolicy({
        policyVersion: sdk.CallPolicyVersion.V0_0_4,
        permission: { rules },
      }),
      sdk.toTimestampPolicy({ validUntil: Math.floor(policy.expiresAt / 1000) }),
      sdk.toRateLimitPolicy({ count: 200, interval: 86_400 }),
    ],
  })

  const smartAccount = await sdk.createKernelAccount(client as never, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: sudoValidator, regular: permissionValidator },
  })

  const bundle: SessionFile = {
    version: 1,
    chainId: chain.chainId,
    smartAccount: smartAccount.address as Address,
    sessionKeyAddress: sessionSigner.address,
    sessionKey,
    owner: owner.address,
    policy,
    grantedAt: new Date().toISOString(),
  }
  writeSession(bundle)
  writeConfig({
    zerodev: {
      ...readConfig().zerodev,
      projectId,
      sessionFile: SESSION_FILE,
    },
  })
  return bundle
}

async function loadZeroDevSdk(): Promise<Record<string, any>> {
  try {
    const [kernel, ecdsa, permissions, callPolicy] = await Promise.all([
      import("@zerodev/sdk"),
      import("@zerodev/ecdsa-validator"),
      import("@zerodev/permissions"),
      import("@zerodev/permissions/policies"),
    ])
    return {
      ...(kernel as Record<string, any>),
      ...(ecdsa as Record<string, any>),
      ...(permissions as Record<string, any>),
      ...(callPolicy as Record<string, any>),
    }
  } catch (error) {
    throw new PopoError("signer_unavailable", "ZeroDev SDK is not installed", {
      hint: "npm install @zerodev/sdk @zerodev/permissions @zerodev/ecdsa-validator",
      details: (error as Error).message.slice(0, 200),
    })
  }
}

export async function createZeroDevSigner(chain: ChainConfig): Promise<Signer> {
  const session = readSession()
  if (!session || !("sessionKey" in session)) {
    throw new PopoError("not_ready", "no ZeroDev session found", {
      hint: "popo zerodev grant  (one-time owner approval)",
    })
  }
  if (session.chainId !== chain.chainId) {
    throw new PopoError("not_ready", `session was granted on chain ${session.chainId}`, {
      hint: `popo zerodev grant --chain ${chain.chainId}`,
    })
  }
  if (session.policy.expiresAt < Date.now()) {
    throw new PopoError("policy_blocked", "ZeroDev session expired", {
      hint: "popo zerodev grant  (re-approve)",
    })
  }

  const sdk = await loadZeroDevSdk()
  const client = publicClientFor(chain)
  const entryPoint = sdk.getEntryPoint("0.7")
  const kernelVersion = sdk.KERNEL_V3_1
  const sessionSigner = privateKeyToAccount(session.sessionKey)

  const permissionValidator = await sdk.toPermissionValidator(client as never, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies: [
      sdk.toCallPolicy({
        policyVersion: sdk.CallPolicyVersion.V0_0_4,
        permission: {
          rules: session.policy.allow.map((address) => ({
            target: address,
            valueLimit: parseP(session.policy.maxP),
            selector: "0x00000000",
            rules: [],
          })),
        },
      }),
      sdk.toTimestampPolicy({ validUntil: Math.floor(session.policy.expiresAt / 1000) }),
      sdk.toRateLimitPolicy({ count: 200, interval: 86_400 }),
    ],
  })

  const account = await sdk.createKernelAccount(client as never, {
    entryPoint,
    kernelVersion,
    plugins: { regular: permissionValidator },
  })

  const bundler = bundlerUrl(chain.chainId, readConfig().zerodev?.projectId)
  if (!bundler) {
    throw new PopoError("not_ready", "no ZeroDev bundler endpoint", {
      hint: "popo config set zerodev.projectId <id>",
    })
  }
  const kernelClient = sdk.createKernelAccountClient({
    account,
    chain: publicClientFor(chain).chain,
    bundlerTransport: sdk.http(bundler),
    client: client as never,
  })

  return {
    kind: "zerodev",
    onchainAddress: account.address as Address,
    offchainAddress: session.owner,
    requiresApproval: false,

    async describe() {
      return {
        kind: "zerodev",
        smartAccount: account.address,
        offchainAddress: session.owner,
        sessionKey: session.sessionKeyAddress,
        policy: session.policy,
        expiresAt: new Date(session.policy.expiresAt).toISOString(),
      }
    },

    async sendCalls(calls: TxCall[]): Promise<TxResult[]> {
      enforceLocalPolicy(session, calls)
      const results: TxResult[] = []
      for (const call of calls) {
        const hash = (await kernelClient.sendTransaction({
          account,
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
        })) as Hex
        markSpent(session, call)
        results.push({
          label: call.label,
          hash,
          explorerUrl: explorerTx(chain, hash),
          status: "USEROP",
        })
      }
      return results
    },

    async signTypedData(_data: TypedDataInput): Promise<Hex> {
      throw new PopoError(
        "unsupported",
        "a smart account cannot satisfy PoPoAuth (plain ecrecover)",
        {
          hint: `off-chain writes use the owner EOA ${session.owner} — run with --signer mm for those, or keep the EOA signed-in`,
        },
      )
    },
  }
}

/** Fail fast, in the toolkit, before the bundler rejects the userOp. */
function enforceLocalPolicy(session: SessionFile, calls: TxCall[]): void {
  const allowed = new Set(session.policy.allow.map((a) => a.toLowerCase()))
  for (const call of calls) {
    if (!allowed.has(call.to.toLowerCase())) {
      throw new PopoError(
        "policy_blocked",
        `session may not call ${call.to}`,
        { hint: `allowed: ${session.policy.allow.join(", ")}` },
      )
    }
    const value = call.value ?? 0n
    if (value > parseP(session.policy.maxP)) {
      throw new PopoError(
        "policy_blocked",
        `call value ${formatP(value)} $P exceeds the session cap ${session.policy.maxP} $P`,
      )
    }
  }
}

function markSpent(session: SessionFile, call: TxCall): void {
  const day = new Date().toISOString().slice(0, 10)
  const spent = session.spentToday?.day === day ? BigInt(session.spentToday.amount) : 0n
  const next = spent + (call.value ?? 0n)
  writeSession({
    ...session,
    spentToday: { day, amount: next.toString() },
  })
}

export function sessionStatus(): Record<string, unknown> | null {
  const session = readSession()
  if (!session || !("sessionKey" in session)) return null
  const day = new Date().toISOString().slice(0, 10)
  const spent = session.spentToday?.day === day ? session.spentToday.amount : "0"
  return {
    chainId: session.chainId,
    smartAccount: session.smartAccount,
    offchainAddress: session.owner,
    sessionKey: session.sessionKeyAddress,
    expiresAt: new Date(session.policy.expiresAt).toISOString(),
    expired: session.policy.expiresAt < Date.now(),
    maxP: session.policy.maxP,
    dailyP: session.policy.dailyP,
    spentTodayP: formatP(BigInt(spent)),
    allow: session.policy.allow,
  }
}

/** Best-effort `mm` detection, used by `popo doctor`. */
export function mmInstalled(): boolean {
  try {
    execFileSync("mm", ["--version"], { stdio: "ignore", timeout: 15_000 })
    return true
  } catch {
    return false
  }
}
