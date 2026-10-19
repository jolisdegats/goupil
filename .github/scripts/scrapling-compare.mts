/**
 * Scrapling vaut-il une place dans goupil ? Les deux moitiés de la mesure qui
 * ne tournent PAS dans le conteneur Scrapling (scrapling-bakeoff.py) :
 *
 *   fetch   — les moteurs de goupil (social, cloak, impit), avec leur vrai
 *             code, sur les mêmes cibles, depuis le même runner, juste avant
 *             Scrapling : même IP, même minute.
 *   verdict — TOUS les HTML (goupil et Scrapling) passés dans le vrai code
 *             d'extraction de goupil (profil lodging). La question n'est pas
 *             « la page a-t-elle répondu » mais « qu'en tirerait /extract ».
 *
 *   npx tsx .github/scripts/scrapling-compare.mts fetch <out> <cible>=<url> [...]
 *   npx tsx .github/scripts/scrapling-compare.mts verdict <out>
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithEngine, type Engine } from '../../netlify/lib/common.mts'
import { extractFromHtml } from '../../netlify/lib/extraction.mts'

const [, , command, out, ...targets] = process.argv
if (!out || (command !== 'fetch' && command !== 'verdict')) {
  console.error('usage: scrapling-compare.mts fetch <out> <cible>=<url> [...] | verdict <out>')
  process.exit(2)
}

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
    const at = arg.indexOf('=')
    const target = arg.slice(0, at)
    const url = arg.slice(at + 1)
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
say('`champs` = champs du profil lodging résolus (sur 9). `€ HTML` = montants plausibles')
say('distincts dans le HTML ; `€ XHR` = réponses XHR contenant des prix (Scrapling stealth).')

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
