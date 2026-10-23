/**
 * EIP-712 "PoPoAuth" — byte-identical mirror of
 * pp-all/app/supabase/functions/_shared/auth.ts.
 *
 * Every off-chain write (beans check-in, referral bind, faucet drip, episode
 * watch URL) is authorised by a signature over:
 *
 *   EIP712Domain(string name,string version)
 *   PoPoAuth(string action,address wallet,uint256 timestamp,string payload)
 *
 *   name    = realm ("PoPo.meme", or "PoPo.meme Affiliate" for affiliate)
 *   version = "1"
 *   payload = canonical JSON, object keys sorted alphabetically
 *   timestamp = milliseconds since epoch, must be within ±10 minutes
 *
 * The edge functions recover the signer with plain `ecrecover`, which is why a
 * ZeroDev smart account cannot sign these writes: the off-chain identity stays
 * the owner EOA (see docs/identity-model.md).
 */

import {
  encodeAbiParameters,
  keccak256,
  pad,
  stringToHex,
  toHex,
  type Hex,
  type TypedDataDomain,
} from "viem"
import type { Address } from "./base"

export const DEFAULT_REALM = "PoPo.meme"
export const AFFILIATE_REALM = "PoPo.meme Affiliate"
export const DOMAIN_VERSION = "1"
export const PRIMARY_TYPE = "PoPoAuth" as const
export const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000

export const AUTH_TYPES = {
  PoPoAuth: [
    { name: "action", type: "string" },
    { name: "wallet", type: "address" },
    { name: "timestamp", type: "uint256" },
    { name: "payload", type: "string" },
  ],
} as const

const DOMAIN_TYPESTRING = "EIP712Domain(string name,string version)"
const DOMAIN_WITH_CHAIN_TYPESTRING =
  "EIP712Domain(string name,string version,uint256 chainId)"
const AUTH_TYPESTRING =
  "PoPoAuth(string action,address wallet,uint256 timestamp,string payload)"

const DOMAIN_TYPEHASH = keccak256(stringToHex(DOMAIN_TYPESTRING))
const DOMAIN_WITH_CHAIN_TYPEHASH = keccak256(stringToHex(DOMAIN_WITH_CHAIN_TYPESTRING))
const AUTH_TYPEHASH = keccak256(stringToHex(AUTH_TYPESTRING))

/** Deterministic JSON: keys sorted alphabetically, matching the edge function. */
export function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload ?? {}, Object.keys(payload ?? {}).sort())
}

export interface AuthInput {
  action: string
  address: Address
  timestampMs: number
  payload?: Record<string, unknown>
  realm?: string
  /** Only send this when the edge function explicitly expects it (faucet). */
  domainChainId?: number
}

/** The exact typed-data the wallet signs. */
export function authTypedData(input: AuthInput): {
  domain: TypedDataDomain
  types: typeof AUTH_TYPES
  primaryType: typeof PRIMARY_TYPE
  message: { action: string; wallet: Address; timestamp: bigint; payload: string }
} {
  const realm = input.realm ?? DEFAULT_REALM
  return {
    domain:
      input.domainChainId === undefined
        ? { name: realm, version: DOMAIN_VERSION }
        : { name: realm, version: DOMAIN_VERSION, chainId: input.domainChainId },
    types: AUTH_TYPES,
    primaryType: PRIMARY_TYPE,
    message: {
      action: input.action,
      wallet: input.address,
      timestamp: BigInt(input.timestampMs),
      payload: canonicalJson(input.payload ?? {}),
    },
  }
}

/**
 * Hand-rolled digest, mirroring the edge implementation step by step.
 * `hashTypedData(authTypedData(x))` must equal this — asserted in the tests so
 * a drift in either direction is caught immediately.
 */
export function authDigest(input: AuthInput): Hex {
  const realm = input.realm ?? DEFAULT_REALM
  const domainSeparator =
    input.domainChainId === undefined
      ? keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
            [
              DOMAIN_TYPEHASH,
              keccak256(stringToHex(realm)),
              keccak256(stringToHex(DOMAIN_VERSION)),
            ],
          ),
        )
      : keccak256(
          encodeAbiParameters(
            [
              { type: "bytes32" },
              { type: "bytes32" },
              { type: "bytes32" },
              { type: "uint256" },
            ],
            [
              DOMAIN_WITH_CHAIN_TYPEHASH,
              keccak256(stringToHex(realm)),
              keccak256(stringToHex(DOMAIN_VERSION)),
              BigInt(input.domainChainId),
            ],
          ),
        )

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        AUTH_TYPEHASH,
        keccak256(stringToHex(input.action)),
        input.address,
        BigInt(input.timestampMs),
        keccak256(stringToHex(canonicalJson(input.payload ?? {}))),
      ],
    ),
  )

  return keccak256(
    `0x1901${domainSplit(domainSeparator)}${domainSplit(structHash)}` as Hex,
  )
}

function domainSplit(value: Hex): string {
  return value.slice(2)
}

/** Left-padded 32-byte word for an address (kept for parity tests). */
export function addressWord(address: Address): Hex {
  return pad(address, { size: 32 })
}

export function uintWord(value: bigint): Hex {
  return toHex(value, { size: 32 })
}
