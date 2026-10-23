/**
 * local signer — testnet / CI only.
 *
 * Reads POPO_PRIVATE_KEY or ~/.popo/key (mode 0600). It exists so the E2E
 * suite and the ZeroDev capability matrix can run without a human approving an
 * MFA prompt. It is never selected implicitly: the caller must pass
 * `--signer local --i-know-this-is-testnet`, and non-test chains are refused.
 */

import { createWalletClient, http, type Hex, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { PopoError } from "../base"
import type { Address } from "../base"
import { readLocalKey } from "../config"
import type { ChainConfig } from "../chains"
import { explorerTx } from "../chains"
import { viemChain } from "../rpc"
import type { Signer, TxCall, TxResult, TypedDataInput } from "./types"

export function createLocalSigner(chain: ChainConfig): Signer {
  if (!chain.isTestnet) {
    throw new PopoError("policy_blocked", "the local signer is testnet-only", {
      hint: "use --signer mm or --signer zerodev for a real chain",
    })
  }
  const key = readLocalKey()
  if (!key) {
    throw new PopoError("signer_unavailable", "no local testnet key found", {
      hint: "popo wallet init --signer local (writes ~/.popo/key, chmod 600)",
    })
  }
  const account = privateKeyToAccount(key)
  const wallet: WalletClient = createWalletClient({
    account,
    chain: viemChain(chain),
    transport: http(chain.rpcUrl, { timeout: 20_000 }),
  })

  return {
    kind: "local",
    onchainAddress: account.address,
    offchainAddress: account.address,
    requiresApproval: false,

    async describe() {
      return { kind: "local", address: account.address, chainId: chain.chainId }
    },

    async sendCalls(calls: TxCall[]): Promise<TxResult[]> {
      const results: TxResult[] = []
      for (const call of calls) {
        const hash = await wallet.sendTransaction({
          account,
          chain: viemChain(chain),
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
        })
        results.push({
          label: call.label,
          hash,
          explorerUrl: explorerTx(chain, hash),
          status: "BROADCAST",
        })
      }
      return results
    },

    async signTypedData(data: TypedDataInput): Promise<Hex> {
      return account.signTypedData({
        domain: data.domain,
        types: data.types,
        primaryType: data.primaryType,
        message: data.message,
      } as never)
    },
  }
}

export function localAddress(): Address | null {
  const key = readLocalKey()
  if (!key) return null
  return privateKeyToAccount(key).address
}
