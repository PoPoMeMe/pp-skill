/**
 * Off-chain backend (Supabase).
 *
 * The key below is the project's *publishable* key — it ships inside the public
 * web bundle and is protected by RLS. There is no service-role key anywhere in
 * this repo, and every user write goes through an Edge Function that verifies a
 * PoPoAuth signature (see core/auth.ts).
 */

import { PopoError } from "./base"

export const SUPABASE_URL =
  process.env.POPO_SUPABASE_URL ?? "https://novxohcvvpoqcfkpsvcj.supabase.co"

export const SUPABASE_PUBLISHABLE_KEY =
  process.env.POPO_SUPABASE_KEY ?? "sb_publishable_A2-HZxZTl7BerXI0-dW9jg__1BaYK-T"

const TIMEOUT_MS = 25_000

async function request(
  url: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${init.bearer ?? SUPABASE_PUBLISHABLE_KEY}`,
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  }
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new PopoError("backend_error", `network error calling ${url}`, {
      details: (error as Error).message.slice(0, 200),
    })
  }
  const text = await res.text()
  const json = text ? safeJson(text) : null
  if (!res.ok) {
    const message =
      (json as { error?: string; message?: string })?.error ??
      (json as { message?: string })?.message ??
      `HTTP ${res.status}`
    throw new PopoError("backend_error", message, {
      details: { status: res.status, url: url.replace(SUPABASE_URL, "") },
    })
  }
  return json
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Call an Edge Function (`/functions/v1/<name>`). */
export async function edge<T>(
  name: string,
  body: Record<string, unknown> = {},
  opts: { method?: "GET" | "POST"; bearer?: string } = {},
): Promise<T> {
  const method = opts.method ?? "POST"
  const url = `${SUPABASE_URL}/functions/v1/${name}`
  const result = await request(url, {
    method,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    ...(opts.bearer ? { bearer: opts.bearer } : {}),
  })
  return result as T
}

/**
 * Read rows through PostgREST. Only tables with public SELECT policies work —
 * which covers token lists, trades, holders, episodes and market metadata.
 */
export async function select<T>(
  table: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const params = new URLSearchParams(query).toString()
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? `?${params}` : ""}`
  const result = await request(url, { method: "GET" })
  return Array.isArray(result) ? (result as T[]) : []
}

export async function first<T>(
  table: string,
  query: Record<string, string> = {},
): Promise<T | null> {
  const rows = await select<T>(table, { ...query, limit: "1" })
  return rows[0] ?? null
}
