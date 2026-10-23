/**
 * Chain registry — the ONLY place this repo knows about networks.
 *
 * Phase 1 supports exactly two PoPo deployments:
 *   • 421614  Arbitrum Sepolia   (ZeroDev's primary battlefield: standard 4337 chain)
 *   • 46630   Robinhood Chain Testnet (ZeroDev entry point is deployed here too)
 *
 * Contract addresses mirror pp-all's single source of truth
 * (app/src/lib/contracts-registry.ts). `npm run check:drift` compares both and
 * fails CI when they diverge — never hard-code an address anywhere else.
 */

import type { Address } from "./base"
import { PopoError } from "./base"

export const ENTRY_POINT_V07: Address =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032"

export interface ChainConfig {
  chainId: number
  key: string
  label: string
  /** Canonical RPC used for simulation, quotes and log scans. */
  rpcUrl: string
  /** Tried in order when the canonical RPC fails. */
  fallbackRpcUrls: string[]
  explorerUrl: string
  gasSymbol: string
  /** $P drip (edge function) is available on testnets. */
  faucetUrl: string
  /** Native gas faucet, when the chain has one. */
  gasFaucetUrl: string | null
  isTestnet: boolean
  contracts: {
    /** PoPoApp diamond (bonding curve, vault, AMM router, prediction, episodes). */
    diamond: Address
    /** USDPApp — the $P ERC20 (18 decimals). */
    usdp: Address
    /** Stablecoin used to mint $P on the Tokens page, when integrated. */
    usdc: Address | null
  }
  usdcDecimals: number
  /** ERC-6909 id of $P inside the vault. */
  quoteId: bigint
  /** First block worth scanning for LP/trade logs (0 = unknown, scans are adaptive). */
  startBlock: bigint
}

export const CHAINS: readonly ChainConfig[] = [
  {
    chainId: 421614,
    key: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    fallbackRpcUrls: ["https://arbitrum-sepolia.drpc.org"],
    explorerUrl: "https://sepolia.arbiscan.io",
    gasSymbol: "ETH",
    faucetUrl: "https://popo.meme/421614/faucet",
    gasFaucetUrl: "https://faucet.quicknode.com/arbitrum/sepolia",
    isTestnet: true,
    contracts: {
      diamond: "0xa57ba665456d23aAC98Ebf688d2Bf32fd58810F7",
      usdp: "0x0e872d6867323921489a23FF4572a7a749178A99",
      usdc: null,
    },
    usdcDecimals: 6,
    quoteId: 1n,
    startBlock: 0n,
  },
  {
    chainId: 46630,
    key: "robinhoodTestnet",
    label: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    fallbackRpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    gasSymbol: "ETH",
    faucetUrl: "https://popo.meme/46630/faucet",
    gasFaucetUrl: "https://faucet.quicknode.com/robinhood/testnet",
    isTestnet: true,
    contracts: {
      diamond: "0xCA1E405289335507782ad322d67916e7517953C2",
      usdp: "0x74231829420B9A65BD83F6efD10FD266DB84C2AE",
      usdc: "0x35Db7408b922CAd9f158cE0155008Af95aBaf0C4",
    },
    usdcDecimals: 6,
    quoteId: 1n,
    startBlock: 0n,
  },
] as const

export const DEFAULT_CHAIN_ID = 421614

export function listChains(): ChainConfig[] {
  return [...CHAINS]
}

export function getChain(idOrKey?: number | string | null): ChainConfig {
  if (idOrKey === undefined || idOrKey === null || idOrKey === "") {
    return mustFind(DEFAULT_CHAIN_ID)
  }
  const asNumber = typeof idOrKey === "number" ? idOrKey : Number(idOrKey)
  const byId = Number.isFinite(asNumber)
    ? CHAINS.find((c) => c.chainId === asNumber)
    : undefined
  if (byId) return byId
  const byKey = CHAINS.find(
    (c) =>
      c.key.toLowerCase() === String(idOrKey).toLowerCase() ||
      c.label.toLowerCase() === String(idOrKey).toLowerCase(),
  )
  if (byKey) return byKey

  throw new PopoError(
    "unsupported_chain",
    `chain ${String(idOrKey)} is not supported in this release`,
    {
      hint: `supported: ${CHAINS.map((c) => `${c.chainId} (${c.label})`).join(", ")}`,
    },
  )
}

function mustFind(chainId: number): ChainConfig {
  const found = CHAINS.find((c) => c.chainId === chainId)
  if (!found) throw new PopoError("internal", `chain ${chainId} missing from registry`)
  return found
}

export function explorerTx(chain: ChainConfig, hash: string): string {
  return `${chain.explorerUrl}/tx/${hash}`
}

export function explorerAddress(chain: ChainConfig, address: string): string {
  return `${chain.explorerUrl}/address/${address}`
}
