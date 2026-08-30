/**
 * Test décisif du moteur `browser` (Camoufox) depuis une IP DATACENTER
 * (runner GitHub Actions = mêmes conditions réseau que Fly.io/Netlify/Vercel).
 *
 * Répond à LA question qui décide de tout le montage : le navigateur furtif
 * suffit-il à passer les gros OTA (Expedia/Booking) SANS proxy résidentiel,
 * ou la réputation de l'IP datacenter les bloque même avec Camoufox ?
 *
 *   HOME=/tmp XDG_CACHE_HOME=/tmp/.cache npx tsx .github/scripts/test-camoufox.mts <url>
 *
 * Réutilise le VRAI code de prod (renderPage → worker Camoufox + extracteurs).
 * Sort 0 si le profil lodging résout un nom, 1 sinon.
 */
import { renderPage } from '../../netlify/lib/common.mts'
import {
  extractMetas,
  extractJsonLd,
  extractImages,
  resolveField,
} from '../../netlify/functions/extract.mts'
import { PROFILES } from '../../netlify/lib/profiles.mts'

const url = process.argv[2]
if (!url) {
  console.error('usage: tsx test-camoufox.mts <url>')
  process.exit(2)
}
console.log(`URL : ${url}`)
console.log('moteur : browser (Camoufox, humanize) — IP du runner (datacenter)\n')

const t0 = Date.now()
const rendered = await renderPage(url)
const secs = ((Date.now() - t0) / 1000).toFixed(1)
if ('error' in rendered) {
  console.log(`RENDU KO après ${secs}s : ${rendered.error}`)
  console.log('VERDICT: FAIL — Camoufox lui-même n\'a pas pu rendre la page (bloqué, challenge, ou crash navigateur)')
  process.exit(1)
}
const { html } = rendered
console.log(`rendu OK : ${html.length} octets en ${secs}s`)
const title = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim()
console.log(`<title> : ${title ?? '(absent)'}`)

// Signaux de mur anti-bot renvoyés APRÈS un 200 (page-challenge).
const wall = /captcha|are you a robot|robot ou pas robot|px-captcha|access denied|unusual traffic|challenge-platform/i
if (wall.test(html)) {
  console.log('⚠️  la page contient un marqueur de challenge anti-bot (mur servi malgré le 200)')
}

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

const ruleEntries = Object.entries(PROFILES.lodging).filter(([f]) => !f.startsWith('$'))
const data: Record<string, unknown> = {}
for (const [field, chain] of ruleEntries) {
  data[field] = resolveField(chain as never, html, { meta, jsonld }) ?? null
}
console.log('── data (profil lodging) ──')
console.log(JSON.stringify(data, null, 2))
const resolved = Object.entries(data).filter(([, v]) => v !== null)
console.log(`→ ${resolved.length}/${ruleEntries.length} champs résolus : ${resolved.map(([f]) => f).join(', ') || '(aucun)'}`)

// Un og:title de home générique ne prouve RIEN : un OTA qui soft-bloque
// renvoie un 200 avec une page leurre. On exige un signal de VRAIE fiche :
// soit un nœud JSON-LD de type hébergement, soit un champ structuré
// (ville/note/avis/géo) — pas juste un nom tiré d'une meta générique.
const LODGING_TYPES = ['hotel', 'vacationrental', 'lodgingbusiness', 'product', 'apartment', 'resort']
const hasLodgingJsonld = jsonld.some((n) => {
  const t = (n as Record<string, unknown> | null)?.['@type']
  const arr = Array.isArray(t) ? t : [t]
  return arr.some((x) => typeof x === 'string' && LODGING_TYPES.includes(x.toLowerCase()))
})
const strong = ['city', 'country', 'latitude', 'longitude', 'rating', 'reviewCount'].filter(
  (f) => data[f] != null
)
const real = data.name != null && (hasLodgingJsonld || strong.length > 0)

if (!real) {
  console.log(
    `\nVERDICT: FAIL — page rendue mais pas de VRAIE fiche (jsonld hébergement: ${hasLodgingJsonld}, champs forts: ${strong.length}).` +
      ' Probable soft-block : l\'OTA sert une page générique/leurre depuis une IP datacenter → il faut un proxy résidentiel.'
  )
  process.exit(1)
}
console.log(
  `\nVERDICT: PASS — VRAIE fiche extraite depuis une IP datacenter (jsonld: ${hasLodgingJsonld}, champs forts: ${strong.join(',') || 'aucun'}) → pas besoin de proxy résidentiel 🎉`
)
