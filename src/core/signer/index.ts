/**
 * Signer resolution.
 *
 *   auto      → zerodev session (if granted & valid) → mm → readonly
 *   mm        → MetaMask Agent Wallet (default for humans, MFA per write)
 *   zerodev   → Kernel + scoped session key (bounded, unattended)
 *   local     → testnet key on disk (CI / E2E, needs --i-know-this-is-testnet)
 *   readonly  → no writes at all, reads only
 */

import type { Address } from "../base"
import { PopoError } from "../base"
import type { ChainConfig } from "../chains"
import { readConfig, type SignerKind } from "../config"
import { createLocalSigner } from "./local"
import { createMmSigner } from "./mm"
import { createZeroDevSigner, readSession } from "./zerodev"
import type { Signer } from "./types"

export type ResolvedKind = SignerKind

export interface ResolveOptions {
  kind?: ResolvedKind
  /** Address for readonly mode (or to override reads). */
  address?: Address | null
}

export async function resolveSigner(
  chain: ChainConfig,
  options: ResolveOptions = {},
): Promise<Signer> {
  const requested = options.kind ?? readConfig().signer

  if (requested === "readonly") return createReadOnlySigner(chain, options.address ?? null)
  if (requested === "local") return createLocalSigner(chain)
  if (requested === "mm") return await createMmSigner({ chain })
  if (requested === "zerodev") return await createZeroDevSigner(chain)

  // auto
  const session = readSession()
  if (session && "sessionKey" in session && session.chainId === chain.chainId) {
    try {
      return await createZeroDevSigner(chain)
    } catch {
      // fall through to mm
    }
  }
  try {
    return await createMmSigner({ chain })
  } catch (error) {
    if (options.address) return createReadOnlySigner(chain, options.address)
    throw new PopoError(
      "signer_unavailable",
      (error as Error).message ||
        "no signer available (mm not installed / not logged in, no ZeroDev session)",
      {
        hint: "install MetaMask Agent Wallet (npm i -g @metamask/agent-wallet) or pass --address for read-only",
      },
    )
  }
}

export function createReadOnlySigner(chain: ChainConfig, address: Address | null): Signer {
  const addr = (address ?? "0x0000000000000000000000000000000000000000") as Address
  const offchain = readConfig().offchainAddress as Address | undefined
  return {
    kind: "readonly",
    onchainAddress: addr,
    offchainAddress: (offchain ?? addr) as Address,
    requiresApproval: false,
    async describe() {
      return { kind: "readonly", address: address, chainId: chain.chainId }
    },
    async sendCalls() {
      throw new PopoError("signer_unavailable", "read-only mode: nothing was sent", {
        hint: "run with --signer mm or --signer zerodev to write",
      })
    },
    async signTypedData() {
      throw new PopoError("signer_unavailable", "read-only mode: cannot sign", {
        hint: "run with --signer mm to sign PoPoAuth writes",
      })
    },
  }
}

export * from "./types"
export { mmInstalled, sessionStatus, probeZeroDev, grantSession, revokeSession } from "./zerodev"
