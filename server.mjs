#!/usr/bin/env node
/**
 * goupil — serveur HTTP conteneurisé.
 *
 * Même API que les Netlify Functions (POST /fetch, POST /extract), mais dans
 * un conteneur où le navigateur Camoufox est réellement installable : c'est
 * l'hôte qui débloque le moteur `browser` (Netlify Functions ne le peut pas,
 * /tmp plafonné à 512 Mo contre 663 Mo d'archive).
 *
 * Écoute sur $PORT (Render le fournit). GET / = healthcheck non authentifié.
 */
import { createServer } from 'node:http'
import { checkAuthHeaders, isSafeUrl, isEngine, fetchWithEngine } from './netlify/lib/common.mts'
import { extractFromHtml } from './netlify/lib/extraction.mts'

const PORT = Number(process.env.PORT ?? 8080)
const MAX_BODY = 256 * 1024

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid_body'))
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]

  // Healthcheck (Render ping cette route ; pas d'auth pour ne pas la casser).
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return send(res, 200, { service: 'goupil', ok: true, engines: ['browser', 'plain', 'impit'] })
  }
  if (path !== '/fetch' && path !== '/extract') {
    return send(res, 404, { error: 'not_found' })
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method_not_allowed' })
  }

  const denied = checkAuthHeaders(req.headers['x-api-key'])
  if (denied) return send(res, denied.status, denied.body)

  let payload
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

  const rendered = await fetchWithEngine(isEngine(engine) ? engine : 'browser', url)
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
