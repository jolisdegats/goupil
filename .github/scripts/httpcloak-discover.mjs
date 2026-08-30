/**
 * Si httpcloak passe le mur d'Expedia, reste LA question : une vraie fiche
 * hôtel rend-elle des données exploitables ?
 *
 * On ne devine aucune URL (la précédente était morte) : on lit la page de
 * recherche, on en extrait un lien de fiche réel, puis on l'ouvre.
 *
 *   node .github/scripts/httpcloak-discover.mjs [url-recherche]
 */
const SEARCH = process.argv[2] ?? 'https://www.expedia.fr/Hotel-Search?destination=Paris%2C%20France'
const WALL = /robot ou pas robot|bot or not|are you a robot|px-captcha/i

const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod

const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
const body = async (r) => {
  const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
}

try {
  console.log('1) page de recherche :', SEARCH)
  const s = await session.get(SEARCH)
  const searchHtml = await body(s)
  console.log(`   HTTP ${s.statusCode} — ${searchHtml.length} octets — mur : ${WALL.test(searchHtml.slice(0, 150_000))}`)

  // Liens de fiche : .h<id>.Hotel-Information
  const links = [
    ...new Set(
      [...searchHtml.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>\\)]*\.h\d+\.Hotel-Information[^\s"'<>\\)]*/gi)].map(
        (m) => m[0].replace(/&amp;/g, '&')
      )
    ),
  ]
  console.log(`   liens de fiches trouvés : ${links.length}`)
  links.slice(0, 3).forEach((l) => console.log('     -', l.slice(0, 130)))

  if (links.length === 0) {
    console.log('\nAucun lien de fiche : la page de recherche est rendue côté client (JS).')
    console.log('VERDICT : httpcloak passe le mur, mais les fiches doivent être atteintes autrement.')
    process.exit(1)
  }

  console.log('\n2) ouverture de la fiche :', links[0].slice(0, 130))
  const f = await session.get(links[0])
  const html = await body(f)
  console.log(`   HTTP ${f.statusCode} — ${html.length} octets`)
  const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim()
  console.log(`   title    : ${title}`)
  const walled = WALL.test(title ?? '') || WALL.test(html.slice(0, 150_000))
  console.log(`   mur      : ${walled}`)

  const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
    .filter(Boolean)
  const flat = ld.flatMap((n) => (n && n['@graph'] ? n['@graph'] : [n]))
  const hotel = flat.find((n) => /hotel|lodging|vacationrental/i.test(String(n?.['@type'])))
  console.log(`   jsonld   : ${flat.length} nœuds — types ${JSON.stringify(flat.map((n) => n?.['@type']).slice(0, 6))}`)

  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
  const imgs = [...new Set([...html.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>\\)]*trvl-media\.com[^\s"'<>\\)]*\.(?:jpe?g|webp|png)[^\s"'<>\\)]*/gi)].map((m) => m[0]))]
  console.log(`   og:title : ${og ?? '(absent)'}`)
  console.log(`   images   : ${imgs.length}${imgs.length ? ' (1re : ' + imgs[0].slice(0, 100) + ')' : ''}`)
  if (hotel) {
    console.log('   ── données de la fiche ──')
    console.log(JSON.stringify({
      name: hotel.name,
      address: hotel.address,
      geo: hotel.geo,
      rating: hotel.aggregateRating,
      image: Array.isArray(hotel.image) ? `${hotel.image.length} URLs` : hotel.image ? '1' : null,
    }, null, 2))
  }

  console.log('\n════════ VERDICT ════════')
  const usable = !walled && (!!hotel || (!!og && imgs.length > 0))
  console.log(
    usable
      ? 'PASS — VRAIE fiche Expedia extraite depuis une IP datacenter, sans navigateur 🎉'
      : 'FAIL — la fiche ne rend pas de données exploitables'
  )
  process.exit(usable ? 0 : 1)
} catch (err) {
  console.log('ERREUR :', err instanceof Error ? err.message : String(err))
  process.exit(1)
} finally {
  try { session?.close?.() } catch {}
}
