/**
 * Shared helpers for goupil's functions: auth, SSRF guard, and the Camoufox
 * worker invocation. Lives outside netlify/functions/ so it never becomes an
 * endpoint itself.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { timingSafeEqual, createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const execFileAsync = promisify(execFile)

// ── SSRF guard ──────────────────────────────────────────────────────────────
// The endpoints are key-gated, but a public URL-fetching service must refuse
// to reach internal/reserved addresses on its own (defense in depth):
// loopback, RFC1918, link-local (cloud metadata), CGNAT, ULA — including
// hostnames that merely RESOLVE there, and obscured IPv4 literals.

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
    const [a, b] = parts
    if (a === 0) return true
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (version === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateOrReservedIp(mapped[1])
    return false
  }
  return true
}

function isObscuredIpv4Literal(hostname: string): boolean {
  if (isIP(hostname)) return false
  const parts = hostname.split('.')
  if (parts.length === 0 || parts.length > 4) return false
  return parts.every((p) => /^0x[0-9a-f]+$/i.test(p) || /^0[0-7]+$/.test(p) || /^[0-9]+$/.test(p))
}

export async function isSafeUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    )
      return false

    const bareHost =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    if (isObscuredIpv4Literal(bareHost)) return false
    if (isIP(bareHost)) return !isPrivateOrReservedIp(bareHost)

    const records = await lookup(bareHost, { all: true })
    if (records.length === 0) return false
    return !records.some((record) => isPrivateOrReservedIp(record.address))
  } catch {
    return false
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Hash both sides so timingSafeEqual gets equal-length buffers regardless of
// what the caller sent.
export function keyMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** 401/503 when auth fails or isn't configured; null when the request may proceed. */
export function checkAuth(req: Request): Response | null {
  const apiKey = process.env.API_KEY
  if (!apiKey) return Response.json({ error: 'service_not_configured' }, { status: 503 })
  if (!keyMatches(req.headers.get('x-api-key') ?? '', apiKey)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

// ── Camoufox worker ─────────────────────────────────────────────────────────
// The worker is shipped via netlify.toml `included_files`; depending on the
// bundling layout it sits relative to the function file or to the runtime cwd.
function resolveWorkerPath(): string | null {
  const candidates = [
    join(process.cwd(), 'scripts', 'camoufox-fetch.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), '../../scripts/camoufox-fetch.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), 'scripts/camoufox-fetch.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type WorkerResult = { html: string } | { error: string; status: number }

/** Render `url` in Camoufox and return the final HTML (or a typed error). */
export async function renderPage(url: string): Promise<WorkerResult> {
  const workerPath = resolveWorkerPath()
  if (!workerPath) return { error: 'worker_missing', status: 500 }
  try {
    const { stdout } = await execFileAsync('node', [workerPath, url], {
      timeout: 85_000,
      maxBuffer: 10 * 1024 * 1024,
      // Lambda: only /tmp is writable. camoufox-js resolves its cache
      // (browser download, addons) under $HOME/.cache — point it there.
      env: { ...process.env, HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache' },
    })
    const result = JSON.parse(stdout) as { html?: string; error?: string }
    if (result.error || typeof result.html !== 'string') {
      return { error: result.error ?? 'no html', status: 502 }
    }
    return { html: result.html }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 502 }
  }
}
