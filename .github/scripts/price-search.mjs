/**
 * Le prix est-il sur les pages de RECHERCHE plutôt que sur les fiches ?
 *
 * Jusqu'ici on n'a testé que des fiches (faites pour décrire un lieu). Les
 * pages de résultats existent, elles, pour afficher des tarifs — et hamak
 * connaît l'hôtel ET les dates du séjour, donc il pourrait y retrouver la
 * ligne correspondante.
 *
 *   node .github/scripts/price-search.mjs <plateforme> <ville> [hôtel]
 *     plateforme : booking | expedia
 */
const [, , platform = 'booking', city = 'Bruxelles', hotelNeedle = 'Juliana'] = process.argv

const start = new Date(Date.now() + 35 * 86400_000)
const end = new Date(Date.now() + 37 * 86400_000)
const iso = (d) => d.toISOString().slice(0, 10)

const URLS = {
  booking: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${iso(start)}&checkout=${iso(end)}&group_adults=2&no_rooms=1&selected_currency=EUR`,
  expedia: `https://www.expedia.fr/Hotel-Search?destination=${encodeURIComponent(city)}&startDate=${iso(start)}&endDate=${iso(end)}&adults=2&rooms=1`,
}
const url = URLS[platform]
if (!url) {
  console.error(`plateforme inconnue: ${platform}`)
  process.exit(2)
}

// Le bon moteur par plateforme, comme établi : social pour Booking, cloak
// pour Expedia.
async function fetchHtml() {
  if (platform === 'expedia') {
    const mod = await import('httpcloak')
    const httpcloak = mod.default ?? mod
    const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
    try {
      const r = await session.get(url)
      const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
      return { status: r.statusCode, html: typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8') }
    } finally {
      try { session.close?.() } catch {}
    }
  }
  const { Impit } = await import('impit')
  const impit = new Impit({ browser: 'chrome' })
  const res = await impit.fetch(url, {
    headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  })
  return { status: res.status, html: await res.text() }
}

console.log(`plateforme : ${platform}`)
console.log(`URL        : ${url}`)
console.log(`dates      : ${iso(start)} → ${iso(end)}, 2 adultes\n`)

const { status, html } = await fetchHtml()
console.log(`HTTP ${status} — ${html.length} octets`)
const title = html.match(/<title[^>]*>([\s\S]{0,150}?)<\/title>/i)?.[1]?.trim()
console.log(`title : ${title ?? '(absent)'}`)
if (/robot ou pas robot|are you a robot/i.test(html.slice(0, 150_000))) {
  console.log('\n⚠️  mur anti-bot — la recherche est plus protégée que la fiche.')
}

// ── Montants ────────────────────────────────────────────────────────────────
const amounts = [...new Set(
  [...html.matchAll(/(?:€|EUR)\s*([\d][\d\s .,]{0,8}\d|\d)|([\d][\d\s .,]{0,8}\d|\d)\s*(?:€|EUR)/g)]
    .map((m) => (m[1] ?? m[2]).trim())
)]
  .map((v) => parseFloat(v.replace(/[\s .]/g, '').replace(',', '.')))
  .filter((n) => Number.isFinite(n) && n >= 25 && n <= 15000)
console.log(`\nmontants € plausibles : ${amounts.length}`)
console.log(amounts.slice(0, 20).join(' | ') || '(aucun)')

// ── Prix dans le JSON embarqué ──────────────────────────────────────────────
const jsonPrices = [...new Set(
  [...html.matchAll(/"(?:grossPrice|b_raw_price|priceValue|formattedPrice|displayPrice|amount|price)"\s*:\s*"?([\d]+(?:[.,]\d+)?)/gi)].map((m) => m[1])
)]
console.log(`\nprix dans le JSON embarqué : ${jsonPrices.length}`)
console.log(jsonPrices.slice(0, 20).join(' | ') || '(aucun)')

// ── L'hôtel cherché est-il dans les résultats, et avec quel prix ? ──────────
console.log(`\n── « ${hotelNeedle} » dans les résultats ──`)
const at = html.indexOf(hotelNeedle)
if (at === -1) {
  console.log('absent de cette page de résultats')
} else {
  console.log(`trouvé à la position ${at}`)
  const around = html.slice(Math.max(0, at - 2500), at + 2500)
  const near = [...new Set(
    [...around.matchAll(/(?:€|EUR)\s*([\d][\d\s .,]{0,8}\d)|([\d][\d\s .,]{0,8}\d)\s*(?:€|EUR)/g)].map((m) => (m[1] ?? m[2]).trim())
  )]
  console.log(`montants dans ±2500 caractères autour : ${near.join(' | ') || '(aucun)'}`)
  console.log(`extrait : …${around.slice(2300, 2900).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}…`)
}

console.log('\n════════ LECTURE ════════')
// Un seul montant ne prouve rien (« 100 % », un identifiant…). Une page de
// résultats affiche un tarif PAR établissement : on exige donc plusieurs
// montants distincts, ou des prix nommés dans le JSON.
const distinct = [...new Set(amounts)]
const usable = jsonPrices.length > 0 || distinct.length >= 3
if (!usable && distinct.length > 0) {
  console.log(`(${distinct.length} montant(s) isolé(s) — trop peu pour être des tarifs : ${distinct.join(', ')})`)
}
console.log(usable
  ? "PASS — des tarifs sont présents dans le HTML de recherche : hamak pourrait\n       interroger la recherche sur les dates du séjour et lire le prix."
  : 'FAIL — aucun tarif : les prix arrivent par XHR, y compris en recherche.')
process.exit(usable ? 0 : 1)
