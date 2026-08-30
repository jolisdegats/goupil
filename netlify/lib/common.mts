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

/**
 * Transport-agnostic auth: takes the raw header value, returns the refusal to
 * send (or null to proceed). Shared by the Netlify functions and server.mjs.
 */
export function checkAuthHeaders(
  given: string | string[] | undefined
): { status: number; body: Record<string, unknown> } | null {
  const apiKey = process.env.API_KEY
  if (!apiKey) return { status: 503, body: { error: 'service_not_configured' } }
  const value = Array.isArray(given) ? (given[0] ?? '') : (given ?? '')
  if (!keyMatches(value, apiKey)) return { status: 401, body: { error: 'unauthorized' } }
  return null
}

/** 401/503 when auth fails or isn't configured; null when the request may proceed. */
export function checkAuth(req: Request): Response | null {
  const denied = checkAuthHeaders(req.headers.get('x-api-key') ?? undefined)
  return denied ? Response.json(denied.body, { status: denied.status }) : null
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

/**
 * Plain HTTPS fetch — no browser at all. Sufficient whenever the target ships
 * its structured data (JSON-LD / OpenGraph) in the initial HTML, and the only
 * engine with no infrastructure constraints. Camoufox stays the heavy option
 * for JS-only pages — on hosts whose disk can actually hold it.
 */
export async function plainFetch(url: string): Promise<WorkerResult> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    })
    if (!res.ok) return { error: `http_${res.status}`, status: 502 }
    return { html: await res.text() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 502 }
  }
}

/**
 * impit fetch — Chrome TLS impersonation WITHOUT a browser (Rust bindings, a
 * few MB: serverless-friendly). The middle engine: gets past TLS-fingerprint
 * walls that 429 Node's native fetch, with none of Camoufox's disk footprint.
 * Kept identical to the call proven from AWS IPs in production elsewhere.
 */
export async function impitFetch(url: string): Promise<WorkerResult> {
  try {
    const { Impit } = await import('impit')
    const impit = new Impit({ browser: 'chrome' })
    const res = await impit.fetch(url)
    if (!res.ok) return { error: `http_${res.status}`, status: 502 }
    return { html: await res.text() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 502 }
  }
}

/**
 * Fetch en se présentant comme le crawler d'aperçu de liens de Facebook.
 *
 * Ce n'est pas un déguisement gratuit : les sites SERVENT VOLONTAIREMENT leurs
 * métadonnées (OpenGraph, JSON-LD) à ces robots — c'est ainsi que se
 * fabriquent les vignettes partagées sur les réseaux. Mesuré : Booking.com
 * répond 200 avec sa fiche complète (JSON-LD Hotel + og:image) là où il sert
 * une coquille vide à un fetch ordinaire, et sans aucun navigateur.
 *
 * Le moteur le moins cher qui obtient de vraies données : pas de navigateur,
 * pas de contrainte de disque, quelques centaines de millisecondes.
 */
export async function socialFetch(url: string): Promise<WorkerResult> {
  try {
    const { Impit } = await import('impit')
    const impit = new Impit({ browser: 'chrome' })
    const res = await impit.fetch(url, {
      headers: {
        'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    })
    if (!res.ok) return { error: `http_${res.status}`, status: 502 }
    return { html: await res.text() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 502 }
  }
}

/**
 * Fetch délégué à un service tiers (ScraperAPI) qui gère lui-même les proxies
 * résidentiels rotatifs et les challenges anti-bot.
 *
 * Seule voie connue vers les cibles qui refusent toute IP datacenter (Expedia
 * et son Akamai Bot Manager : 429 « Robot ou pas robot » sur le domaine
 * entier, navigateur furtif compris). On n'imite rien nous-mêmes : le
 * prestataire opère sous ses propres conditions et c'est lui qui détient
 * l'infrastructure d'IP.
 *
 * COÛTEUX EN CRÉDITS (une page protégée peut valoir 25-75 crédits sur un quota
 * gratuit de 1000/mois) → à n'appeler qu'en DERNIER recours ; la chaîne `auto`
 * le place après tous les moteurs gratuits. Inerte sans SCRAPERAPI_KEY.
 */
export async function managedFetch(url: string): Promise<WorkerResult> {
  const key = process.env.SCRAPERAPI_KEY
  if (!key) return { error: 'managed_not_configured', status: 502 }
  const endpoint = new URL('https://api.scraperapi.com/')
  endpoint.searchParams.set('api_key', key)
  endpoint.searchParams.set('url', url)
  endpoint.searchParams.set('render', 'true')
  // ultra_premium = proxies résidentiels + résolution des challenges : le seul
  // niveau qui passe Akamai. C'est aussi le plus cher en crédits.
  endpoint.searchParams.set('ultra_premium', 'true')
  endpoint.searchParams.set('country_code', 'fr')
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(90_000) })
    if (!res.ok) return { error: `managed_http_${res.status}`, status: 502 }
    return { html: await res.text() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 502 }
  }
}

// ── Engine dispatch ─────────────────────────────────────────────────────────

export const ENGINES = ['auto', 'browser', 'plain', 'impit', 'social', 'managed'] as const
export type Engine = (typeof ENGINES)[number]

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value)
}

/** Un résultat vide de données utiles ne vaut pas mieux qu'une erreur. */
function looksBlocked(html: string): boolean {
  if (/robot ou pas robot|bot or not|are you a robot|px-captcha|unusual traffic/i.test(html.slice(0, 200_000)))
    return true
  // Ni schema.org d'hébergement, ni og:title → rien à extraire.
  const hasJsonLd = /application\/ld\+json/i.test(html)
  const hasOg = /property=["']og:(title|image)["']/i.test(html)
  return !hasJsonLd && !hasOg
}

/**
 * Chaîne `auto` : du moins cher au plus cher, on s'arrête au premier moteur
 * qui rend des données exploitables. Sans navigateur d'abord (quelques
 * centaines de ms), navigateur en dernier recours — et seulement là où il est
 * installable.
 */
export async function autoFetch(url: string): Promise<WorkerResult> {
  const chain: Array<[Engine, (u: string) => Promise<WorkerResult>]> = [
    ['social', socialFetch],
    ['impit', impitFetch],
    ['plain', plainFetch],
  ]
  // Le navigateur ne tourne que là où il est installable (conteneur/VM) : sur
  // une Lambda il échouerait après un long téléchargement inutile. Opt-in.
  if (process.env.GOUPIL_BROWSER === '1') chain.push(['browser', renderPage])
  // Dernier recours seulement : chaque appel consomme des crédits payants.
  if (process.env.SCRAPERAPI_KEY) chain.push(['managed', managedFetch])

  let lastError = 'no_engine_succeeded'
  for (const [name, fetcher] of chain) {
    const result = await fetcher(url)
    if ('error' in result) {
      lastError = `${name}: ${result.error}`
      continue
    }
    if (looksBlocked(result.html)) {
      lastError = `${name}: blocked_or_empty`
      continue
    }
    console.log(`[goupil] auto → ${name} a réussi`)
    return result
  }
  return { error: lastError, status: 502 }
}

export async function fetchWithEngine(engine: Engine, url: string): Promise<WorkerResult> {
  if (engine === 'auto') return autoFetch(url)
  if (engine === 'plain') return plainFetch(url)
  if (engine === 'impit') return impitFetch(url)
  if (engine === 'social') return socialFetch(url)
  if (engine === 'managed') return managedFetch(url)
  return renderPage(url)
}
