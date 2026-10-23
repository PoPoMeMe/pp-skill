/**
 * mm signer — MetaMask Agent Wallet.
 *
 * This is the default backend: the toolkit never touches a private key. Every
 * write is handed to `mm wallet send-transaction` / `mm wallet sign-typed-data`
 * as a raw payload; the host enforces its policy engine and (in server-wallet
 * mode) a per-request email MFA.
 *
 * On chains MetaMask does not ship by default (anything outside its registry)
 * the remote signer rejects requests that omit fee fields, so we always compute
 * EIP-1559 fees and an explicit gas limit from the public RPC first.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Address, Hex } from "../base"
import { PopoError, toHexQuantity } from "../base"
import { explorerTx, type ChainConfig } from "../chains"
import { publicClientFor } from "../rpc"
import type { Signer, TxCall, TxResult, TypedDataInput } from "./types"

const run = promisify(execFile)

interface MmEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string }
}

async function mmJson<T>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  let stdout: string
  try {
    const res = await run("mm", [...args, "--json"], {
      timeout: opts.timeoutMs ?? 600_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    })
    stdout = res.stdout
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: string }
    if (err.code === "ENOENT") {
      throw new PopoError("signer_unavailable", "`mm` (MetaMask Agent Wallet) is not installed", {
        hint: "npm install -g @metamask/agent-wallet && mm auth status",
      })
    }
    const parsed = safeParse(err.stdout ?? "")
    const stderr = (err.stderr ?? "").trim().slice(0, 400)
    const message =
      (parsed?.error?.message as string | undefined) ??
      (stderr.length > 0 ? stderr : err.message) ??
      "mm command failed"
    throw new PopoError("signer_unavailable", message, {
      hint: "run `mm auth status` and check `mm wallet requests list` for a pending approval",
    })
  }
  const parsed = safeParse(stdout)
  if (!parsed) {
    throw new PopoError("signer_unavailable", "mm returned non-JSON output", {
      details: stdout.slice(0, 300),
    })
  }
  if (parsed.ok === false) {
    throw new PopoError(
      "signer_unavailable",
      parsed.error?.message ?? "mm rejected the request",
      { details: parsed.error },
    )
  }
  return parsed.data as T
}

function safeParse(text: string): MmEnvelope<unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // mm prints warnings before the JSON envelope; take the last JSON object.
  const start = trimmed.indexOf("{")
  if (start < 0) return null
  try {
    return JSON.parse(trimmed.slice(start)) as MmEnvelope<unknown>
  } catch {
    return null
  }
}

/** mm returns different shapes per mode; normalise the interesting fields. */
function pickResult(data: unknown): {
  hash: Hex | null
  status?: string
  pollingId?: string
} {
  const bag = (data ?? {}) as Record<string, unknown>
  const nested = (bag.result ?? bag.transaction ?? bag.signature ?? {}) as Record<
    string,
    unknown
  >
  const hash =
    (nested.transactionHash as string | undefined) ??
    (nested.hash as string | undefined) ??
    (bag.transactionHash as string | undefined) ??
    (bag.hash as string | undefined) ??
    null
  const status =
    (bag.status as string | undefined) ?? (nested.status as string | undefined) ?? undefined
  const pollingId =
    (bag.pollingId as string | undefined) ?? (nested.pollingId as string | undefined)
  return {
    hash: hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as Hex) : null,
    ...(status ? { status } : {}),
    ...(pollingId ? { pollingId } : {}),
  }
}

export interface MmSignerOptions {
  chain: ChainConfig
}

export async function createMmSigner(options: MmSignerOptions): Promise<Signer> {
  const { chain } = options
  const resolvedAddress = await resolveAddress()

  async function resolveAddress(): Promise<Address> {
    const data = await mmJson<{ address?: string } | string>(["wallet", "address"])
    const value = typeof data === "string" ? data : data?.address
    if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new PopoError("signer_unavailable", "could not resolve the mm wallet address", {
        hint: "run `mm wallet list` and `mm wallet select`",
      })
    }
    return value as Address
  }

  async function address(): Promise<Address> {
    return resolvedAddress
  }

  async function feesFor(call: TxCall): Promise<Record<string, string>> {
    const client = publicClientFor(chain)
    const account = await address()
    const [fees, gas] = await Promise.all([
      client.estimateFeesPerGas().catch(() => null),
      client
        .estimateGas({
          account,
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
        })
        .catch(() => null),
    ])
    const payload: Record<string, string> = {}
    if (gas !== null) payload.gas = toHexQuantity((gas * 12n) / 10n)
    if (fees?.maxFeePerGas) payload.maxFeePerGas = toHexQuantity(fees.maxFeePerGas)
    if (fees?.maxPriorityFeePerGas) {
      payload.maxPriorityFeePerGas = toHexQuantity(fees.maxPriorityFeePerGas)
    }
    return payload
  }

  const signer: Signer = {
    kind: "mm",
    onchainAddress: resolvedAddress,
    offchainAddress: resolvedAddress,
    requiresApproval: true,

    async describe() {
      return {
        kind: "mm",
        address: resolvedAddress,
        chainId: chain.chainId,
      }
    },

    async sendCalls(calls: TxCall[], opts: { intent?: string } = {}) {
      const results: TxResult[] = []
      for (const call of calls) {
        const fees = await feesFor(call)
        const payload = JSON.stringify({
          to: call.to,
          ...(call.data ? { data: call.data } : {}),
          value: toHexQuantity(call.value ?? 0n),
          ...fees,
        })
        const data = await mmJson<unknown>(
          [
            "wallet",
            "send-transaction",
            "--chain-id",
            String(chain.chainId),
            "--payload",
            payload,
            "--wait",
            "--wallet-timeout",
            "600",
            "--intent",
            opts.intent ? `${call.label} · ${opts.intent}` : call.label,
          ],
          { timeoutMs: 660_000 },
        )
        const picked = pickResult(data)
        results.push({
          label: call.label,
          hash: picked.hash,
          explorerUrl: picked.hash ? explorerTx(chain, picked.hash) : null,
          ...(picked.status ? { status: picked.status } : {}),
          ...(picked.pollingId ? { pollingId: picked.pollingId } : {}),
        })
        if (!picked.hash && picked.status !== "CONFIRMED") {
          throw new PopoError(
            "signer_unavailable",
            `mm did not broadcast "${call.label}"${picked.status ? ` (status ${picked.status})` : ""}`,
            {
              hint: picked.pollingId
                ? `approve it, then run: mm wallet requests watch ${picked.pollingId} --json`
                : "run `mm wallet requests list --json` to inspect pending approvals",
              details: data,
            },
          )
        }
      }
      return results
    },

    async signTypedData(data: TypedDataInput, opts: { intent?: string } = {}) {
      // EIP-712 messages carry uint256 values as BigInt here; mm takes JSON.
      const payload = JSON.stringify(data, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )
      const result = await mmJson<unknown>(
        [
          "wallet",
          "sign-typed-data",
          "--chain-id",
          String(chain.chainId),
          "--payload",
          payload,
          "--wait",
          "--wallet-timeout",
          "600",
          "--intent",
          opts.intent ?? "PoPoAuth",
        ],
        { timeoutMs: 660_000 },
      )
      const bag = result as Record<string, unknown>
      const nested = (
        typeof bag.result === "object" && bag.result !== null ? bag.result : bag
      ) as Record<string, unknown>
      const signature =
        (typeof bag.signature === "string" ? bag.signature : undefined) ??
        (typeof nested.signature === "string" ? nested.signature : undefined) ??
        (typeof nested.signatureHex === "string" ? nested.signatureHex : undefined) ??
        (typeof result === "string" ? result : undefined)
      if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new PopoError("signer_unavailable", "mm did not return a signature", {
          details: result,
        })
      }
      return signature as Hex
    },
  }

  return signer
}
