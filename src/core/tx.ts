/**
 * Write plans and the confirmation gate.
 *
 * Contract (consumed by the CLI, the MCP server and the TUI):
 *   1. build    — a module returns a WritePlan (encoded calls + human summary)
 *   2. simulate — every call is eth_call'ed; a revert aborts before any wallet
 *                 popup, so agents never waste an MFA prompt on a doomed tx
 *   3. confirm  — without `--yes` the process exits 3 and prints the plan
 *   4. send     — the signer (mm / zerodev / local) broadcasts
 *
 * Nothing in this file holds a key; it only encodes and checks.
 */

import { encodeFunctionData } from "viem"
import type { PublicClient } from "viem"
import {
  POPO_ABI,
  abiFunctionNames,
  findAbiFunction,
} from "./abi"
import { PopoError, formatP, parseP } from "./base"
import type { Address, Hex } from "./base"
import { explorerTx, type ChainConfig } from "./chains"
import { readConfig } from "./config"
import { publicClientFor } from "./rpc"
import type { Signer, TxCall, TxResult } from "./signer/types"

export interface WritePlan {
  action: string
  calls: TxCall[]
  /** Lines rendered in the TTY confirmation block. */
  summary: string[]
  /** $P moved out of the wallet by this plan (for the max-tx guard). */
  spendP?: bigint
  context?: Record<string, unknown>
}

export interface PlannedCall extends TxCall {
  gas: bigint | null
  revert: string | null
}

export function encodeCall(args: {
  to: Address
  functionName: string
  params?: readonly unknown[]
  value?: bigint
  label: string
}): TxCall {
  const item = findAbiFunction(args.functionName)
  if (!item) {
    throw new PopoError("usage", `unknown contract function: ${args.functionName}`, {
      hint: "popo call --list prints every callable function",
    })
  }
  const inputs = ("inputs" in item ? item.inputs : []) as readonly unknown[]
  const expected = inputs.length
  const got = args.params?.length ?? 0
  if (expected !== got) {
    throw new PopoError(
      "usage",
      `${args.functionName} expects ${expected} argument(s), got ${got}`,
      { hint: "see `popo call --list` or docs/command-reference.md" },
    )
  }
  const data = encodeWithAbi(args.functionName, args.params ?? [])
  return {
    to: args.to,
    data,
    ...(args.value ? { value: args.value } : {}),
    label: args.label,
  }
}

function encodeWithAbi(functionName: string, params: readonly unknown[]): Hex {
  // The merged JSON ABI is typed as `Abi`, which is enough for both TS and runtime.
  return encodeFunctionData({
    abi: POPO_ABI,
    functionName: functionName as never,
    args: params as never,
  })
}

export async function simulatePlan(
  chain: ChainConfig,
  plan: WritePlan,
  from: Address,
): Promise<PlannedCall[]> {
  const client = publicClientFor(chain)
  const out: PlannedCall[] = []
  for (const call of plan.calls) {
    const gas = await client
      .estimateGas({ account: from, to: call.to, data: call.data, value: call.value ?? 0n })
      .catch(() => null)
    let revert: string | null = null
    try {
      await client.call({
        account: from,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
      })
    } catch (error) {
      revert = decodeRevert(error)
    }
    out.push({ ...call, gas, revert })
  }
  return out
}

function decodeRevert(error: unknown): string {
  const err = error as {
    shortMessage?: string
    details?: string
    message?: string
    cause?: { reason?: string; data?: unknown }
  }
  return (
    err.cause?.reason ??
    err.shortMessage ??
    err.details ??
    err.message ??
    "call reverted"
  ).slice(0, 240)
}

/** $P cap guard — refuses a plan above `maxP` regardless of `--yes`. */
export function enforceSpendCap(plan: WritePlan): void {
  const cap = parseP(readConfig().maxP)
  if (plan.spendP !== undefined && plan.spendP > cap) {
    throw new PopoError(
      "policy_blocked",
      `plan spends ${formatP(plan.spendP)} $P, above the local cap of ${formatP(cap)} $P`,
      { hint: "popo config set maxP <amount> to raise it deliberately" },
    )
  }
}

export async function executePlan(
  chain: ChainConfig,
  signer: Signer,
  plan: WritePlan,
  opts: { yes: boolean; dryRun?: boolean },
): Promise<{ simulated: PlannedCall[]; results: TxResult[] }> {
  enforceSpendCap(plan)
  const simulated = await simulatePlan(chain, plan, signer.onchainAddress)
  const failure = simulated.find((c) => c.revert)
  if (failure) {
    throw new PopoError("contract_revert", `${failure.label} would revert: ${failure.revert}`, {
      hint: "nothing was sent; fix the inputs and retry",
    })
  }
  if (!opts.yes || opts.dryRun) {
    throw new PopoError("confirmation_required", "dry-run: plan was simulated but not sent", {
      hint: "re-run with --yes to send",
      details: {
        action: plan.action,
        summary: plan.summary,
        calls: simulated.map((c) => ({
          label: c.label,
          to: c.to,
          gas: c.gas?.toString() ?? null,
        })),
      },
    })
  }
  const results = await signer.sendCalls(plan.calls, { intent: plan.action })
  return { simulated, results }
}

export function explainResults(chain: ChainConfig, results: TxResult[]): string[] {
  return results.map((r) =>
    r.hash
      ? `${r.label}: ${r.status ?? "sent"} ${explorerTx(chain, r.hash)}`
      : `${r.label}: queued (${r.status ?? "pending"}${r.pollingId ? `, id ${r.pollingId}` : ""})`,
  )
}

export { abiFunctionNames }
