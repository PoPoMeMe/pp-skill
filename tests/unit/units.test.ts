import { describe, expect, it } from "vitest"
import { PopoError, bpsOf, formatP, formatUnits, parseP, shortAddr } from "../../src/core/base"
import { getChain, listChains, explorerTx } from "../../src/core/chains"
import { tickForPercent } from "../../src/modules/hatch"

describe("$P units", () => {
  it("parses and formats 18-decimal amounts", () => {
    expect(parseP("1")).toBe(10n ** 18n)
    expect(parseP("0.5")).toBe(5n * 10n ** 17n)
    expect(parseP("123.456789012345678901")).toBe(123456789012345678901n)
    expect(formatP(parseP("10"))).toBe("10")
    expect(formatP(parseP("1.5"))).toBe("1.5")
    expect(formatP(parseP("0.0001"))).toBe("0.0001")
    expect(formatUnits(123456789n, 6, 4)).toBe("123.4567")
  })

  it("rejects malformed amounts instead of guessing", () => {
    for (const bad of ["", ".", "1,5", "-1", "1e18", "abc"]) {
      expect(() => parseP(bad)).toThrow(PopoError)
    }
  })

  it("applies bps guards without losing precision", () => {
    expect(bpsOf(10_000n, 9900)).toBe(9_900n)
    expect(bpsOf(1n, 5000)).toBe(0n)
  })

  it("shortens addresses for display only", () => {
    expect(shortAddr("0xCA1E405289335507782ad322d67916e7517953C2")).toBe("0xCA1E…53C2")
    expect(shortAddr("0x123")).toBe("0x123")
  })
})

describe("chain registry", () => {
  it("ships exactly the two phase-1 chains", () => {
    expect(listChains().map((c) => c.chainId).sort()).toEqual([421614, 46630])
  })

  it("resolves by id, key and label", () => {
    expect(getChain(421614).key).toBe("arbitrumSepolia")
    expect(getChain("46630").key).toBe("robinhoodTestnet")
    expect(getChain("robinhoodTestnet").chainId).toBe(46630)
    expect(getChain("Robinhood Chain Testnet").chainId).toBe(46630)
  })

  it("refuses unsupported chains with a helpful hint", () => {
    try {
      getChain(10143)
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(PopoError)
      expect((error as PopoError).code).toBe("unsupported_chain")
      expect((error as PopoError).hint).toContain("421614")
    }
  })

  it("builds explorer links per chain", () => {
    expect(explorerTx(getChain(421614), "0xabc")).toBe("https://sepolia.arbiscan.io/tx/0xabc")
  })

  it("uses quoteId 1 and 18-decimal $P everywhere", () => {
    for (const chain of listChains()) {
      expect(chain.quoteId).toBe(1n)
      expect(chain.contracts.diamond.startsWith("0x")).toBe(true)
      expect(chain.contracts.usdp.startsWith("0x")).toBe(true)
    }
  })
})

describe("tick math", () => {
  it("maps a ±20% price move to roughly 1823 ticks", () => {
    const ticks = tickForPercent(0, 20) - 0
    expect(Math.abs(ticks - 1823)).toBeLessThan(3)
  })

  it("is symmetric around a non-zero current tick", () => {
    expect(tickForPercent(1000, 20)).toBe(1000 + tickForPercent(0, 20))
  })
})
