import type { Address, Hex } from "../base"

export type SignerKind = "mm" | "zerodev" | "local" | "readonly"

export interface TxCall {
  to: Address
  data?: Hex
  value?: bigint
  /** Human-readable summary shown in the confirmation block and to the wallet. */
  label: string
}

export interface TxResult {
  label: string
  hash: Hex | null
  explorerUrl: string | null
  /** Raw wallet status (e.g. AWAITING_MFA / CONFIRMED / USEROP). */
  status?: string
  /** Set when the wallet queued the request instead of broadcasting. */
  pollingId?: string
}

export interface TypedDataInput {
  domain: Record<string, any>
  types: Record<string, any>
  primaryType: string
  message: Record<string, any>
}

export interface Signer {
  readonly kind: SignerKind
  /** Address that owns on-chain state (vault balance, tokens, positions). */
  readonly onchainAddress: Address
  /** Address that signs PoPoAuth off-chain writes (always an EOA). */
  readonly offchainAddress: Address
  /** True when each write needs a human approval (MFA / passkey). */
  readonly requiresApproval: boolean
  sendCalls(calls: TxCall[], opts?: { intent?: string }): Promise<TxResult[]>
  signTypedData(data: TypedDataInput, opts?: { intent?: string }): Promise<Hex>
  describe(): Promise<Record<string, unknown>>
}

export interface CallPreview {
  to: Address
  data: Hex
  value: bigint
  gas: bigint | null
  /** Decoded result of simulateContract, when available. */
  simulated: unknown
  /** Human summary lines rendered before confirmation. */
  summary: string[]
}
