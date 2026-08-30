/**
 * Test hors-service des moteurs sans navigateur (`plain`, `impit`) : fetch
 * d'une URL réelle depuis le runner CI, puis extraction avec le VRAI code du
 * service (extracteurs de extract.mts + profil lodging). Aucune clé API —
 * on n'appelle pas le service déployé, on exécute son code.
 *
 * Répond à DEUX questions : le site accepte-t-il la requête depuis une IP
 * datacenter (et l'empreinte TLS Chrome d'impit change-t-elle la donne ?),
 * et la page livre-t-elle sa donnée structurée sans rendu JavaScript ?
 *
 *   npm ci && npx tsx .github/scripts/test-engines.mts <url>
 *
 * Sort en 0 si AU MOINS un moteur résout un nom via le profil lodging,
 * en 1 si aucun (site bloqué ou page vide sans JS → moteur browser requis).
 */
import { plainFetch, impitFetch } from '../../netlify/lib/common.mts'
import {
  extractMetas,
  extractJsonLd,
  extractImages,
  resolveField,
} from '../../netlify/functions/extract.mts'
import { PROFILES } from '../../netlify/lib/profiles.mts'

const url = process.argv[2]
if (!url) {
  console.error('usage: tsx test-engines.mts <url>')
  process.exit(2)
}
console.log(`URL : ${url}`)

const engines = { plain: plainFetch, impit: impitFetch } as const
const ruleEntries = Object.entries(PROFILES.lodging).filter(([f]) => !f.startsWith('$'))
const passed: string[] = []

for (const [name, doFetch] of Object.entries(engines)) {
  console.log(`\n════════ moteur ${name} ════════`)
  const t0 = Date.now()
  const fetched = await doFetch(url)
  if ('error' in fetched) {
    console.log(`fetch KO après ${Date.now() - t0} ms : ${fetched.error}`)
    continue
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
  console.log(`meta   : ${Object.keys(meta).length} balises, dont og:* = ${ogKeys.length} [${ogKeys.slice(0, 8).join(', ')}]`)
  console.log(`jsonld : ${jsonld.length} nœuds, @type = ${JSON.stringify(types)}`)
  console.log(`images : ${images.length} URLs${images.length ? ` (1re : ${images[0]})` : ''}`)

  const data: Record<string, unknown> = {}
  for (const [field, chain] of ruleEntries) {
    data[field] = resolveField(chain as never, html, { meta, jsonld }) ?? null
  }
  console.log('── data (profil lodging) ──')
  console.log(JSON.stringify(data, null, 2))
  const resolved = Object.entries(data).filter(([, v]) => v !== null)
  console.log(`→ ${resolved.length}/${ruleEntries.length} champs résolus : ${resolved.map(([f]) => f).join(', ') || '(aucun)'}`)

  if (data.name != null) {
    console.log(`moteur ${name} : PASS`)
    passed.push(name)
  } else {
    console.log(`moteur ${name} : FAIL (pas même un nom — page bloquée ou vide sans JavaScript)`)
  }
}

console.log('\n════════ verdict ════════')
if (passed.length === 0) {
  console.log('FAIL — aucun moteur sans navigateur ne suffit pour cette page depuis une IP datacenter')
  process.exit(1)
}
console.log(`PASS — moteur(s) suffisant(s) : ${passed.join(', ')}`)
