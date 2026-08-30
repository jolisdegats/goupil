/**
 * POST /fetch  { "url": "https://…" }  →  { "html": "…" }
 *
 * Stealth browser fetch: renders the page in Camoufox (anti-bot Firefox) and
 * returns the final HTML. Knows nothing about any consuming app — callers do
 * their own parsing. For built-in deterministic extraction, see /extract.
 *
 * Auth: `x-api-key` header must match the API_KEY env var (fails closed when
 * API_KEY is unset). Errors: 401 bad key, 400 invalid/unsafe URL, 405 method,
 * 502 the browser fetch itself failed, 503 service not configured.
 */
import { checkAuth, isSafeUrl, renderPage, plainFetch } from '../lib/common.mts'

export const config = { path: '/fetch' }

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  }
  const denied = checkAuth(req)
  if (denied) return denied

  let url: unknown
  let engine: unknown
  try {
    ;({ url, engine } = await req.json())
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (typeof url !== 'string' || url.length > 2048 || !(await isSafeUrl(url))) {
    return Response.json({ error: 'invalid_url' }, { status: 400 })
  }

  if (engine !== undefined && engine !== 'browser' && engine !== 'plain') {
    return Response.json({ error: 'invalid_engine' }, { status: 400 })
  }
  const rendered = engine === 'plain' ? await plainFetch(url) : await renderPage(url)
  if ('error' in rendered) {
    console.error('[goupil] worker failed:', rendered.error)
    return Response.json({ error: 'fetch_failed', detail: rendered.error }, { status: rendered.status })
  }
  return Response.json({ html: rendered.html })
}
