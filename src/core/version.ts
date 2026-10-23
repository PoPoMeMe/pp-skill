/** Single source for the version string (package.json is inlined at build time). */
import pkg from "../../package.json" with { type: "json" }

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0"
