/**
 * Sonde diagnostic Expedia depuis IP datacenter : le soft-block est-il une
 * REDIRECTION (URL finale = home → mur IP, rien à faire sans IP résidentielle)
 * ou un flow récupérable (consentement cookies + attente → la vraie fiche
 * finit par apparaître à la même URL) ?
 *
 *   HOME=/tmp XDG_CACHE_HOME=/tmp/.cache node .github/scripts/expedia-probe.mjs <url>
 */
import { Camoufox } from 'camoufox-js'

const url = process.argv[2]
if (!url) {
  console.error('usage: node expedia-probe.mjs <url>')
  process.exit(2)
}

let browser
try {
  browser = await Camoufox({ headless: true, humanize: true })
  const page = await browser.newPage()
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  console.log('── après goto ──')
  console.log('HTTP status :', resp?.status())
  console.log('URL demandée:', url)
  console.log('URL obtenue :', page.url())
  console.log('title       :', await page.title())
  const redirected = new URL(page.url()).pathname !== new URL(url).pathname

  // Tenter d'accepter le consentement (OneTrust chez Expedia) au cas où il
  // bloque le rendu de la fiche.
  for (const sel of [
    '#onetrust-accept-btn-handler',
    'button[aria-label*="accept" i]',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
  ]) {
    const el = await page.$(sel).catch(() => null)
    if (el) {
      await el.click().catch(() => {})
      console.log('consentement cliqué:', sel)
      break
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
  await page.waitForTimeout(3000)

  const html = await page.content()
  console.log('── état final ──')
  console.log('URL finale  :', page.url())
  console.log('title final :', await page.title())
  console.log('taille HTML :', html.length)
  console.log('redirigé hors de la fiche :', redirected || new URL(page.url()).pathname !== new URL(url).pathname)
  console.log('JSON-LD Hotel présent     :', /application\/ld\+json[\s\S]*?"@type"\s*:\s*"Hotel"/i.test(html))
  console.log('mentionne "Marriott"      :', /marriott/i.test(html))
  console.log('marqueur challenge/captcha:', /captcha|access denied|px-captcha|challenge-platform|unusual traffic/i.test(html))
  console.log('\n── DIAGNOSTIC ──')
  if (/application\/ld\+json[\s\S]*?"@type"\s*:\s*"Hotel"/i.test(html)) {
    console.log('RÉCUPÉRABLE : la vraie fiche apparaît avec un meilleur flow → Expedia GRATUIT possible !')
  } else if (new URL(page.url()).pathname !== new URL(url).pathname) {
    console.log('REDIRECTION IP : Expedia renvoie ailleurs (home) depuis datacenter → IP résidentielle requise, pas de solution gratuite par hébergement.')
  } else {
    console.log('MUR À MÊME URL : reste sur la fiche mais sans données → challenge JS/IP, très probablement IP résidentielle requise.')
  }
} catch (err) {
  console.log('ERREUR:', err instanceof Error ? err.message : String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
}
