/** Shared primitives, error type and unit helpers for the whole toolkit. */

export type Address = `0x${string}`
export type Hex = `0x${string}`

/** $P (USDP) has 18 decimals on every PoPo deployment. */
export const P_DECIMALS = 18

/** Exit codes are part of the CLI contract: agents branch on them. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** A write was simulated but not sent — the caller must confirm. */
  confirmationRequired: 3,
  /** Environment is not ready (no wallet, unsupported chain, …). */
  notReady: 4,
} as const

export type ErrorCode =
  | "confirmation_required"
  | "usage"
  | "not_ready"
  | "unsupported_chain"
  | "signer_unavailable"
  | "policy_blocked"
  | "insufficient_balance"
  | "rpc_error"
  | "contract_revert"
  | "backend_error"
  | "not_found"
  | "unsupported"
  | "internal"

export class PopoError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly details?: unknown
  readonly exitCode: number

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: unknown; exitCode?: number } = {},
  ) {
    super(message)
    this.name = "PopoError"
    this.code = code
    this.hint = opts.hint
    this.details = opts.details
    this.exitCode =
      opts.exitCode ??
      (code === "confirmation_required"
        ? EXIT.confirmationRequired
        : code === "usage"
          ? EXIT.usage
          : code === "not_ready" || code === "signer_unavailable"
            ? EXIT.notReady
            : EXIT.error)
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/** Parse a human "$P" amount ("1.5") into 18-decimal base units. */
export function parseP(value: string | number): bigint {
  const s = typeof value === "number" ? value.toString() : value.trim()
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") {
    throw new PopoError("usage", `invalid $P amount: ${String(value)}`)
  }
  const [whole = "0", frac = ""] = s.split(".")
  const padded = (frac + "0".repeat(P_DECIMALS)).slice(0, P_DECIMALS)
  return BigInt(whole || "0") * 10n ** BigInt(P_DECIMALS) + BigInt(padded || "0")
}

/** Format 18-decimal base units as a plain string, trimming trailing zeros. */
export function formatP(value: bigint, maxFrac = 4): string {
  return formatUnits(value, P_DECIMALS, maxFrac)
}

export function formatUnits(value: bigint, decimals: number, maxFrac = 4): string {
  const neg = value < 0n
  const v = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = v % base
  if (frac === 0n || maxFrac <= 0) return `${neg ? "-" : ""}${whole}`
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac)
  fracStr = fracStr.replace(/0+$/, "")
  return `${neg ? "-" : ""}${whole}${fracStr ? `.${fracStr}` : ""}`
}

export function toHexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10000n
}

export function shortAddr(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

export function isoNow(): string {
  return new Date().toISOString()
}
