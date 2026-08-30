#!/usr/bin/env node
/**
 * goupil — serveur HTTP conteneurisé.
 *
 * Même API que les Netlify Functions (POST /fetch, POST /extract), mais dans
 * un conteneur où le navigateur Camoufox est réellement installable : c'est
 * l'hôte qui débloque le moteur `browser` (une Netlify Function ne le peut
 * pas, /tmp plafonné à 512 Mo contre 663 Mo d'archive).
 *
 * Écoute sur $PORT (fourni par Render & co). GET / = healthcheck non
 * authentifié — la plateforme doit pouvoir le pinger sans clé.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { checkAuthHeaders, isSafeUrl, isEngine, fetchWithEngine, ENGINES } from './netlify/lib/common.mts'
import { extractFromHtml, validateExtractionRequest } from './netlify/lib/extraction.mts'

const PORT = Number(process.env.PORT ?? 8080)
const MAX_BODY = 256 * 1024

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid_body'))
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? '/').split('?')[0]

  // Healthcheck (la plateforme ping cette route ; pas d'auth pour ne pas la
  // casser, et rien de sensible dedans).
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return send(res, 200, { service: 'goupil', ok: true, engines: [...ENGINES] })
  }
  if (path !== '/fetch' && path !== '/extract') {
    return send(res, 404, { error: 'not_found' })
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method_not_allowed' })
  }

  const denied = checkAuthHeaders(req.headers['x-api-key'])
  if (denied) return send(res, denied.status, denied.body)

  let payload: Record<string, unknown>
  try {
    payload = await readJson(req)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invalid_body'
    return send(res, 400, { error: reason === 'body_too_large' ? 'body_too_large' : 'invalid_body' })
  }

  const { url, rules, profile, auto, engine } = payload ?? {}
  if (typeof url !== 'string' || url.length > 2048 || !(await isSafeUrl(url))) {
    return send(res, 400, { error: 'invalid_url' })
  }
  if (engine !== undefined && !isEngine(engine)) {
    return send(res, 400, { error: 'invalid_engine' })
  }
  // Refuser une requête malformée AVANT de payer un fetch réseau.
  const invalid = validateExtractionRequest({ rules, profile })
  if (invalid) return send(res, invalid.status, invalid.body)

  const rendered = await fetchWithEngine(isEngine(engine) ? engine : 'auto', url)
  if ('error' in rendered) {
    console.error('[goupil] fetch failed:', rendered.error)
    return send(res, rendered.status, { error: 'fetch_failed', detail: rendered.error })
  }

  if (path === '/fetch') return send(res, 200, { html: rendered.html })

  const result = extractFromHtml(rendered.html, { rules, profile, auto })
  if ('error' in result) return send(res, result.status, result.body)
  return send(res, 200, result.body)
})

server.headersTimeout = 120_000
server.requestTimeout = 120_000
server.listen(PORT, () => console.log(`[goupil] listening on :${PORT}`))
