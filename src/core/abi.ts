/**
 * ABI surface.
 *
 * `PoPoApp.json` / `USDPApp.json` are copied verbatim from pp-all
 * (app/src/abis). They are the merged Diamond ABIs — 210 functions across
 * 19 facets — so the toolkit can call anything the web app can.
 *
 * Do not hand-edit them: `npm run sync:abis` copies from pp-all and
 * `npm run check:drift` fails CI when the copies go stale.
 */

import type { Abi } from "viem"
import PoPoAppJson from "./abi/PoPoApp.json" with { type: "json" }
import USDPAppJson from "./abi/USDPApp.json" with { type: "json" }

export const POPO_ABI = PoPoAppJson as unknown as Abi
export const USDP_ABI = USDPAppJson as unknown as Abi

/**
 * `canCall` lives on the AccessControl facet and is missing from the exported
 * merged artifact (same gap pp-all works around), so declare it here.
 */
export const ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "canCall",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "functionSig", type: "bytes4" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "functionRoles",
    stateMutability: "view",
    inputs: [{ name: "functionSig", type: "bytes4" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const

/** ERC20 reads that the merged Diamond ABI does not expose by name. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const

export const ERC6909_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isOperator",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

/** Function names present in the merged ABI (used by `popo call` validation). */
export function abiFunctionNames(): string[] {
  return [
    ...new Set(
      POPO_ABI.filter((item) => item.type === "function").map((item) => item.name),
    ),
  ].sort()
}

export function findAbiFunction(name: string) {
  const candidates = POPO_ABI.filter(
    (item) => item.type === "function" && item.name === name,
  )
  if (candidates.length === 0) return null
  return candidates[0] ?? null
}
