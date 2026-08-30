/**
 * Ce que le profil lodging tire réellement d'une fiche Expedia, une fois la
 * microdata prise en charge. C'est la mesure qui dit si Expedia est réglé.
 */
import { extractMetas, extractJsonLd, extractMicrodata, extractImages, resolveField } from '../../netlify/lib/extraction.mts'
import { PROFILES } from '../../netlify/lib/profiles.mts'

const url = process.argv[2]
const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod
const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
const r = await session.get(url)
const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
const html = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
try { session.close?.() } catch {}

console.log(`HTTP ${r.statusCode} — ${html.length} octets\n`)
const meta = extractMetas(html)
const jsonld = extractJsonLd(html)
const microdata = extractMicrodata(html)
console.log(`microdata : ${Object.keys(microdata).length} propriétés`)
console.log(JSON.stringify(microdata, null, 2).slice(0, 1600))

const entries = Object.entries(PROFILES.lodging).filter(([f]) => !f.startsWith('$'))
const data = {}
for (const [field, chain] of entries) data[field] = resolveField(chain, html, { meta, jsonld, microdata }) ?? null
console.log('\n── data (profil lodging) ──')
console.log(JSON.stringify(data, null, 2))
const got = Object.entries(data).filter(([, v]) => v !== null)
console.log(`\n→ ${got.length}/${entries.length} champs : ${got.map(([f]) => f).join(', ') || '(aucun)'}`)

const photos = [...new Set([...html.replace(/\\\//g,'/').matchAll(/https?:\/\/images\.trvl-media\.com\/lodging\/[^\s"'<>\\)]+\.(?:jpe?g|webp|png)/gi)].map(m=>m[0].split('?')[0]))]
console.log(`photos uniques : ${photos.length}`)
console.log(data.name ? '\nVERDICT: PASS — Expedia extractible sans navigateur 🎉' : '\nVERDICT: FAIL')
process.exit(data.name ? 0 : 1)
