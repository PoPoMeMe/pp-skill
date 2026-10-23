/**
 * Local configuration store: ~/.popo/config.json (mode 0600).
 *
 * Holds no secrets except the optional local testnet key, which lives in its
 * own file (~/.popo/key) and is never written to config.json or printed.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CHAIN_ID } from "./chains"
import { PopoError } from "./base"

export type SignerKind = "auto" | "mm" | "zerodev" | "local" | "readonly"

export interface ZeroDevConfig {
  /** ZeroDev project id (bundler/paymaster endpoint). Empty = use public fallback. */
  projectId?: string
  /** Kernel version used when granting the session. */
  kernelVersion?: string
  /** Path to the granted session key file (0600). */
  sessionFile?: string
}

export interface PopoConfig {
  chainId: number
  signer: SignerKind
  /** Hard cap for a single write, in $P. Writes above it are refused. */
  maxP: string
  /** Off-chain identity override (defaults to the signer address). */
  offchainAddress?: string
  zerodev?: ZeroDevConfig
  /** Per-chain first block for log scans, keyed by chainId. */
  scanStartBlocks?: Record<string, string>
}

export const POPO_DIR = process.env.POPO_HOME ?? join(homedir(), ".popo")
export const CONFIG_PATH = join(POPO_DIR, "config.json")
export const KEY_PATH = join(POPO_DIR, "key")

const DEFAULTS: PopoConfig = {
  chainId: DEFAULT_CHAIN_ID,
  signer: "auto",
  maxP: "50",
}

export function ensureDir(): void {
  if (!existsSync(POPO_DIR)) mkdirSync(POPO_DIR, { recursive: true, mode: 0o700 })
}

export function readConfig(): PopoConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PopoConfig>
    return { ...DEFAULTS, ...raw }
  } catch {
    throw new PopoError("internal", `cannot parse ${CONFIG_PATH}`, {
      hint: "delete the file to reset the local configuration",
    })
  }
}

export function writeConfig(patch: Partial<PopoConfig>): PopoConfig {
  ensureDir()
  const next: PopoConfig = { ...readConfig(), ...patch }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(CONFIG_PATH, 0o600)
  return next
}

export function readLocalKey(): `0x${string}` | null {
  const fromEnv = process.env.POPO_PRIVATE_KEY
  if (fromEnv && /^0x[0-9a-fA-F]{64}$/.test(fromEnv)) return fromEnv as `0x${string}`
  if (!existsSync(KEY_PATH)) return null
  const raw = readFileSync(KEY_PATH, "utf8").trim()
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : null
}

export function writeLocalKey(key: `0x${string}`): void {
  ensureDir()
  writeFileSync(KEY_PATH, `${key}\n`, { mode: 0o600 })
  chmodSync(KEY_PATH, 0o600)
}
