/**
 * Expedia sert bien la page (200, 1,37 Mo) mais sans JSON-LD : c'est une
 * application JavaScript. Où vivent les données, alors ?
 *
 * On cherche le nom de l'hôtel dans le HTML et on regarde ce qu'il y a autour :
 * état embarqué (window.__*), balises <script type="application/json">, blocs
 * Apollo/Redux… Objectif : savoir s'il existe un JSON exploitable, et sous
 * quelle forme, pour écrire les règles d'extraction côté hamak.
 *
 *   node .github/scripts/expedia-dig.mjs <url> [terme-a-chercher]
 */
const url = process.argv[2]
const needle = process.argv[3] ?? 'Juliana'
if (!url) {
  console.error('usage: node expedia-dig.mjs <url> [terme]')
  process.exit(2)
}

const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod
const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })

try {
  const r = await session.get(url)
  const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
  const html = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  console.log(`HTTP ${r.statusCode} — ${html.length} octets\n`)

  // ── 1. Balises meta : le minimum vital ──────────────────────────────────
  console.log('── META ──')
  const metas = {}
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi
  )) metas[m[1]] = m[2]
  const interesting = Object.entries(metas).filter(([k]) => /^og:|^twitter:|description|title/i.test(k))
  console.log(`${Object.keys(metas).length} balises, dont ${interesting.length} utiles :`)
  interesting.slice(0, 10).forEach(([k, v]) => console.log(`   ${k} = ${v.slice(0, 110)}`))
  console.log(`<title> : ${html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim() ?? '(absent)'}`)

  // ── 2. Où apparaît le nom de l'hôtel ? ──────────────────────────────────
  console.log(`\n── OCCURRENCES DE « ${needle} » ──`)
  const idxs = []
  let from = 0
  while (idxs.length < 6) {
    const i = html.indexOf(needle, from)
    if (i === -1) break
    idxs.push(i)
    from = i + 1
  }
  console.log(`${idxs.length} occurrence(s) (6 max affichées)`)
  idxs.forEach((i) => {
    const ctx = html.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' ')
    console.log(`   …${ctx}…`)
  })

  // ── 3. Scripts JSON embarqués ───────────────────────────────────────────
  console.log('\n── SCRIPTS JSON EMBARQUÉS ──')
  const jsonScripts = [...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*(?:id=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/script>/gi)]
  console.log(`<script type="application/json"> : ${jsonScripts.length}`)
  jsonScripts.slice(0, 5).forEach((m, n) => {
    const id = m[1] ?? '(sans id)'
    const size = m[2].length
    const hasNeedle = m[2].includes(needle)
    console.log(`   [${n}] id=${id} — ${size} octets — contient « ${needle} » : ${hasNeedle}`)
  })

  // ── 4. État global (window.__X__ = {...}) ───────────────────────────────
  console.log('\n── ÉTAT GLOBAL (window.__*) ──')
  const globals = [...new Set([...html.matchAll(/window\.(__[A-Z0-9_]+__|[A-Za-z_$][\w$]*State[\w$]*)\s*=/g)].map((m) => m[1]))]
  console.log(globals.length ? globals.join(', ') : '(aucun)')

  // ── 5. Indices de données structurées dans le JS ────────────────────────
  console.log('\n── CHAMPS REPÉRÉS DANS LE JS ──')
  const probes = {
    'nom (propertyName/hotelName)': /"(?:propertyName|hotelName|name)"\s*:\s*"([^"]{3,80})"/i,
    'note (reviewScore/rating)': /"(?:reviewScore|overallScore|rating|ratingValue)"\s*:\s*"?([\d.,]{1,5})/i,
    "nombre d'avis": /"(?:totalCount|reviewCount|reviewTotal)"\s*:\s*"?(\d{1,7})/i,
    'latitude': /"lat(?:itude)?"\s*:\s*(-?[\d.]{2,12})/i,
    'longitude': /"l(?:on|ng|ongitude)"\s*:\s*(-?[\d.]{2,12})/i,
    'ville': /"(?:city|addressLocality)"\s*:\s*"([^"]{2,60})"/i,
    'prix (formatted/amount)': /"(?:formatted|displayPrice|amount|price)"\s*:\s*"?([€$]?\s?[\d.,]{2,12})/i,
    'devise': /"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/,
  }
  for (const [label, re] of Object.entries(probes)) {
    const m = html.match(re)
    console.log(`   ${label.padEnd(30)}: ${m ? m[1] : '—'}`)
  }

  // ── 6. Photos ───────────────────────────────────────────────────────────
  const photos = [...new Set(
    [...html.replace(/\\\//g, '/').matchAll(/https?:\/\/images\.trvl-media\.com\/lodging\/[^\s"'<>\\)]+\.(?:jpe?g|webp|png)/gi)].map((m) => m[0])
  )]
  const uniqueIds = new Set(photos.map((p) => p.match(/\/([0-9a-f_]+)\.(?:jpe?g|webp|png)$/i)?.[1] ?? p))
  console.log(`\n── PHOTOS ──\n   ${photos.length} URLs, ${uniqueIds.size} uniques`)
  photos.slice(0, 4).forEach((p) => console.log('   -', p.slice(0, 115)))

  console.log('\n════════ LECTURE ════════')
  console.log("Si des champs remontent ci-dessus, hamak peut les cibler par regex dans")
  console.log("ses règles goupil. Sinon, les données arrivent par requête XHR après")
  console.log('chargement, et il faudrait viser cette API plutôt que la page.')
} catch (err) {
  console.log('ERREUR :', err instanceof Error ? err.message : String(err))
  process.exit(1)
} finally {
  try { session?.close?.() } catch {}
}
