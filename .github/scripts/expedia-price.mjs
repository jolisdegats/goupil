/**
 * Chasse au prix sur Expedia — sérieusement cette fois.
 *
 * La conclusion « prix non extractible » venait de Booking et n'a jamais été
 * vérifiée sur Expedia. Or Expedia publie en microdata et embarque un
 * __APOLLO_STATE__ (cache GraphQL) : le tarif peut être dans l'un ou l'autre.
 * L'URL porte des dates, donc un tarif ferme DOIT exister quelque part.
 *
 *   node .github/scripts/expedia-price.mjs <url-avec-dates>
 */
const url = process.argv[2]
if (!url) {
  console.error('usage: node expedia-price.mjs <url>')
  process.exit(2)
}

const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod
const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
const r = await session.get(url)
const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
const html = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
try { session.close?.() } catch {}
console.log(`HTTP ${r.statusCode} — ${html.length} octets\n`)

// ── 1. Microdata liée au prix ───────────────────────────────────────────────
console.log('── MICRODATA prix ──')
const priceProps = [...html.matchAll(/itemprop=["'](price[A-Za-z]*|offers?|lowPrice|highPrice|priceRange|priceCurrency)["'][^>]*/gi)]
console.log(`propriétés prix trouvées : ${priceProps.length}`)
priceProps.slice(0, 8).forEach((m) => console.log('   ', m[0].slice(0, 150)))

// ── 2. Tous les montants en euros visibles ──────────────────────────────────
console.log('\n── MONTANTS € DANS LE TEXTE ──')
const euros = [...new Set([...html.matchAll(/(\d[\d\s  .,]{0,8}\d|\d)\s*(?:€|EUR)/g)].map((m) => m[1].trim()))]
  .map((v) => ({ brut: v, num: parseFloat(v.replace(/[\s ]/g, '').replace(',', '.')) }))
  .filter((v) => Number.isFinite(v.num) && v.num >= 20 && v.num <= 20000)
console.log(`${euros.length} montants plausibles : ${euros.slice(0, 15).map((e) => e.brut).join(' | ')}`)
// Contexte du premier montant : est-ce bien un tarif de nuit ?
if (euros.length) {
  const i = html.indexOf(euros[0].brut)
  if (i > -1) console.log(`contexte : …${html.slice(Math.max(0, i - 200), i + 200).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}…`)
}

// ── 3. APOLLO_STATE : le cache GraphQL ──────────────────────────────────────
console.log('\n── __APOLLO_STATE__ ──')
const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/)
if (!apolloMatch) {
  console.log('non trouvé (ou format inattendu)')
} else {
  const blob = apolloMatch[1]
  console.log(`taille : ${blob.length} octets`)
  const keys = [...new Set([...blob.matchAll(/"([a-zA-Z]*(?:price|Price|amount|Amount|total|Total|rate|Rate)[a-zA-Z]*)"\s*:/g)].map((m) => m[1]))]
  console.log(`clés liées au prix : ${keys.slice(0, 25).join(', ') || '(aucune)'}`)
  for (const k of keys.slice(0, 12)) {
    const m = blob.match(new RegExp(`"${k}"\\s*:\\s*("[^"]{1,60}"|[\\d.]+|\\{[^}]{0,120}\\})`))
    if (m) console.log(`   ${k} = ${m[1].slice(0, 110)}`)
  }
}

// ── 4. Motifs de prix formatés courants chez Expedia ────────────────────────
console.log('\n── MOTIFS EXPEDIA ──')
const patterns = {
  'formattedPrice': /"formatted(?:Price|Amount|Display)?"\s*:\s*"([^"]{1,30})"/i,
  'displayPrice': /"displayPrice"\s*:\s*\{?[^}]{0,80}?"([^"]{1,30})"/i,
  'amount (nombre)': /"amount"\s*:\s*([\d.]+)/i,
  'totalPrice': /"total(?:Price)?"\s*:\s*\{?[^}]{0,60}?([\d.]+)/i,
  'priceCurrency': /"(?:priceCurrency|currencyCode|currency)"\s*:\s*"([A-Z]{3})"/,
  'aria-label prix': /aria-label=["']([^"']{0,60}(?:€|EUR)[^"']{0,40})["']/i,
  'texte "par nuit"': /([\d\s.,]{2,10})\s*€[^<]{0,30}(?:par nuit|la nuit|\/ nuit)/i,
  'texte "total"': /(?:total|au total)[^<]{0,40}?([\d\s.,]{2,10})\s*€/i,
}
for (const [label, re] of Object.entries(patterns)) {
  const m = html.match(re)
  console.log(`   ${label.padEnd(22)}: ${m ? m[1].trim().slice(0, 60) : '—'}`)
}

console.log('\n════════ LECTURE ════════')
console.log('Un montant plausible + un contexte « nuit/total » = prix extractible')
console.log('par règle regex côté hamak. Rien = le tarif arrive par XHR après')
console.log('chargement, et il resterait en saisie manuelle.')
