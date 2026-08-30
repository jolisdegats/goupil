/**
 * Les prix SONT sur la fiche Expedia (capture d'écran : « 582 € », « 291 € par
 * nuit », « taxes et frais compris »). Mon test précédent n'en a trouvé aucun
 * — donc c'est ma REGEX qui a échoué, pas la page.
 *
 * Hypothèses à écarter : € encodé en entité HTML, nombre et symbole séparés
 * par des balises, espace insécable comme séparateur de milliers, prix
 * uniquement dans un JSON.
 *
 * On part donc des LIBELLÉS (stables et visibles) plutôt que du symbole.
 *
 *   node .github/scripts/expedia-price-dig.mjs <url-fiche-avec-dates>
 */
const url = process.argv[2]
const engine = process.argv[3] ?? 'cloak'
if (!url) { console.error('usage: expedia-price-dig.mjs <url> [cloak|impit|social]'); process.exit(2) }

async function fetchHtml() {
  if (engine === 'cloak') {
    const mod = await import('httpcloak')
    const httpcloak = mod.default ?? mod
    const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
    try {
      const r = await session.get(url)
      const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
      return { status: r.statusCode, html: typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8') }
    } finally { try { session.close?.() } catch {} }
  }
  const { Impit } = await import('impit')
  const impit = new Impit({ browser: 'chrome' })
  const headers = engine === 'social'
    ? { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
    : undefined
  const res = await impit.fetch(url, headers ? { headers } : undefined)
  return { status: res.status, html: await res.text() }
}

const { status, html } = await fetchHtml()
console.log(`moteur ${engine} — HTTP ${status} — ${html.length} octets\n`)

// ── 1. Comment le symbole € est-il représenté ? ─────────────────────────────
console.log('── REPRÉSENTATION DU SYMBOLE ──')
const symbols = {
  '€ littéral': /€/g,
  '&euro;': /&euro;/gi,
  '&#8364;': /&#8364;/g,
  '&#x20AC;': /&#x20ac;/gi,
  '\\u20AC échappé': /\\u20ac/gi,
  'EUR': /\bEUR\b/g,
}
for (const [label, re] of Object.entries(symbols)) {
  console.log(`   ${label.padEnd(16)}: ${(html.match(re) ?? []).length} occurrences`)
}

// ── 2. Les libellés visibles de la capture ──────────────────────────────────
console.log('\n── LIBELLÉS DE PRIX ──')
const labels = [
  'par nuit', 'pour 2 nuits', 'taxes et frais', 'Réserver',
  'Entièrement remboursable', 'Payez plus tard', 'Extras',
]
for (const label of labels) {
  const idx = html.indexOf(label)
  console.log(`   ${label.padEnd(26)}: ${idx === -1 ? 'absent' : `@${idx}`}`)
}

// ── 3. Contexte autour du premier « par nuit » ──────────────────────────────
const perNight = html.indexOf('par nuit')
if (perNight > -1) {
  console.log('\n── CONTEXTE autour de « par nuit » (HTML brut) ──')
  console.log(html.slice(Math.max(0, perNight - 900), perNight + 300).replace(/\s+/g, ' '))
  console.log('\n── le même, balises retirées ──')
  console.log(html.slice(Math.max(0, perNight - 900), perNight + 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
}

// ── 4. Nombres isolés dans une plage de prix crédible ───────────────────────
console.log('\n── NOMBRES CRÉDIBLES (sans exiger le symbole) ──')
const text = html.replace(/<[^>]+>/g, ' ')
const nums = [...new Set(
  [...text.matchAll(/\b(\d{2,4}(?:[.,   ]\d{3})?)\b/g)].map((m) => m[1])
)]
  .map((v) => parseFloat(v.replace(/[\s  .]/g, '').replace(',', '.')))
  .filter((n) => Number.isFinite(n) && n >= 50 && n <= 9000)
console.log(`${nums.length} nombres dans [50, 9000] : ${nums.slice(0, 30).join(' | ')}`)

// ── 5. Champs de prix dans le JSON, sans présumer du nom ────────────────────
console.log('\n── CLÉS JSON CONTENANT « price » ──')
const keys = [...new Set(
  [...html.matchAll(/"([a-zA-Z_]*[Pp]rice[a-zA-Z_]*)"\s*:/g)].map((m) => m[1])
)]
console.log(keys.slice(0, 30).join(', ') || '(aucune)')
for (const k of keys.slice(0, 10)) {
  const m = html.match(new RegExp(`"${k}"\\s*:\\s*("[^"]{1,60}"|[\\d.]+|\\{[^}]{0,140}\\})`))
  if (m) console.log(`   ${k} = ${m[1].slice(0, 130)}`)
}

console.log('\n════════ LECTURE ════════')
console.log("Si « par nuit » est présent avec un montant à côté, le prix est bien dans")
console.log("le HTML et il suffit d'une règle correcte. S'il est absent, la section")
console.log('tarifs est chargée après coup et il faudra exécuter le JavaScript.')
