/**
 * Rattacher un PRIX à UN hôtel précis, sur Expedia.
 *
 * Établi : la page de résultats Expedia contient bien des tarifs dans son HTML
 * (27 montants crédibles sur une recherche Bruxelles). Reste la seule question
 * qui compte pour hamak : peut-on retrouver LE bon prix pour L'hôtel choisi ?
 *
 * On cherche donc l'hôtel par son nom (destination = nom de l'établissement),
 * puis on lit le montant le plus proche de son nom dans le document.
 *
 *   node .github/scripts/expedia-price-match.mjs "<nom hôtel>" "<ville>"
 */
const hotel = process.argv[2] ?? 'Juliana Hotel & Spa'
const city = process.argv[3] ?? 'Bruxelles'

const start = new Date(Date.now() + 35 * 86400_000)
const end = new Date(Date.now() + 37 * 86400_000)
const iso = (d) => d.toISOString().slice(0, 10)
const query = `${hotel} ${city}`.trim()
const url =
  `https://www.expedia.fr/Hotel-Search?destination=${encodeURIComponent(query)}` +
  `&startDate=${iso(start)}&endDate=${iso(end)}&adults=2&rooms=1`

const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod
const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
const r = await session.get(url)
const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
const html = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
try { session.close?.() } catch {}

console.log(`recherche : ${query}`)
console.log(`dates     : ${iso(start)} → ${iso(end)}, 2 adultes`)
console.log(`URL       : ${url}`)
console.log(`\nHTTP ${r.statusCode} — ${html.length} octets`)
console.log(`title : ${html.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i)?.[1]?.trim() ?? '(absent)'}`)

// Tous les montants, avec leur position.
const amounts = []
for (const m of html.matchAll(/(?:€\s*([\d][\d\s .,]{0,7}\d|\d)|([\d][\d\s .,]{0,7}\d|\d)\s*€)/g)) {
  const value = parseFloat((m[1] ?? m[2]).replace(/[\s .]/g, '').replace(',', '.'))
  if (Number.isFinite(value) && value >= 30 && value <= 5000) amounts.push({ value, at: m.index ?? 0 })
}
console.log(`\nmontants crédibles : ${amounts.length}`)

// Le nom cherché : on prend le mot le plus distinctif pour éviter les faux
// positifs (« Hotel » apparaît partout).
const needle = hotel.split(/\s+/).find((w) => w.length > 4) ?? hotel
const hits = []
let from = 0
while (hits.length < 8) {
  const i = html.indexOf(needle, from)
  if (i === -1) break
  hits.push(i)
  from = i + 1
}
console.log(`occurrences de « ${needle} » : ${hits.length}`)

if (hits.length === 0) {
  console.log("\nL'hôtel n'apparaît pas : la recherche par nom ne le remonte pas.")
  console.log('VERDICT: FAIL — pas de rattachement possible par cette voie.')
  process.exit(1)
}

// Pour chaque occurrence, le montant le plus proche.
console.log('\n── montants les plus proches du nom ──')
const candidates = []
for (const at of hits.slice(0, 5)) {
  const near = amounts
    .map((a) => ({ ...a, dist: Math.abs(a.at - at) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
  console.log(`  @${at} → ${near.map((n) => `${n.value}€ (à ${n.dist} car.)`).join(', ') || 'aucun'}`)
  candidates.push(...near.filter((n) => n.dist < 6000))
}

// Le lauréat : le montant le plus fréquemment proche du nom.
const tally = new Map()
for (const c of candidates) tally.set(c.value, (tally.get(c.value) ?? 0) + 1)
const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
console.log('\n════════ VERDICT ════════')
if (!best) {
  console.log("FAIL — l'hôtel est là mais aucun tarif à proximité.")
  process.exit(1)
}
console.log(`PASS — prix le plus probable pour « ${hotel} » : ${best[0]} € (${best[1]} occurrences proches)`)
console.log('       → hamak peut interroger la recherche sur les dates du séjour et lire ce tarif.')
