/**
 * Contrôle de validité de l'URL Expedia utilisée dans les tests.
 *
 * Question : la redirection vers /Hotels est-elle un BLOCAGE IP, ou juste une
 * URL morte/erronée (fiche supprimée, slug obsolète) ? Une URL invalide
 * redirigerait AUSSI depuis une IP propre — donc on compare plusieurs URLs
 * et on cherche la fiche via la recherche interne d'Expedia.
 *
 *   HOME=/tmp XDG_CACHE_HOME=/tmp/.cache node .github/scripts/expedia-url-check.mjs
 */
import { Camoufox } from 'camoufox-js'

const CANDIDATES = [
  // celle utilisée dans tous nos tests
  'https://www.expedia.fr/Paris-Hotel-Paris-Marriott-Rive-Gauche-Hotel-Conference-Center.h6620.Hotel-Information',
  // même hôtel, domaine .com (le slug diffère parfois par domaine)
  'https://www.expedia.com/Paris-Hotels-Paris-Marriott-Rive-Gauche-Hotel-Conference-Center.h6620.Hotel-Information',
  // un hôtel différent, très connu — écarte l'hypothèse "cette fiche-là est morte"
  'https://www.expedia.fr/Paris-Hotels-Hotel-Le-Bristol-Paris.h20141.Hotel-Information',
  // une page NON-fiche mais valide : si elle passe, le site n'est pas bloqué en bloc
  'https://www.expedia.fr/Hotel-Search?destination=Paris',
]

let browser
try {
  browser = await Camoufox({ headless: true, humanize: true })
  for (const url of CANDIDATES) {
    const page = await browser.newPage()
    let line = { url, status: null, final: null, title: null, redirected: null, jsonldHotel: null, err: null }
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 })
      await page.waitForTimeout(2500)
      const html = await page.content()
      line.status = resp?.status() ?? null
      line.final = page.url()
      line.title = (await page.title()).slice(0, 80)
      line.redirected = new URL(page.url()).pathname !== new URL(url).pathname
      line.jsonldHotel = /application\/ld\+json[\s\S]*?"@type"\s*:\s*"(Hotel|LodgingBusiness)"/i.test(html)
    } catch (err) {
      line.err = err instanceof Error ? err.message.slice(0, 120) : String(err)
    } finally {
      await page.close().catch(() => {})
    }
    console.log('─────────────────────────────────────────')
    console.log('URL        :', line.url)
    console.log('status     :', line.status, '| erreur:', line.err ?? 'aucune')
    console.log('URL finale :', line.final)
    console.log('title      :', line.title)
    console.log('redirigé   :', line.redirected, '| JSON-LD Hotel:', line.jsonldHotel)
  }
  console.log('\n── LECTURE ──')
  console.log('Si TOUTES les fiches redirigent vers /Hotels → blocage IP (URL non en cause).')
  console.log("Si une fiche s'affiche avec JSON-LD → notre URL de test était le problème, pas l'IP.")
} catch (err) {
  console.log('ERREUR GLOBALE:', err instanceof Error ? err.message : String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
}
