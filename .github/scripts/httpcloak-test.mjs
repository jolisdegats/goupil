/**
 * httpcloak vs Expedia : l'empreinte TLS/HTTP2/TCP suffit-elle, ou le mur
 * est-il bien l'IP ?
 *
 * httpcloak est dans la même famille qu'impit (imitation du navigateur au
 * niveau transport), mais va plus loin : JA3/JA4, empreinte HTTP/2 « Akamai »,
 * HTTP/3 + ECH, et empreinte TCP/IP (TTL, Window Scale, MSS). Comme les guides
 * 2026 désignent le fingerprinting TLS comme le premier vecteur d'Akamai,
 * c'est le dernier levier gratuit à tester avant de conclure au mur d'IP.
 *
 *   node .github/scripts/httpcloak-test.mjs <url> [preset]
 */
const url = process.argv[2]
const preset = process.argv[3] ?? 'chrome-latest'
if (!url) {
  console.error('usage: node httpcloak-test.mjs <url> [preset]')
  process.exit(2)
}

const WALL = /robot ou pas robot|bot or not|are you a robot|px-captcha|access denied|unusual traffic/i
const LODGING = /application\/ld\+json[\s\S]*?"@type"\s*:\s*"(Hotel|LodgingBusiness|VacationRental)"/i

let httpcloak
try {
  httpcloak = (await import('httpcloak')).default ?? (await import('httpcloak'))
} catch (err) {
  console.log('IMPORT KO :', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

console.log(`URL    : ${url}`)
console.log(`preset : ${preset}\n`)

let session
try {
  session = new httpcloak.Session({ preset })
  const t0 = Date.now()
  const r = await session.get(url)
  const ms = Date.now() - t0
  const html = r.body ?? r.text ?? ''
  console.log(`HTTP ${r.statusCode} (${r.protocol ?? '?'}) — ${html.length} octets en ${ms} ms`)
  const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim()
  console.log(`title  : ${title ?? '(absent)'}`)
  const walled = WALL.test(title ?? '') || WALL.test(html.slice(0, 150_000))
  const lodging = LODGING.test(html)
  console.log(`mur anti-bot        : ${walled}`)
  console.log(`JSON-LD hébergement : ${lodging}`)

  console.log('\n════════ VERDICT ════════')
  if (lodging && !walled) {
    console.log('PASS — httpcloak obtient la VRAIE fiche depuis une IP datacenter 🎉')
    console.log('       → l\'empreinte transport suffisait : moteur à intégrer dans goupil.')
    process.exit(0)
  }
  console.log(
    walled
      ? 'FAIL — mur anti-bot servi malgré une empreinte TLS/HTTP2/TCP de navigateur :'
      : 'FAIL — pas de données exploitables :'
  )
  console.log('       le blocage ne porte pas sur l\'empreinte mais sur l\'IP datacenter.')
  process.exit(1)
} catch (err) {
  console.log('ERREUR :', err instanceof Error ? err.message : String(err))
  process.exit(1)
} finally {
  try {
    session?.close?.()
  } catch {}
}
