/**
 * Bake-off gratuit de navigateurs furtifs sur les murs anti-bot des OTA.
 *
 * Compare, depuis une IP datacenter (runner CI) :
 *   1. camoufox-long   — Camoufox + attente LONGUE du challenge « Robot ou
 *                        pas robot » (Akamai peut se résoudre tout seul)
 *   2. patchright      — Chromium patché anti-détection (~180 Mo, tient dans
 *                        512 Mo de RAM contrairement à Camoufox)
 *
 * Objectif : savoir s'il existe un chemin GRATUIT vers Expedia avant de
 * choisir un hébergement. Booking sert de témoin (déjà connu OK en Camoufox).
 *
 *   node .github/scripts/engine-bakeoff.mjs <engine> <url>
 */
const [, , engine, url] = process.argv
if (!engine || !url) {
  console.error(
    'usage: node engine-bakeoff.mjs <camoufox-long|patchright|rebrowser|social|mobile> <url>'
  )
  process.exit(2)
}

const WALL = /robot ou pas robot|bot or not|are you a robot|captcha|access denied|unusual traffic/i
const LODGING_JSONLD = /application\/ld\+json[\s\S]*?"@type"\s*:\s*"(Hotel|LodgingBusiness|VacationRental)"/i

function report(label, { status, finalUrl, title, html, err }) {
  console.log('═══════════════════════════════════════')
  console.log('moteur     :', label)
  console.log('URL        :', url)
  if (err) {
    console.log('ERREUR     :', err)
    console.log('VERDICT    : FAIL (erreur technique)')
    return false
  }
  const wall = WALL.test(title ?? '') || WALL.test(html.slice(0, 200_000))
  const jsonld = LODGING_JSONLD.test(html)
  console.log('status     :', status)
  console.log('URL finale :', finalUrl)
  console.log('title      :', (title ?? '').slice(0, 90))
  console.log('taille HTML:', html.length)
  console.log('mur anti-bot détecté :', wall)
  console.log('JSON-LD hébergement  :', jsonld)
  const pass = jsonld && !wall
  console.log('VERDICT    :', pass ? 'PASS — vraie fiche obtenue 🎉' : 'FAIL — bloqué ou pas de données')
  return pass
}

let pass = false

if (engine === 'camoufox-long') {
  const { Camoufox } = await import('camoufox-js')
  let browser
  try {
    browser = await Camoufox({ headless: true, humanize: true })
    const page = await browser.newPage()
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // Laisser le challenge Akamai se résoudre : il peut prendre 20-40 s.
    console.log('title initial :', await page.title())
    await page
      .waitForFunction(
        () => !/robot ou pas robot|bot or not|are you a robot/i.test(document.title),
        { timeout: 60_000, polling: 2000 }
      )
      .catch(() => console.log('(challenge non résolu dans les 60 s)'))
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
    await page.waitForTimeout(5000)
    pass = report('camoufox-long', {
      status: resp?.status(),
      finalUrl: page.url(),
      title: await page.title(),
      html: await page.content(),
    })
  } catch (err) {
    pass = report('camoufox-long', { html: '', err: err instanceof Error ? err.message : String(err) })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
} else if (engine === 'patchright') {
  const { chromium } = await import('patchright')
  let browser
  try {
    // Contexte persistant + canal Chrome : c'est la configuration que
    // patchright recommande pour son maximum de furtivité.
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    console.log('title initial :', await page.title())
    await page
      .waitForFunction(
        () => !/robot ou pas robot|bot or not|are you a robot/i.test(document.title),
        { timeout: 60_000, polling: 2000 }
      )
      .catch(() => console.log('(challenge non résolu dans les 60 s)'))
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
    await page.waitForTimeout(5000)
    pass = report('patchright', {
      status: resp?.status(),
      finalUrl: page.url(),
      title: await page.title(),
      html: await page.content(),
    })
  } catch (err) {
    pass = report('patchright', { html: '', err: err instanceof Error ? err.message : String(err) })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
} else if (engine === 'rebrowser') {
  // Autre fork anti-détection de Playwright (patche d'autres signaux que
  // patchright : runtime CDP, execution contexts).
  const { chromium } = await import('rebrowser-playwright')
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris' })
    const page = await context.newPage()
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    console.log('title initial :', await page.title())
    await page
      .waitForFunction(() => !/robot ou pas robot|bot or not/i.test(document.title), {
        timeout: 45_000,
        polling: 2000,
      })
      .catch(() => console.log('(challenge non résolu)'))
    await page.waitForTimeout(4000)
    pass = report('rebrowser-playwright', {
      status: resp?.status(),
      finalUrl: page.url(),
      title: await page.title(),
      html: await page.content(),
    })
  } catch (err) {
    pass = report('rebrowser-playwright', {
      html: '',
      err: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
} else if (engine === 'social' || engine === 'mobile') {
  // Sans navigateur, quasi gratuit : beaucoup de sites servent VOLONTAIREMENT
  // leurs métadonnées (og:*) aux crawlers de réseaux sociaux — c'est ainsi que
  // se fabriquent les aperçus de liens — et une version allégée aux mobiles.
  // Si ça marche, Expedia devient exploitable sans navigateur ET sans
  // hébergement.
  const { Impit } = await import('impit')
  const AGENTS = {
    social: {
      'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
    mobile: {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fr-FR,fr;q=0.9',
    },
  }
  try {
    const impit = new Impit({ browser: 'chrome' })
    const res = await impit.fetch(url, { headers: AGENTS[engine] })
    const html = await res.text()
    // Un aperçu social vit dans les <meta og:*> — les compter explicitement.
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]
    console.log('og:title  :', ogTitle ?? '(absent)')
    console.log('og:image  :', ogImage ? ogImage.slice(0, 100) : '(absent)')
    pass = report(`impit-${engine}`, {
      status: res.status,
      finalUrl: url,
      title: html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim(),
      html,
    })
    // Même sans JSON-LD, un og:title spécifique à la fiche est déjà utile.
    if (!pass && ogTitle && !/^Offres|Expedia\.fr:|Booking\.com$/i.test(ogTitle)) {
      console.log('NOTE: og:title spécifique obtenu → exploitable pour un aperçu même sans JSON-LD')
    }
  } catch (err) {
    pass = report(`impit-${engine}`, {
      html: '',
      err: err instanceof Error ? err.message : String(err),
    })
  }
} else {
  console.error('moteur inconnu:', engine)
  process.exit(2)
}

process.exit(pass ? 0 : 1)
