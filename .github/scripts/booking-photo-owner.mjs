/**
 * Les photos récupérées sur Booking appartiennent-elles bien à CET hébergement,
 * ou la page mélange-t-elle celles des hôtels recommandés/similaires ?
 *
 * Un ramassage naïf par regex sur tout le HTML attrape les deux — afficher la
 * photo d'un autre hôtel dans Hamak serait un bug très visible. Ce script
 * cherche un critère fiable de rattachement : où les photos apparaissent dans
 * la page, à quel bloc elles appartiennent, et si un identifiant les relie à
 * l'hébergement.
 *
 *   node .github/scripts/booking-photo-owner.mjs <url-fiche-booking>
 */
const url = process.argv[2] ?? 'https://www.booking.com/hotel/fr/le-bristol-paris.html'
const { Impit } = await import('impit')
const impit = new Impit({ browser: 'chrome' })
const res = await impit.fetch(url, {
  headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
})
const html = await res.text()
console.log(`HTTP ${res.status} — ${html.length} octets\n`)
const searchable = html.replace(/\\\//g, '/')

// ── Référence fiable : l'image déclarée par la fiche elle-même ──────────────
const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]
const ldImage = (() => {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const n = JSON.parse(m[1])
      const node = n['@graph'] ? n['@graph'].find((x) => /hotel|lodging/i.test(String(x?.['@type']))) : n
      if (node?.image) return Array.isArray(node.image) ? node.image[0] : node.image
    } catch {}
  }
})()
console.log('── RÉFÉRENCES (appartiennent sûrement à cette fiche) ──')
console.log('og:image      :', ogImage?.slice(0, 110) ?? '—')
console.log('jsonld.image  :', typeof ldImage === 'string' ? ldImage.slice(0, 110) : '—')
const refId = (ogImage ?? '').match(/\/(\d{6,})\.(?:jpe?g|webp|png)/)?.[1]
console.log('id photo de référence :', refId ?? '—')

// ── Toutes les photos, avec leur position dans le document ─────────────────
const photos = []
for (const m of searchable.matchAll(
  /https?:\/\/[^\s"'<>\\)]*bstatic\.com\/xdata\/images\/hotel\/([^/]+)\/(\d+)\.(?:jpe?g|webp|png)(?:\?[^\s"'<>\\)]*)?/gi
)) {
  photos.push({ url: m[0], size: m[1], id: m[2], at: m.index ?? 0 })
}
const ids = [...new Set(photos.map((p) => p.id))]
console.log(`\n── PHOTOS ──\n${photos.length} URLs, ${ids.length} identifiants distincts`)

// Première et dernière apparition de chaque identifiant : les photos de la
// fiche sont regroupées, celles des recommandations arrivent plus loin.
const positions = ids.map((id) => {
  const occ = photos.filter((p) => p.id === id)
  return { id, first: Math.min(...occ.map((o) => o.at)), count: occ.length }
}).sort((a, b) => a.first - b.first)
console.log('\nOrdre d\'apparition (10 premiers et 5 derniers) :')
positions.slice(0, 10).forEach((p) => console.log(`   ${p.id} @${p.first}${p.id === refId ? '  ← og:image' : ''}`))
console.log('   …')
positions.slice(-5).forEach((p) => console.log(`   ${p.id} @${p.first}`))

// ── Où commencent les blocs « autres hébergements » ? ─────────────────────
console.log('\n── FRONTIÈRES DE BLOCS ──')
const markers = [
  ['recommandations', /(?:hôtels? similaires|similar propert|you might also like|autres h[ée]bergements|recommended|Recently viewed|vus r[ée]cemment)/i],
  ['section avis', /(?:avis des voyageurs|guest reviews|Commentaires)/i],
  ['pied de page', /<footer|id=["']footer/i],
]
const bounds = []
for (const [label, re] of markers) {
  const m = html.search(re)
  if (m > -1) { bounds.push({ label, at: m }); console.log(`   ${label.padEnd(18)} @${m}`) }
  else console.log(`   ${label.padEnd(18)} (absent)`)
}
const firstBound = bounds.length ? Math.min(...bounds.map((b) => b.at)) : Infinity
const before = positions.filter((p) => p.first < firstBound)
const after = positions.filter((p) => p.first >= firstBound)
console.log(`\nphotos AVANT le 1er marqueur (@${firstBound === Infinity ? '—' : firstBound}) : ${before.length}`)
console.log(`photos APRÈS (probablement d'autres hébergements)          : ${after.length}`)

// ── L'identifiant de l'hébergement apparaît-il près des photos ? ───────────
const hotelId = html.match(/["'](?:hotel_id|hotelId|propertyId|b_hotel_id)["']?\s*[:=]\s*["']?(\d{3,9})/i)?.[1]
console.log(`\nidentifiant de l'hébergement dans la page : ${hotelId ?? '—'}`)

console.log('\n════════ LECTURE ════════')
console.log('Si les photos de la fiche sont groupées AVANT le premier marqueur,')
console.log("une coupure sur cette frontière suffit. Sinon il faut s'en tenir aux")
console.log('images déclarées (og:image + jsonld.image), quitte à en avoir moins.')
