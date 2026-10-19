/**
 * Scrapling vaut-il une place dans goupil ? Les deux moitiés de la mesure qui
 * ne tournent PAS dans le conteneur Scrapling (scrapling-bakeoff.py) :
 *
 *   fetch   — les moteurs de goupil (social, cloak, impit), avec leur vrai
 *             code, sur les mêmes cibles, depuis le même runner, juste avant
 *             Scrapling : même IP, même minute.
 *   patchright — le témoin : patchright NU en Node (le Chromium que Scrapling
 *             0.5 pilote, sans ses empreintes browserforge ni ses réglages),
 *             avec la même écoute des XHR. Si lui aussi obtient les prix,
 *             c'est le navigateur qui compte, pas Scrapling.
 *   verdict — TOUS les HTML (goupil et Scrapling) passés dans le vrai code
 *             d'extraction de goupil (profil lodging). La question n'est pas
 *             « la page a-t-elle répondu » mais « qu'en tirerait /extract ».
 *
 *   npx tsx .github/scripts/scrapling-compare.mts fetch <out> <cible>=<url> [...]
 *   npx tsx .github/scripts/scrapling-compare.mts patchright <out> <cible>=<url> [...]
 *   npx tsx .github/scripts/scrapling-compare.mts verdict <out>
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithEngine, type Engine } from '../../netlify/lib/common.mts'
import { extractFromHtml } from '../../netlify/lib/extraction.mts'

const [, , command, out, ...targets] = process.argv
if (!out || !['fetch', 'patchright', 'verdict'].includes(command)) {
  console.error('usage: scrapling-compare.mts fetch|patchright <out> <cible>=<url> [...] | verdict <out>')
  process.exit(2)
}

const splitTarget = (arg: string) => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]

// Même motif que scrapling-bakeoff.py : montants en euros ou clés de prix.
const XHR_PRICE =
  /(?:€|EUR)\s*\d[\d\s .,]{0,8}\d|\d[\d\s .,]{0,8}\d\s*(?:€|EUR)|"(?:grossPrice|b_raw_price|priceValue|formattedPrice|displayPrice|structuredDisplayPrice|price|amount)"\s*:/gi

type Row = {
  engine: string
  target: string
  url: string
  ms: number
  status?: number
  bytes?: number
  error?: string
  xhr_prices?: { url: string; status: number; hits: number; sample: string[] }[]
}

if (command === 'fetch') {
  mkdirSync(out, { recursive: true })
  const engines: Engine[] = ['social', 'cloak', 'impit']
  for (const arg of targets) {
    const [target, url] = splitTarget(arg)
    for (const engine of engines) {
      console.log(`\n═══ goupil-${engine} — ${target}\n    ${url.slice(0, 130)}`)
      const row: Row = { engine: `goupil-${engine}`, target, url, ms: 0 }
      const t0 = Date.now()
      const result = await fetchWithEngine(engine, url)
      row.ms = Date.now() - t0
      if ('error' in result) {
        row.error = result.error
        console.log(`    ERREUR ${result.error}`)
      } else {
        row.bytes = result.html.length
        writeFileSync(join(out, `goupil-${engine}-${target}.html`), result.html)
        console.log(`    ${result.html.length} octets`)
      }
      console.log(`    ${row.ms} ms`)
      appendFileSync(join(out, 'results.jsonl'), JSON.stringify(row) + '\n')
    }
  }
  process.exit(0)
}

if (command === 'patchright') {
  mkdirSync(out, { recursive: true })
  const { chromium } = await import('patchright')
  for (const arg of targets) {
    const [target, url] = splitTarget(arg)
    console.log(`\n═══ patchright — ${target}\n    ${url.slice(0, 130)}`)
    const row: Row = { engine: 'patchright', target, url, ms: 0, xhr_prices: [] }
    const t0 = Date.now()
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris' })
      const page = await context.newPage()
      const reads: Promise<void>[] = []
      page.on('response', (res) => {
        if (!['xhr', 'fetch'].includes(res.request().resourceType())) return
        reads.push(
          res
            .text()
            .then((text) => {
              const hits = text.match(XHR_PRICE)
              if (hits) {
                row.xhr_prices!.push({
                  url: res.url().slice(0, 200),
                  status: res.status(),
                  hits: hits.length,
                  sample: [...new Set(hits.map((h) => h.trim()))].sort().slice(0, 8),
                })
              }
            })
            .catch(() => {})
        )
      })
      // Mêmes attentes que le mode stealth de Scrapling : referer Google, mur
      // Akamai laissé 45 s, réseau au repos (60 s max), puis 3 s.
      const res = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
        referer: 'https://www.google.com/',
      })
      await page
        .waitForFunction(
          () => !/robot ou pas robot|bot or not|are you a robot|access denied/i.test(document.title),
          undefined,
          { timeout: 45_000, polling: 2_000 }
        )
        .catch(() => console.log('    (mur toujours là après 45 s)'))
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => null)
      await page.waitForTimeout(3_000)
      await Promise.all(reads)
      const html = await page.content()
      row.status = res?.status()
      row.bytes = html.length
      writeFileSync(join(out, `patchright-${target}.html`), html)
      console.log(`    HTTP ${row.status} — ${html.length} octets — XHR avec des prix : ${row.xhr_prices!.length}`)
    } catch (err) {
      row.error = err instanceof Error ? err.message.slice(0, 300) : String(err)
      console.log(`    ERREUR ${row.error}`)
    } finally {
      await browser.close().catch(() => {})
    }
    row.ms = Date.now() - t0
    console.log(`    ${row.ms} ms`)
    appendFileSync(join(out, 'results.jsonl'), JSON.stringify(row) + '\n')
  }
  process.exit(0)
}

// ── verdict ─────────────────────────────────────────────────────────────────

// Même critère que la chaîne `auto` (looksBlocked, common.mts) : un mur
// anti-bot, ou ni JSON-LD ni og:title/og:image, ne compte pas comme un succès.
const WALL = /robot ou pas robot|bot or not|are you a robot|px-captcha|unusual traffic/i
const AMOUNT = /(?:€|EUR)\s*([\d][\d\s .,]{0,8}\d|\d)|([\d][\d\s .,]{0,8}\d|\d)\s*(?:€|EUR)/g
const PRICE_KEY =
  /"(?:grossPrice|b_raw_price|priceValue|formattedPrice|displayPrice|structuredDisplayPrice|amount|price)"\s*:\s*"?([\d]+(?:[.,]\d+)?)/gi

const rows: Row[] = readFileSync(join(out, 'results.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const lines: string[] = []
const say = (line = '') => {
  console.log(line)
  lines.push(line)
}

say('## Scrapling vs goupil — même runner, même minute')
say()
say('Chaque HTML passe par le vrai `extractFromHtml(html, { profile: "lodging" })` de goupil.')
say('`exploitable` = critère de la chaîne `auto` (`looksBlocked`) : pas de mur, et JSON-LD ou og:title/og:image.')
say('`champs` = champs du profil lodging résolus (sur 9). `€ HTML` = montants plausibles')
say('distincts dans le HTML ; `€ XHR` = réponses XHR contenant des prix (navigateurs seulement).')

for (const target of [...new Set(rows.map((r) => r.target))]) {
  say()
  say(`### ${target}`)
  say()
  say(`<sub>${rows.find((r) => r.target === target)!.url}</sub>`)
  say()
  say('| moteur | HTTP | temps | Ko | mur | exploitable | champs | nom | images | € HTML | € JSON | € XHR |')
  say('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows.filter((r) => r.target === target)) {
    const file = join(out, `${row.engine}-${target}.html`)
    const secs = `${(row.ms / 1000).toFixed(1)} s`
    if (row.error || !existsSync(file)) {
      say(`| ${row.engine} | ❌ | ${secs} | — | — | ❌ | — | ${(row.error ?? 'pas de HTML').slice(0, 60).replace(/\|/g, '/')} | | | | |`)
      continue
    }
    const html = readFileSync(file, 'utf8')
    const wall = WALL.test(html.slice(0, 200_000))
    const hasJsonLd = /application\/ld\+json/i.test(html)
    const hasOg = /property=["']og:(title|image)["']/i.test(html)
    const usable = !wall && (hasJsonLd || hasOg)

    const extracted = extractFromHtml(html, { profile: 'lodging' })
    const body = 'error' in extracted ? {} : extracted.body
    const data = (body.data ?? {}) as Record<string, unknown>
    const auto = (body.auto ?? {}) as { images?: string[] }
    const resolved = Object.values(data).filter((v) => v !== undefined && v !== null && v !== '').length
    const name = typeof data.name === 'string' ? data.name.slice(0, 40).replace(/\|/g, '/') : '—'

    const amounts = new Set(
      [...html.matchAll(AMOUNT)]
        .map((m) => parseFloat((m[1] ?? m[2]).trim().replace(/[\s .]/g, '').replace(',', '.')))
        .filter((n) => Number.isFinite(n) && n >= 25 && n <= 15000)
    )
    const jsonPrices = new Set([...html.matchAll(PRICE_KEY)].map((m) => m[1]))
    const xhr = row.xhr_prices ? String(row.xhr_prices.length) : '—'

    say(
      `| ${row.engine} | ${row.status ?? 200} | ${secs} | ${Math.round(html.length / 1024)} | ${wall ? '🧱' : '—'} | ${usable ? '✅' : '❌'} | ${resolved}/9 | ${name} | ${auto.images?.length ?? 0} | ${amounts.size} | ${jsonPrices.size} | ${xhr} |`
    )
  }
  for (const row of rows.filter((r) => r.target === target && r.xhr_prices?.length)) {
    say()
    say(`<details><summary>${row.engine} — XHR contenant des prix</summary>`)
    say()
    for (const x of row.xhr_prices!.slice(0, 10)) {
      say(`- \`${x.status}\` ${x.url.slice(0, 120)} → ${x.sample.slice(0, 4).join(' · ')}`)
    }
    say()
    say('</details>')
  }
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
