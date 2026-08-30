/**
 * Le prix Booking est-il extractible SANS navigateur quand l'URL porte des
 * dates ?
 *
 * Une fiche nue n'a pas de tarif (il dépend des dates + occupants). Mais
 * Booking accepte checkin/checkout/group_adults en query — c'est exactement ce
 * que hamak connaît déjà pour un séjour. On compare donc la même fiche avec et
 * sans dates, via le moteur social.
 *
 *   node .github/scripts/booking-price.mjs [url-fiche]
 */
const BASE = process.argv[2] ?? 'https://www.booking.com/hotel/fr/le-bristol-paris.html'

// Dates à ~2 mois, week-end, 2 adultes — un cas de réservation réaliste.
const start = new Date(Date.now() + 60 * 86400_000)
const end = new Date(Date.now() + 62 * 86400_000)
const iso = (d) => d.toISOString().slice(0, 10)
const withDates = `${BASE}${BASE.includes('?') ? '&' : '?'}checkin=${iso(start)}&checkout=${iso(end)}&group_adults=2&no_rooms=1&group_children=0&selected_currency=EUR`

const { Impit } = await import('impit')

async function fetchAs(url, ua) {
  const impit = new Impit({ browser: 'chrome' })
  const res = await impit.fetch(url, ua ? { headers: { 'user-agent': ua } } : undefined)
  return { status: res.status, html: await res.text() }
}

const SOCIAL_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'

/** Cherche un tarif ferme sous plusieurs formes ; renvoie ce qui est trouvé. */
function findPrices(html) {
  const out = {}
  const pats = {
    'JSON b_rackrate_price': /"b_rackrate_price"\s*:\s*"?([\d.,]+)/i,
    'JSON b_price / grossPrice': /"(?:b_price|grossPrice|b_raw_price)"\s*:\s*"?([\d.,]+)/i,
    'data-price attribut': /data-(?:price|total-price)[^=]*=["']([\d.,]+)/i,
    'prix affiché "€ N"': /€\s*([\d][\d\s.,]{1,9})/,
    'prix affiché "N €"': /([\d][\d\s.,]{1,9})\s*€/,
    'JSON-LD priceRange': /"priceRange"\s*:\s*"([^"]+)"/i,
    'JSON-LD offers price': /"offers"[\s\S]{0,400}?"price"\s*:\s*"?([\d.,]+)/i,
    'meta itemprop price': /<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.,]+)/i,
    'devise': /"(?:selected_currency|currency)"\s*:\s*"([A-Z]{3})"/,
  }
  for (const [label, re] of Object.entries(pats)) {
    const m = html.match(re)
    if (m) out[label] = m[1].trim()
  }
  return out
}

for (const [label, url, ua] of [
  ['SANS dates — social', BASE, SOCIAL_UA],
  ['AVEC dates — social', withDates, SOCIAL_UA],
  ['AVEC dates — UA Chrome normal', withDates, undefined],
]) {
  console.log('\n═══════════════════════════════════════')
  console.log(label)
  console.log('URL :', url.slice(0, 150))
  try {
    const { status, html } = await fetchAs(url, ua)
    console.log(`HTTP ${status} — ${html.length} octets`)
    const prices = findPrices(html)
    const keys = Object.keys(prices).filter((k) => k !== 'devise')
    if (keys.length === 0) {
      console.log('  aucun prix détecté')
    } else {
      for (const [k, v] of Object.entries(prices)) console.log(`  ${k.padEnd(28)}: ${v}`)
    }
    // Un prix crédible pour 2 nuits d'hôtel : entre 30 et 20000.
    const credible = keys
      .map((k) => parseFloat(prices[k].replace(/\s/g, '').replace(',', '.')))
      .filter((n) => Number.isFinite(n) && n >= 30 && n <= 20000)
    console.log('  → prix plausible(s) :', credible.length ? credible.join(', ') : 'aucun')
  } catch (err) {
    console.log('  ERREUR :', err instanceof Error ? err.message : String(err))
  }
}

console.log('\n── LECTURE ──')
console.log('Si "AVEC dates" fait apparaître un prix plausible absent de "SANS dates",')
console.log('alors hamak peut obtenir un tarif réel en passant les dates du séjour.')
