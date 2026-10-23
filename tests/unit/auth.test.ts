import { describe, expect, it } from "vitest"
import { hashTypedData } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  AFFILIATE_REALM,
  authDigest,
  authTypedData,
  canonicalJson,
} from "../../src/core/auth"

const ADDRESS = "0xb81fcee70017317f79c169b3727193a786bfc88d" as const
const TS = 1_767_225_600_000

describe("PoPoAuth EIP-712", () => {
  it("hand-rolled digest matches viem's hashTypedData", () => {
    const input = {
      action: "testnet-faucet-claim",
      address: ADDRESS,
      timestampMs: TS,
      payload: { chainId: 421614 },
    }
    const typed = authTypedData(input)
    expect(hashTypedData(typed)).toBe(authDigest(input))
  })

  it("matches with domain.chainId (the Agent Wallet path)", () => {
    const input = {
      action: "testnet-faucet-claim",
      address: ADDRESS,
      timestampMs: TS,
      payload: { chainId: 46630 },
      domainChainId: 46630,
    }
    const typed = authTypedData(input)
    expect(typed.domain.chainId).toBe(46630)
    expect(hashTypedData(typed)).toBe(authDigest(input))
  })

  it("separates realms so an affiliate signature cannot authorise a main write", () => {
    const base = { action: "credit-checkin", address: ADDRESS, timestampMs: TS, payload: {} }
    expect(authDigest(base)).not.toBe(authDigest({ ...base, realm: AFFILIATE_REALM }))
  })

  it("is sensitive to every signed field", () => {
    const base = {
      action: "credit-checkin",
      address: ADDRESS,
      timestampMs: TS,
      payload: { a: 1 },
    }
    const digest = authDigest(base)
    expect(authDigest({ ...base, timestampMs: TS + 1 })).not.toBe(digest)
    expect(authDigest({ ...base, action: "other" })).not.toBe(digest)
    expect(authDigest({ ...base, payload: { a: 2 } })).not.toBe(digest)
    expect(authDigest({ ...base, payload: { a: 1, b: 2 } })).not.toBe(digest)
  })

  it("canonicalises payloads by sorted keys (edge parity)", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(canonicalJson({ chainId: 46630, tokenId: 7, episodeNo: 2 })).toBe(
      '{"chainId":46630,"episodeNo":2,"tokenId":7}',
    )
    expect(authDigest({
      action: "x",
      address: ADDRESS,
      timestampMs: TS,
      payload: { b: 2, a: 1 },
    })).toBe(
      authDigest({ action: "x", address: ADDRESS, timestampMs: TS, payload: { a: 1, b: 2 } }),
    )
  })

  it("recovers the signer address (the edge function's check)", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    )
    const input = {
      action: "credit-checkin",
      address: account.address,
      timestampMs: TS,
      payload: {},
    }
    const signature = await account.signTypedData(authTypedData(input))
    const recovered = await import("viem").then(({ recoverTypedDataAddress }) =>
      recoverTypedDataAddress({ ...authTypedData(input), signature }),
    )
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })
})
