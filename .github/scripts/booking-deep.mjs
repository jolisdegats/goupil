/**
 * Analyse fine d'une fiche Booking récupérée SANS navigateur (UA crawler).
 *
 * Le comptage brut d'images ment : Booking sert la MÊME photo en une dizaine
 * de tailles (max500, square60, max1024x768…). Ici on déduplique par ID de
 * photo et on garde la meilleure résolution — c'est ça, le nombre de photos
 * réellement exploitables. On cherche aussi ce que le JSON-LD n'a pas :
 * coordonnées, prix, équipements.
 *
 *   node .github/scripts/booking-deep.mjs <url>
 */
const url = process.argv[2] ?? 'https://www.booking.com/hotel/fr/le-bristol-paris.html'
const { Impit } = await import('impit')
const impit = new Impit({ browser: 'chrome' })
const res = await impit.fetch(url, {
  headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
})
const html = await res.text()
console.log(`fiche : ${url}`)
console.log(`HTTP ${res.status} — ${html.length} octets\n`)

const searchable = html.replace(/\\\//g, '/')

// ── PHOTOS uniques ─────────────────────────────────────────────────────────
// URL type : https://cf.bstatic.com/xdata/images/hotel/<taille>/<id>.jpg?k=…
const RANK = ['max1280x900', 'max1024x768', 'max500', 'max300', 'square600', 'max200', 'square60']
const byId = new Map()
for (const m of searchable.matchAll(
  /https?:\/\/[^\s"'<>\\)]*bstatic\.com\/xdata\/images\/hotel\/([^/]+)\/(\d+)\.(?:jpe?g|webp|png)(?:\?[^\s"'<>\\)]*)?/gi
)) {
  const [full, size, id] = m
  const url = full.replace(/&amp;/g, '&')
  const rank = RANK.indexOf(size)
  const prev = byId.get(id)
  // garder la plus grande taille connue (rang le plus bas), sinon la 1re vue
  if (!prev || (rank !== -1 && (prev.rank === -1 || rank < prev.rank))) {
    byId.set(id, { url, size, rank })
  }
}
console.log('── PHOTOS ──')
console.log('photos UNIQUES (dédupliquées par ID) :', byId.size)
console.log('tailles disponibles :', [...new Set([...byId.values()].map((v) => v.size))].join(', '))
;[...byId.values()].slice(0, 6).forEach((v) => console.log('   -', v.url.slice(0, 120)))

// ── COORDONNÉES ────────────────────────────────────────────────────────────
console.log('\n── COORDONNÉES ──')
const coordPatterns = [
  ['data-atlas-latlng', /data-atlas-latlng=["']([-\d.]+),([-\d.]+)/i],
  ['booking.env latitude', /['"]latitude['"]\s*:\s*["']?([-\d.]+)/i],
  ['booking.env longitude', /['"]longitude['"]\s*:\s*["']?([-\d.]+)/i],
  ['map center', /center["']?\s*:\s*\{?\s*["']?lat["']?\s*:\s*([-\d.]+)/i],
]
for (const [label, re] of coordPatterns) {
  const m = html.match(re)
  console.log(`  ${label.padEnd(24)}: ${m ? m.slice(1).filter(Boolean).join(', ') : '—'}`)
}

// ── PRIX ───────────────────────────────────────────────────────────────────
// Sur Booking le prix dépend des dates et du nombre de voyageurs : une fiche
// sans paramètres de séjour n'a pas de prix ferme. On vérifie ce qui existe.
console.log('\n── PRIX ──')
const pricePatterns = [
  ['JSON-LD priceRange', /"priceRange"\s*:\s*"([^"]+)"/i],
  ['b_rackrate', /"b_rackrate[^"]*"\s*:\s*"?([\d.,]+)/i],
  ['prix affiché (data-)', /data-(?:price|total-price)[^=]*=["']([^"']+)/i],
  ['montant € proche de "nuit"', /([\d\s.,]{2,12})\s*€[^<]{0,40}(?:nuit|night)/i],
  ['devise du site', /"?currency"?\s*:\s*"([A-Z]{3})"/],
]
for (const [label, re] of pricePatterns) {
  const m = html.match(re)
  console.log(`  ${label.padEnd(28)}: ${m ? m[1].trim().slice(0, 40) : '—'}`)
}
console.log('  NB : un prix Booking dépend des dates + occupants ; sans eux, la fiche n\'affiche pas de tarif ferme.')

// ── ÉQUIPEMENTS / INFOS ────────────────────────────────────────────────────
console.log('\n── ÉQUIPEMENTS détectés ──')
const amenities = [
  'Wi-Fi', 'Piscine', 'Parking', 'Climatisation', 'Salle de sport', 'Spa',
  'Restaurant', 'Bar', 'Petit-déjeuner', 'Animaux', 'Navette', 'Blanchisserie',
]
const found = amenities.filter((a) => new RegExp(a.replace('-', '[- ]?'), 'i').test(html))
console.log(' ', found.join(', ') || '(aucun)')

// ── JSON-LD ────────────────────────────────────────────────────────────────
const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
  .filter(Boolean)
const hotel = ld.find((n) => /hotel|lodging/i.test(String(n?.['@type'])))
console.log('\n── JSON-LD (structuré, fiable) ──')
if (hotel) {
  console.log(JSON.stringify({
    name: hotel.name,
    description: (hotel.description ?? '').slice(0, 90) + '…',
    rating: hotel.aggregateRating?.ratingValue,
    reviews: hotel.aggregateRating?.reviewCount,
    address: hotel.address,
    priceRange: hotel.priceRange ?? null,
  }, null, 2))
}

console.log('\n════════ BILAN pour hamak ════════')
console.log(JSON.stringify({
  photosUniques: byId.size,
  nom: !!hotel?.name,
  description: !!hotel?.description,
  note: hotel?.aggregateRating?.ratingValue ?? null,
  avis: hotel?.aggregateRating?.reviewCount ?? null,
  adresseComplete: !!hotel?.address,
  coordonnees: !!html.match(/data-atlas-latlng|['"]latitude['"]\s*:/i),
  prixFerme: false,
}, null, 2))
