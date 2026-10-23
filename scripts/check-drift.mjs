#!/usr/bin/env node
/**
 * Drift guard: fail when this repo's chain registry or ABIs no longer match
 * pp-all. Runs in CI so a contract redeploy can never silently point the skill at
 * a retired diamond.
 *
 *   node scripts/check-drift.mjs [--pp-all <path>]
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")

const argIndex = process.argv.indexOf("--pp-all")
const ppAll =
  argIndex > -1
    ? resolve(process.argv[argIndex + 1])
    : process.env.PP_ALL_PATH ?? resolve(root, "../pp-all")

const problems = []
const notes = []

function sha(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/* ---------------------------------------------------------------- ABIs */

for (const file of ["PoPoApp.json", "USDPApp.json"]) {
  const upstream = join(ppAll, "app/src/abis", file)
  const local = join(root, "src/core/abi", file)
  if (!existsSync(upstream)) {
    notes.push(`pp-all ABI not found (${upstream}) — skipped ${file}`)
    continue
  }
  if (sha(upstream) !== sha(local)) {
    problems.push(
      `ABI drift: src/core/abi/${file} differs from pp-all/app/src/abis/${file}\n  fix: npm run sync:abis`,
    )
  }
}

/* -------------------------------------------------------------- chains */

const registryPath = join(ppAll, "app/src/lib/contracts-registry.ts")
const chainsPath = join(root, "src/core/chains.ts")

if (!existsSync(registryPath)) {
  notes.push(`pp-all registry not found (${registryPath}) — skipped chain checks`)
} else {
  const upstream = readFileSync(registryPath, "utf8")
  const local = readFileSync(chainsPath, "utf8")

  // Every address we ship must exist verbatim in the upstream registry.
  // ENTRY_POINT_V07 is a protocol constant (ERC-4337), not a PoPo deployment.
  const PROTOCOL_ADDRESSES = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x0000000071727de22e5e9d8baf0edac6f37da032",
  ])
  const addresses = [...local.matchAll(/"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1])
  for (const address of new Set(addresses)) {
    if (PROTOCOL_ADDRESSES.has(address.toLowerCase())) continue
    if (!upstream.toLowerCase().includes(address.toLowerCase())) {
      problems.push(`chain drift: ${address} in src/core/chains.ts is not in pp-all's registry`)
    }
  }

  // The two phase-1 chains must still be present upstream.
  for (const chainId of [421614, 46630]) {
    if (!new RegExp(`(^|\\s)${chainId}:\\s*\\{`).test(upstream)) {
      problems.push(`chain drift: pp-all no longer defines chainId ${chainId}`)
    }
  }
}

/* --------------------------------------------------------------- print */

for (const note of notes) console.log(`• ${note}`)
if (problems.length === 0) {
  console.log("✔ no drift: ABIs and chain registry match pp-all")
  process.exit(0)
}
for (const problem of problems) console.error(`✖ ${problem}`)
process.exit(1)
