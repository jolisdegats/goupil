/**
 * Le prix Airbnb est-il DÉJÀ dans les données que hamak télécharge ?
 *
 * `actions/fetch/airbnb.ts` extrait la section BOOK_IT_SIDEBAR de l'état
 * différé — c'est le widget de réservation — mais n'en lit que la capacité
 * (ligne 62). Or c'est là que vit `structuredDisplayPrice` quand l'URL porte
 * des dates. Si le prix y est, il ne manque qu'une lecture, pas un scrape.
 *
 *   node .github/scripts/airbnb-price.mjs <url-annonce>
 */
const base = process.argv[2]
if (!base) { console.error('usage: airbnb-price.mjs <url>'); process.exit(2) }

const start = new Date(Date.now() + 35 * 86400_000)
const end = new Date(Date.now() + 37 * 86400_000)
const iso = (d) => d.toISOString().slice(0, 10)
const withDates = `${base}${base.includes('?') ? '&' : '?'}check_in=${iso(start)}&check_out=${iso(end)}&adults=2`

const { Impit } = await import('impit')
async function get(url) {
  const impit = new Impit({ browser: 'chrome' })
  const res = await impit.fetch(url)
  return { status: res.status, html: await res.text() }
}

for (const [label, url] of [['SANS dates', base], ['AVEC dates', withDates]]) {
  console.log(`\n═══ ${label} ═══`)
  console.log(url.slice(0, 130))
  const { status, html } = await get(url)
  console.log(`HTTP ${status} — ${html.length} octets`)

  const m = html.match(/data-deferred-state[^>]*>([\s\S]*?)<\/script>/)
  if (!m) { console.log('état différé absent'); continue }
  let parsed
  try { parsed = JSON.parse(m[1]) } catch { console.log('état illisible'); continue }
  const pairs = parsed?.niobeClientData ?? []
  const val = pairs.find(([k]) => k.startsWith('StaysPdpSections:'))?.[1]
  const sections = val?.data?.presentation?.stayProductDetailPage?.sections?.sections ?? []
  console.log(`sections : ${sections.length}`)

  const bookIt = sections.find((s) => s?.sectionId === 'BOOK_IT_SIDEBAR')?.section
  if (!bookIt) { console.log('BOOK_IT_SIDEBAR absente'); continue }
  console.log(`BOOK_IT_SIDEBAR — clés : ${Object.keys(bookIt).join(', ').slice(0, 300)}`)

  const sdp = bookIt.structuredDisplayPrice
  if (sdp) {
    console.log('structuredDisplayPrice :')
    console.log(JSON.stringify(sdp, null, 2).slice(0, 1200))
  } else {
    console.log('structuredDisplayPrice : absent')
  }

  // Filet : tout ce qui ressemble à un prix dans l'état entier.
  const blob = JSON.stringify(parsed)
  const prices = [...new Set([...blob.matchAll(/"(?:price|amount|amountFormatted|discountedPrice|originalPrice)"\s*:\s*"?([€$]?\s?[\d][\d\s.,]{0,9})/gi)].map((x) => x[1].trim()))]
  console.log(`\nmontants trouvés dans tout l'état : ${prices.slice(0, 12).join(' | ') || '(aucun)'}`)
}
