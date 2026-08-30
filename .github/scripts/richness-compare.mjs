/**
 * Richesse des données, moteur par moteur.
 *
 * « Ça marche » ne suffit pas : la vraie question est COMBIEN on récupère.
 * Ce script mesure, pour une même fiche, ce que chaque moteur rend sur les
 * champs dont hamak a besoin — photos (toutes, pas juste og:image), prix,
 * capacité, chambres, équipements, note, géo…
 *
 *   node .github/scripts/richness-compare.mjs <social|impit|browser> <url>
 */
const [, , engine, url] = process.argv
if (!engine || !url) {
  console.error('usage: node richness-compare.mjs <social|impit|browser> <url>')
  process.exit(2)
}

async function getHtml() {
  if (engine === 'cloak') {
    const mod = await import('httpcloak')
    const httpcloak = mod.default ?? mod
    const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
    try {
      const r = await session.get(url)
      const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
      console.log(`(cloak: HTTP ${r.statusCode})`)
      return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    } finally {
      try { session?.close?.() } catch {}
    }
  }
  if (engine === 'browser') {
    const { Camoufox } = await import('camoufox-js')
    const browser = await Camoufox({ headless: true, humanize: true })
    try {
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => null)
      await page.waitForTimeout(5000)
      return await page.content()
    } finally {
      await browser.close().catch(() => {})
    }
  }
  const { Impit } = await import('impit')
  const impit = new Impit({ browser: 'chrome' })
  const headers =
    engine === 'social'
      ? { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
      : undefined
  const res = await impit.fetch(url, headers ? { headers } : undefined)
  if (!res.ok) throw new Error(`http_${res.status}`)
  return await res.text()
}

const html = await getHtml()
console.log(`═══ moteur ${engine} — ${html.length} octets ═══`)

// ── JSON-LD ────────────────────────────────────────────────────────────────
const nodes = []
for (const m of html.matchAll(
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
)) {
  try {
    const p = JSON.parse(m[1])
    const list = Array.isArray(p) ? p : [p]
    for (const n of list) {
      if (n && typeof n === 'object' && '@graph' in n && Array.isArray(n['@graph'])) nodes.push(...n['@graph'])
      else if (n) nodes.push(n)
    }
  } catch {}
}
const hotel = nodes.find((n) => /hotel|lodging|vacationrental|apartment|resort/i.test(String(n?.['@type'])))
console.log('\n── JSON-LD ──')
console.log('nœuds :', nodes.length, '| types :', JSON.stringify(nodes.map((n) => n?.['@type']).slice(0, 8)))
if (hotel) {
  console.log('champs du nœud hébergement :', Object.keys(hotel).join(', '))
  console.log('  name          :', hotel.name ?? '—')
  console.log('  address       :', JSON.stringify(hotel.address ?? '—').slice(0, 140))
  console.log('  geo           :', JSON.stringify(hotel.geo ?? '—'))
  console.log('  rating        :', JSON.stringify(hotel.aggregateRating ?? '—'))
  console.log('  priceRange    :', hotel.priceRange ?? '—')
  console.log('  starRating    :', JSON.stringify(hotel.starRating ?? '—'))
  console.log('  image (jsonld):', Array.isArray(hotel.image) ? `${hotel.image.length} URLs` : (hotel.image ? '1 URL' : '—'))
  console.log('  amenities     :', JSON.stringify(hotel.amenityFeature ?? hotel.amenityFeatures ?? '—').slice(0, 200))
  console.log('  makesOffer/offers:', JSON.stringify(hotel.makesOffer ?? hotel.offers ?? '—').slice(0, 200))
}

// ── PHOTOS : toutes les URLs d'images de la CDN de l'hébergeur ─────────────
const searchable = html.replace(/\\\//g, '/')
const allImgs = [
  ...new Set(
    [...searchable.matchAll(/https?:\/\/[^\s"'<>\\)]+\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi)].map((m) =>
      m[0].replace(/&amp;/g, '&')
    )
  ),
]
const cdnImgs = allImgs.filter((u) => /bstatic\.com|trvl-media\.com|muscache\.com|vrbo\.com|expedia/i.test(u))
// Photos de fiche : Booking sous /images/hotel/, Expedia sous /lodging/ ou /images/
const listingPhotos = cdnImgs.filter((u) =>
  /\/images\/hotel\/|\/xdata\/images\/hotel\/|\/lodging\/|trvl-media\.com\/(?:hotels|lodging)\//i.test(u)
)
// Dédup par identifiant de photo : les OTA servent la même image en N tailles.
const uniqueIds = new Set(
  listingPhotos.map((u) => u.match(/\/(\d{6,})\.(?:jpe?g|webp|png)/i)?.[1] ?? u.split('?')[0])
)
console.log('\n── PHOTOS ──')
console.log('images totales trouvées   :', allImgs.length)
console.log('images CDN hébergeur      :', cdnImgs.length)
console.log('photos de la fiche        :', listingPhotos.length)
console.log('photos UNIQUES (dédup)    :', uniqueIds.size)
listingPhotos.slice(0, 5).forEach((u) => console.log('   -', u.slice(0, 110)))

// ── PRIX ───────────────────────────────────────────────────────────────────
console.log('\n── PRIX ──')
const priceSignals = [
  ['JSON b_rackrate/price', /"(?:b_rackrate_price|b_price|priceValue|grossPrice|rawPrice)"\s*:\s*"?([\d.,]+)/i],
  ['meta itemprop price', /<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.,]+)/i],
  ['data-price attr', /data-(?:price|total-price)=["']([\d.,]+)/i],
  ['€ dans le texte', /(\d[\d\s.,]{1,9})\s*€/],
  ['"currency"', /"currency"\s*:\s*"([A-Z]{3})"/],
]
let priceFound = false
for (const [label, re] of priceSignals) {
  const m = html.match(re)
  if (m) {
    console.log(`  ${label} → ${m[1]}`)
    if (!/currency/i.test(label)) priceFound = true
  }
}
if (!priceFound) console.log('  aucun prix détecté')

// ── AUTRES INFOS ───────────────────────────────────────────────────────────
console.log('\n── AUTRES ──')
const other = [
  ['capacité (personnes)', /(\d+)\s*(?:personnes|guests|voyageurs)/i],
  ['chambres', /(\d+)\s*(?:chambres?|bedrooms?)/i],
  ['salles de bain', /(\d+)\s*(?:salles? de bain|bathrooms?)/i],
  ['check-in', /check[- ]?in[^<]{0,40}?(\d{1,2}[:h]\d{0,2})/i],
  ['équipements (mots-clés)', /(wi-?fi|piscine|parking|climatisation)/i],
]
for (const [label, re] of other) {
  const m = html.match(re)
  console.log(`  ${label.padEnd(24)}: ${m ? m[1] ?? m[0] : '—'}`)
}

console.log('\n── RÉSUMÉ ──')
console.log(
  JSON.stringify({
    engine,
    jsonldHotel: !!hotel,
    photosUniques: uniqueIds.size,
    prix: priceFound,
    note: hotel?.aggregateRating?.ratingValue ?? null,
    geo: !!hotel?.geo || /["']lat(?:itude)?["']\s*:/.test(html),
    nom: hotel?.name ?? meta['og:title'] ?? null,
  })
)
