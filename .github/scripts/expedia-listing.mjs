/**
 * LA question qui reste sur Expedia : httpcloak passe le mur (accueil et
 * recherche rendent 200), mais une VRAIE FICHE hôtel donne-t-elle des données
 * exploitables ?
 *
 * La page de recherche est rendue côté client : aucun <a href> de fiche dans
 * le HTML. On va donc chercher les identifiants d'hôtel dans le JSON embarqué,
 * puis on ouvre la fiche par sa forme canonique courte
 * (expedia.fr/h<ID>.Hotel-Information), qui redirige vers le slug complet.
 *
 *   node .github/scripts/expedia-listing.mjs [id-hotel]
 */
const FORCED_ID = process.argv[2]
const WALL = /robot ou pas robot|bot or not|are you a robot|px-captcha/i

const mod = await import('httpcloak')
const httpcloak = mod.default ?? mod
const session = new httpcloak.Session({ preset: 'chrome-latest-windows' })
const body = async (r) => {
  const raw = typeof r.text === 'function' ? await r.text() : (r.body ?? r.text ?? r.content ?? '')
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
}

let ids = FORCED_ID ? [FORCED_ID] : []
try {
  if (ids.length === 0) {
    const SEARCH = 'https://www.expedia.fr/Hotel-Search?destination=Paris%2C%20France'
    console.log('1) recherche :', SEARCH)
    const s = await session.get(SEARCH)
    const html = await body(s)
    console.log(`   HTTP ${s.statusCode} — ${html.length} octets — mur : ${WALL.test(html.slice(0, 150_000))}`)

    // Identifiants dans le JSON embarqué : "id":"12345" sous propriété/hôtel,
    // ou des URLs .h<id>. quelque part dans le payload.
    const fromUrls = [...html.matchAll(/\.h(\d{2,9})\.Hotel-Information/gi)].map((m) => m[1])
    const fromJson = [...html.matchAll(/"(?:hotelId|propertyId|id)"\s*:\s*"?(\d{3,9})"?/gi)].map((m) => m[1])
    ids = [...new Set([...fromUrls, ...fromJson])].slice(0, 6)
    console.log(`   candidats d'ID trouvés : ${ids.length} → ${ids.join(', ') || '(aucun)'}`)
    if (ids.length === 0) {
      console.log('\nAucun identifiant exploitable dans le HTML de recherche.')
      console.log('VERDICT : le mur est franchi, mais il faut une URL de fiche fournie par l\'utilisateur.')
      process.exit(1)
    }
  }

  for (const id of ids) {
    const url = `https://www.expedia.fr/h${id}.Hotel-Information`
    console.log(`\n2) fiche h${id} : ${url}`)
    const r = await session.get(url)
    const html = await body(r)
    const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim()
    const walled = WALL.test(title ?? '') || WALL.test(html.slice(0, 150_000))
    console.log(`   HTTP ${r.statusCode} — ${html.length} octets — mur : ${walled}`)
    console.log(`   title : ${title ?? '(absent)'}`)
    if (walled || html.length < 50_000) continue

    const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
      .filter(Boolean)
    const flat = ld.flatMap((n) => (n && n['@graph'] ? n['@graph'] : [n]))
    const hotel = flat.find((n) => /hotel|lodging|vacationrental/i.test(String(n?.['@type'])))
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]
    const imgs = [...new Set(
      [...html.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>\\)]*trvl-media\.com[^\s"'<>\\)]*\.(?:jpe?g|webp|png)[^\s"'<>\\)]*/gi)].map((m) => m[0])
    )]
    console.log(`   jsonld   : ${flat.length} nœuds, types ${JSON.stringify(flat.map((n) => n?.['@type']).slice(0, 6))}`)
    console.log(`   og:title : ${og ?? '(absent)'}`)
    console.log(`   og:image : ${ogImg ? ogImg.slice(0, 90) : '(absent)'}`)
    console.log(`   images   : ${imgs.length}`)
    if (hotel) {
      console.log('   ── fiche ──')
      console.log(JSON.stringify({
        name: hotel.name, address: hotel.address, geo: hotel.geo,
        rating: hotel.aggregateRating, priceRange: hotel.priceRange ?? null,
      }, null, 2))
    }

    const usable = !!hotel || (!!og && (!!ogImg || imgs.length > 0))
    if (usable) {
      console.log('\n════════ VERDICT ════════')
      console.log('PASS — VRAIE fiche Expedia extraite depuis une IP datacenter, SANS navigateur 🎉')
      process.exit(0)
    }
    console.log('   (pas de données exploitables sur cette fiche, essai suivant)')
  }

  console.log('\n════════ VERDICT ════════')
  console.log('FAIL — le mur est franchi mais aucune fiche testée ne rend de données.')
  process.exit(1)
} catch (err) {
  console.log('ERREUR :', err instanceof Error ? err.message : String(err))
  process.exit(1)
} finally {
  try { session?.close?.() } catch {}
}
