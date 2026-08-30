/**
 * Expedia, test HONNÊTE : au lieu de deviner une URL de fiche (la nôtre était
 * morte — elle redirige vers /Hotels y compris depuis un navigateur et une IP
 * résidentielle), on NAVIGUE comme un humain : accueil → recherche → premier
 * résultat. L'URL testée est alors forcément valide, découverte par le site
 * lui-même.
 *
 * Répond enfin proprement : Expedia bloque-t-il l'IP datacenter, ou nos tests
 * échouaient-ils simplement sur une URL invalide ?
 *
 *   HOME=/tmp XDG_CACHE_HOME=/tmp/.cache node .github/scripts/expedia-navigate.mjs [url-fiche-optionnelle]
 */
import { Camoufox } from 'camoufox-js'

const DIRECT_URL = process.argv[2] // si fournie : on teste CETTE fiche, sans naviguer
const LODGING_JSONLD = /application\/ld\+json[\s\S]*?"@type"\s*:\s*"(Hotel|LodgingBusiness|VacationRental)"/i
const WALL = /robot ou pas robot|bot or not|are you a robot|px-captcha/i

async function inspect(page, label) {
  const html = await page.content()
  const title = await page.title()
  console.log(`\n── ${label} ──`)
  console.log('URL     :', page.url())
  console.log('title   :', title.slice(0, 90))
  console.log('taille  :', html.length)
  console.log('mur     :', WALL.test(title) || WALL.test(html.slice(0, 150_000)))
  const jsonld = LODGING_JSONLD.test(html)
  console.log('JSON-LD hébergement :', jsonld)
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
  console.log('og:title:', ogTitle ?? '(absent)')
  return { jsonld, html, title, ogTitle }
}

let browser
let success = false
try {
  browser = await Camoufox({ headless: true, humanize: true })
  const page = await browser.newPage()

  if (DIRECT_URL) {
    console.log('Test direct de la fiche fournie :', DIRECT_URL)
    await page.goto(DIRECT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
    await page.waitForTimeout(4000)
    const r = await inspect(page, 'fiche (URL fournie)')
    success = r.jsonld
  } else {
    // 1. Accueil — établit les cookies de session comme un vrai visiteur.
    console.log('1) accueil expedia.fr')
    await page.goto('https://www.expedia.fr/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4000)
    await inspect(page, 'accueil')

    // Consentement cookies (bloque parfois l'interaction).
    for (const sel of ['#onetrust-accept-btn-handler', 'button[aria-label*="accept" i]']) {
      const el = await page.$(sel).catch(() => null)
      if (el) {
        await el.click().catch(() => {})
        console.log('   (consentement accepté)')
        await page.waitForTimeout(1500)
        break
      }
    }

    // 2. Page de recherche d'hôtels à Paris — URL générique, toujours valide.
    console.log('\n2) recherche hôtels Paris')
    await page.goto('https://www.expedia.fr/Hotel-Search?destination=Paris%2C%20France', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => null)
    await page.waitForTimeout(6000)
    await inspect(page, 'résultats de recherche')

    // 3. Récupérer un lien de fiche RÉEL depuis les résultats.
    const links = await page
      .$$eval('a[href*="Hotel-Information"], a[href*=".h"][href*="Hotel"]', (as) =>
        as.map((a) => a.href).filter((h) => /Hotel-Information/.test(h)).slice(0, 5)
      )
      .catch(() => [])
    console.log('\n3) liens de fiches trouvés :', links.length)
    links.slice(0, 3).forEach((l) => console.log('   -', l.slice(0, 130)))

    if (links.length === 0) {
      console.log('\nAucun lien de fiche dans les résultats → soit la page est un mur, soit le rendu JS est incomplet.')
    } else {
      console.log('\n4) ouverture de la première fiche RÉELLE')
      await page.goto(links[0], { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => null)
      await page.waitForTimeout(5000)
      const r = await inspect(page, 'fiche réelle')
      success = r.jsonld
    }
  }

  console.log('\n════════ VERDICT ════════')
  console.log(
    success
      ? 'PASS — Expedia livre une VRAIE fiche depuis une IP datacenter 🎉 (nos échecs venaient de l\'URL morte, pas d\'un blocage)'
      : 'FAIL — même avec une URL valide découverte sur le site, aucune donnée exploitable depuis une IP datacenter'
  )
} catch (err) {
  console.log('ERREUR:', err instanceof Error ? err.message : String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
}
process.exit(success ? 0 : 1)
