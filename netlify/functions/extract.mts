/**
 * POST /extract  { url, rules?, profile?, auto?, engine? }  →  { auto, data? }
 *
 * Façade Netlify de l'extraction déterministe (sans LLM, zéro coût par appel).
 * Toute la logique d'extraction vit dans lib/extraction.mts, partagée avec le
 * serveur conteneurisé (server.mjs) — une seule implémentation, deux hôtes.
 *
 * ⚠️ Sur Netlify, seuls les moteurs `plain` et `impit` aboutissent : le
 * navigateur Camoufox (663 Mo) ne tient pas dans le /tmp d'une Lambda
 * (512 Mo). Le moteur `browser` exige l'hôte conteneurisé.
 */
import { checkAuth, isSafeUrl, isEngine, fetchWithEngine } from '../lib/common.mts'
import { extractFromHtml, validateExtractionRequest } from '../lib/extraction.mts'

export const config = { path: '/extract' }

// Ré-export pour les scripts de test qui importent depuis ce module.
export {
  extractMetas,
  extractJsonLd,
  extractImages,
  applyRule,
  resolveField,
} from '../lib/extraction.mts'

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  }
  const denied = checkAuth(req)
  if (denied) return denied

  let url: unknown
  let profile: unknown
  let rules: unknown
  let autoParam: unknown
  let engine: unknown
  try {
    ;({ url, profile, rules, auto: autoParam, engine } = await req.json())
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (typeof url !== 'string' || url.length > 2048 || !(await isSafeUrl(url))) {
    return Response.json({ error: 'invalid_url' }, { status: 400 })
  }
  if (engine !== undefined && !isEngine(engine)) {
    return Response.json({ error: 'invalid_engine' }, { status: 400 })
  }
  // Refuser une requête malformée AVANT de payer un fetch réseau.
  const invalid = validateExtractionRequest({ rules, profile })
  if (invalid) return Response.json(invalid.body, { status: invalid.status })

  const rendered = await fetchWithEngine(isEngine(engine) ? engine : 'browser', url)
  if ('error' in rendered) {
    return Response.json(
      { error: 'fetch_failed', detail: rendered.error },
      { status: rendered.status }
    )
  }

  const result = extractFromHtml(rendered.html, { rules, profile, auto: autoParam })
  if ('error' in result) return Response.json(result.body, { status: result.status })
  return Response.json(result.body)
}
