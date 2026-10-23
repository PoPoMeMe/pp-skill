import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: true,
    splitting: false,
    sourcemap: true,
    dts: false,
  },
  {
    entry: { mcp: "src/mcp/server.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: false,
  },
  {
    entry: { ui: "src/tui/main.tsx" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: false,
  },
])
