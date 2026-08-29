#!/usr/bin/env node
/**
 * Standalone Camoufox fetch worker.
 *
 * Spawned as a subprocess by fetchViaBrowser() so the browser runs in a clean
 * process, separate from Next.js — which avoids environment-related
 * fingerprint leaks that trigger bot detection.
 *
 * Usage: node scripts/camoufox-fetch.mjs <url>
 * Outputs JSON to stdout: { html: string } or { error: string }
 */

import { Camoufox } from 'camoufox-js'

const url = process.argv[2]
if (!url) {
  console.log(JSON.stringify({ error: 'No URL provided' }))
  process.exit(1)
}

let browser
try {
  browser = await Camoufox({ headless: true, humanize: true })
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // Wait for bot challenge to auto-resolve (if present)
  const initialTitle = await page.title()
  if (/bot or not|are you a robot|robot ou pas/i.test(initialTitle)) {
    await page
      .waitForFunction(() => !/bot or not/i.test(document.title), { timeout: 20_000 })
      .catch(() => null)
  }

  // Wait for page content to fully load (SPAs like Vrbo load images via JS)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)

  // Wait for og:image meta tag or property images to appear
  await Promise.race([
    page.waitForSelector("meta[property='og:image']", { state: 'attached', timeout: 15_000 }),
    page.waitForSelector("img[src*='media.vrbo.com'], img[src*='trvl-media.com'], img[src*='bstatic.com']", { timeout: 15_000 }),
  ]).catch(() => null)

  const html = await page.content()
  console.log(JSON.stringify({ html }))
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
} finally {
  if (browser) await browser.close().catch(() => {})
}
