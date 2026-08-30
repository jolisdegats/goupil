/**
 * Test hors-service du moteur `plain` : fetch HTTP simple d'une URL réelle
 * depuis le runner CI, puis extraction avec le VRAI code du service
 * (extracteurs de extract.mts + profil lodging). Aucune clé API requise —
 * on n'appelle pas le service déployé, on exécute son code.
 *
 * Répond à LA question : la page cible embarque-t-elle sa donnée structurée
 * (JSON-LD / OpenGraph) dans le HTML initial, sans rendu JavaScript ?
 *
 *   npx tsx .github/scripts/test-plain.mts <url>
 *
 * Sort en 0 si le profil lodging résout au moins un nom (donnée exploitable),
 * en 1 sinon (fetch bloqué ou page vide sans JS → il faut le moteur browser).
 */
import { plainFetch } from '../../netlify/lib/common.mts'
import {
  extractMetas,
  extractJsonLd,
  extractImages,
  resolveField,
} from '../../netlify/functions/extract.mts'
import { PROFILES } from '../../netlify/lib/profiles.mts'

const url = process.argv[2]
if (!url) {
  console.error('usage: tsx test-plain.mts <url>')
  process.exit(2)
}

console.log(`URL: ${url}`)
const t0 = Date.now()
const fetched = await plainFetch(url)
if ('error' in fetched) {
  console.log(`FETCH KO après ${Date.now() - t0} ms : ${fetched.error}`)
  console.log('VERDICT: FAIL — le fetch plain lui-même est refusé par le site')
  process.exit(1)
}
const { html } = fetched
console.log(`fetch OK : ${html.length} octets en ${Date.now() - t0} ms`)
const title = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim()
console.log(`<title> : ${title ?? '(absent)'}`)

const meta = extractMetas(html)
const jsonld = extractJsonLd(html)
const images = extractImages(html)
const ogKeys = Object.keys(meta).filter((k) => k.startsWith('og:'))
const types = jsonld
  .map((n) => (n as Record<string, unknown> | null)?.['@type'])
  .filter(Boolean)
  .slice(0, 12)

console.log(`meta      : ${Object.keys(meta).length} balises, dont og:* = ${ogKeys.length} [${ogKeys.slice(0, 8).join(', ')}]`)
console.log(`jsonld    : ${jsonld.length} nœuds, @type = ${JSON.stringify(types)}`)
console.log(`images    : ${images.length} URLs${images.length ? ` (1re : ${images[0]})` : ''}`)

const ruleEntries = Object.entries(PROFILES.lodging).filter(([f]) => !f.startsWith('$'))
const data: Record<string, unknown> = {}
for (const [field, chain] of ruleEntries) {
  data[field] = resolveField(chain as never, html, { meta, jsonld }) ?? null
}
console.log('── data (profil lodging) ──')
console.log(JSON.stringify(data, null, 2))

const resolved = Object.entries(data).filter(([, v]) => v !== null)
console.log(`→ ${resolved.length}/${ruleEntries.length} champs résolus : ${resolved.map(([f]) => f).join(', ') || '(aucun)'}`)

if (data.name == null) {
  console.log('VERDICT: FAIL — pas même un nom : cette page ne livre pas sa donnée sans JavaScript, il faut le moteur browser')
  process.exit(1)
}
console.log('VERDICT: PASS — le moteur plain suffit pour cette page')
