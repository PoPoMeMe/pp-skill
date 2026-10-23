#!/usr/bin/env node
/**
 * Copy the Diamond ABIs from pp-all (the single source of truth).
 *
 *   node scripts/sync-abis.mjs [--pp-all <path>]
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")

const argIndex = process.argv.indexOf("--pp-all")
const ppAll =
  argIndex > -1
    ? resolve(process.argv[argIndex + 1])
    : process.env.PP_ALL_PATH ?? resolve(root, "../pp-all")

const files = ["PoPoApp.json", "USDPApp.json"]
const src = join(ppAll, "app/src/abis")
const dest = join(root, "src/core/abi")

if (!existsSync(src)) {
  console.error(`✖ cannot find ${src} (pass --pp-all <path>)`)
  process.exit(1)
}

mkdirSync(dest, { recursive: true })
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file))
  console.log(`✔ synced ${file}`)
}
console.log("\nNext: npm run typecheck && npm run test")
