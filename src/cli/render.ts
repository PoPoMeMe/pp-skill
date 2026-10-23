/** Output layer: pretty for humans in a TTY, pure JSON for agents/pipes. */

import { PopoError, formatP } from "../core/base"

export interface OutputOptions {
  json: boolean
  color: boolean
}

export function outputOptions(argv: { json?: boolean } = {}): OutputOptions {
  const json = Boolean(argv.json) || !process.stdout.isTTY
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
  return { json, color }
}

const c = {
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
}

/** JSON.stringify with BigInt → decimal string, so no payload ever throws. */
export function jsonStringify(value: unknown, space = 2): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    space,
  )
}

function paint(opts: OutputOptions, fn: (s: string) => string, text: string): string {
  return opts.color ? fn(text) : text
}

/** Emit a result: JSON envelope when piped, human block in a TTY. */
export function emit(
  opts: OutputOptions,
  payload: Record<string, unknown>,
  lines: string[] = [],
  title?: string,
): void {
  if (opts.json) {
    process.stdout.write(`${jsonStringify({ ok: true, ...payload })}\n`)
    return
  }
  if (title) process.stdout.write(`${paint(opts, c.bold, title)}\n`)
  for (const line of lines) process.stdout.write(`${line}\n`)
  const extra = { ...payload }
  delete extra.ok
  if (Object.keys(extra).length > 0 && lines.length === 0) {
    process.stdout.write(`${jsonStringify(extra)}\n`)
  }
}

export function fail(opts: OutputOptions, error: unknown): void {
  const err =
    error instanceof PopoError
      ? error
      : new PopoError("internal", (error as Error)?.message ?? String(error))
  if (opts.json) {
    process.stdout.write(`${jsonStringify(err.toJSON())}\n`)
  } else {
    process.stderr.write(`${paint(opts, c.red, `✖ ${err.code}`)} ${err.message}\n`)
    if (err.hint) process.stderr.write(`${paint(opts, c.dim, `  hint: ${err.hint}`)}\n`)
  }
  process.exitCode = err.exitCode
}

export function table(rows: string[][], headers: string[]): string[] {
  if (rows.length === 0) return ["(no rows)"]
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  )
  const line = (cells: string[]) =>
    cells.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd()
  return [line(headers), ...rows.map(line)]
}

export function kv(pairs: [string, unknown][]): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length))
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v === null || v === undefined ? "—" : String(v)}`)
}

export function money(value: bigint | string, suffix = "$P"): string {
  const asBig = typeof value === "string" ? BigInt(value) : value
  return `${formatP(asBig)} ${suffix}`
}

export { c }
