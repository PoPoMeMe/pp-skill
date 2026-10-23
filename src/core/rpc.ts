/**
 * RPC layer: one public client per chain with automatic fallback, plus the
 * adaptive `eth_getLogs` scanner that PoPo needs on rate-limited / range-capped
 * testnets (Arc caps at 10k blocks, Monad answers 429 under load).
 */

import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Log,
  type PublicClient,
} from "viem"
import type { ChainConfig } from "./chains"
import { PopoError } from "./base"

const cache = new Map<number, PublicClient>()

export function viemChain(chain: ChainConfig) {
  return defineChain({
    id: chain.chainId,
    name: chain.label,
    nativeCurrency: { name: chain.gasSymbol, symbol: chain.gasSymbol, decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
    blockExplorers: { default: { name: chain.label, url: chain.explorerUrl } },
    testnet: chain.isTestnet,
  })
}

export function publicClientFor(chain: ChainConfig): PublicClient {
  const cached = cache.get(chain.chainId)
  if (cached) return cached
  const transports = [chain.rpcUrl, ...chain.fallbackRpcUrls]
    .filter((url, i, all) => all.indexOf(url) === i)
    .map((url) => http(url, { timeout: 20_000, retryCount: 1 }))
  const client = createPublicClient({
    chain: viemChain(chain),
    transport:
      transports.length > 1
        ? fallback(transports, { rank: false, retryCount: 1 })
        : transports[0]!,
  }) as PublicClient
  cache.set(chain.chainId, client)
  return client
}

/** Errors worth retrying with a smaller block range. */
function isRangeError(error: unknown): boolean {
  const text = String((error as { details?: string })?.details ?? (error as Error)?.message ?? "")
  return /range|too (many|large)|limit|exceed|-32012|more than|429|timeout/i.test(text)
}

export interface GetLogsInput {
  address: `0x${string}`
  event: {
    type: "event"
    name: string
    inputs: readonly { name: string; type: string; indexed?: boolean }[]
  }
  args?: Record<string, unknown>
  fromBlock: bigint
  toBlock?: bigint
  /** Initial window; halved automatically on range errors. */
  chunkSize?: bigint
}

/**
 * Scan logs in adaptive chunks. Shrinks the window on range/size errors and
 * grows it back on success, so a single call works on both Arc (10k cap) and a
 * permissive local node.
 */
export async function getLogsAdaptive(
  client: PublicClient,
  input: GetLogsInput,
  onProgress?: (pct: number) => void,
): Promise<Log[]> {
  const latest = input.toBlock ?? (await client.getBlockNumber())
  const from = input.fromBlock > latest ? 0n : input.fromBlock
  let chunk = input.chunkSize ?? 50_000n
  const minChunk = 1n
  const out: Log[] = []

  let cursor = from
  while (cursor <= latest) {
    const end = cursor + chunk - 1n > latest ? latest : cursor + chunk - 1n
    try {
      const logs = await client.getLogs({
        address: input.address,
        event: input.event as never,
        args: input.args as never,
        fromBlock: cursor,
        toBlock: end,
      })
      out.push(...logs)
      cursor = end + 1n
      if (chunk < 50_000n) chunk *= 2n
      if (onProgress && latest > from) {
        onProgress(Number(((cursor - from) * 100n) / (latest - from + 1n)))
      }
    } catch (error) {
      if (chunk <= minChunk || !isRangeError(error)) {
        throw new PopoError("rpc_error", "eth_getLogs failed", {
          hint: "the RPC rejected the range; retry with --from-block closer to now",
          details: { fromBlock: cursor.toString(), toBlock: end.toString() },
        })
      }
      chunk = chunk / 2n < minChunk ? minChunk : chunk / 2n
    }
  }
  return out
}

export async function blockNumber(client: PublicClient): Promise<bigint> {
  return client.getBlockNumber()
}

export async function chainHealth(chain: ChainConfig): Promise<{
  ok: boolean
  chainId: number | null
  blockNumber: string | null
  latencyMs: number | null
  error?: string
}> {
  const started = Date.now()
  try {
    const client = publicClientFor(chain)
    const [id, block] = await Promise.all([client.getChainId(), client.getBlockNumber()])
    return {
      ok: id === chain.chainId,
      chainId: id,
      blockNumber: block.toString(),
      latencyMs: Date.now() - started,
      ...(id === chain.chainId
        ? {}
        : { error: `RPC reports chainId ${id}, expected ${chain.chainId}` }),
    }
  } catch (error) {
    return {
      ok: false,
      chainId: null,
      blockNumber: null,
      latencyMs: Date.now() - started,
      error: (error as Error).message.slice(0, 160),
    }
  }
}
