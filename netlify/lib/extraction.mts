/**
 * Extraction déterministe (sans LLM) partagée par les deux façades : les
 * Netlify Functions et le serveur conteneurisé (server.mjs). Le HTML entre,
 * { auto, data } sort — aucune connaissance du transport ni de l'hébergeur.
 */
import { PROFILES } from './profiles.mts'

export type Rule = { meta?: string; jsonld?: string; regex?: string; flags?: string; all?: boolean }
/** Un champ = une règle ou une CHAÎNE de fallback — la première qui trouve gagne. */
export type RuleChain = Rule | Rule[]

export const AUTO_SECTIONS = ['meta', 'jsonld', 'images'] as const
export type AutoSection = (typeof AUTO_SECTIONS)[number]

const MAX_RULES = 50
const MAX_IMAGES = 50

// ── auto extractors ─────────────────────────────────────────────────────────

export function extractMetas(html: string): Record<string, string> {
  const metas: Record<string, string> = {}
  const re =
    /<meta\s[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["']|<meta\s[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']([^"']+)["']/gi
  for (const m of html.matchAll(re)) {
    const key = (m[1] ?? m[4])?.toLowerCase()
    const value = (m[2] ?? m[3])?.replace(/&amp;/g, '&')
    if (key && value && !(key in metas)) metas[key] = value
  }
  return metas
}

export function extractJsonLd(html: string): unknown[] {
  const nodes: unknown[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1]) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const node of list) {
        if (node && typeof node === 'object' && '@graph' in node) {
          const graph = (node as { '@graph': unknown })['@graph']
          if (Array.isArray(graph)) nodes.push(...graph)
          else nodes.push(node)
        } else if (node) {
          nodes.push(node)
        }
      }
    } catch {
      // bloc malformé — on ignore
    }
  }
  return nodes
}

export function extractImages(html: string): string[] {
  // Les blobs JSON échappent les slashes (https:\/\/…) — on déséchappe une
  // copie pour que ces URLs matchent aussi.
  const searchable = html.replace(/\\\//g, '/')
  const re = /https?:\/\/[^\s"'<>\\)]+\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi
  const seen = new Set<string>()
  for (const m of searchable.matchAll(re)) {
    const url = m[0].replace(/&amp;/g, '&')
    if (!seen.has(url)) seen.add(url)
    if (seen.size >= MAX_IMAGES) break
  }
  return [...seen]
}

// ── moteur de règles ────────────────────────────────────────────────────────

function typeMatches(node: unknown, wanted: string): boolean {
  if (wanted === '*') return true
  if (!node || typeof node !== 'object') return false
  const t = (node as Record<string, unknown>)['@type']
  const types = Array.isArray(t) ? t : [t]
  return types.some((x) => typeof x === 'string' && x.toLowerCase() === wanted.toLowerCase())
}

function walkPath(node: unknown, segments: string[]): unknown {
  let current: unknown = node
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[0]
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function applyRule(
  rule: Rule,
  html: string,
  auto: { meta: Record<string, string>; jsonld: unknown[] }
): unknown {
  if (rule.meta) return auto.meta[rule.meta.toLowerCase()]

  if (rule.jsonld) {
    const [type, ...path] = rule.jsonld.split('.')
    for (const node of auto.jsonld) {
      if (!typeMatches(node, type)) continue
      const value = path.length === 0 ? node : walkPath(node, path)
      if (value !== undefined) return value
    }
    return undefined
  }

  if (rule.regex) {
    let re: RegExp
    try {
      const flags = (rule.flags ?? 'i').replace(/[^gimsu]/g, '')
      re = new RegExp(rule.regex, flags.includes('g') || !rule.all ? flags : flags + 'g')
    } catch {
      return undefined
    }
    const searchable = html.replace(/\\\//g, '/')
    if (rule.all) {
      const out = [...searchable.matchAll(re)].map((m) => (m[1] ?? m[0]).replace(/&amp;/g, '&'))
      return [...new Set(out)].slice(0, MAX_IMAGES)
    }
    const m = searchable.match(re)
    return m ? (m[1] ?? m[0]).replace(/&amp;/g, '&') : undefined
  }

  return undefined
}

export function resolveField(
  chain: RuleChain,
  html: string,
  auto: { meta: Record<string, string>; jsonld: unknown[] }
): unknown {
  const rules = Array.isArray(chain) ? chain : [chain]
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    const value = applyRule(rule, html, auto)
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

// ── orchestration ───────────────────────────────────────────────────────────

export type ExtractionOutcome =
  | { body: Record<string, unknown> }
  | { error: true; status: number; body: Record<string, unknown> }

/**
 * Valide règles et profil SANS toucher au réseau, pour refuser une requête
 * malformée avant de payer un fetch (sinon un profil inconnu ressortirait en
 * 502 « fetch_failed » au lieu du 400 qu'il est).
 */
export function validateExtractionRequest(opts: {
  rules?: unknown
  profile?: unknown
}): { status: number; body: Record<string, unknown> } | null {
  const { rules, profile } = opts
  if (rules !== undefined && (typeof rules !== 'object' || rules === null || Array.isArray(rules))) {
    return { status: 400, body: { error: 'invalid_rules' } }
  }
  if (profile !== undefined && (typeof profile !== 'string' || !(profile in PROFILES))) {
    return { status: 400, body: { error: 'unknown_profile', available: Object.keys(PROFILES) } }
  }
  return null
}

/**
 * Applique profil + règles + sections auto à du HTML déjà récupéré.
 * Les erreurs renvoyées sont des erreurs de REQUÊTE (400), pas de réseau.
 */
export function extractFromHtml(
  html: string,
  opts: { rules?: unknown; profile?: unknown; auto?: unknown }
): ExtractionOutcome {
  const { rules, profile, auto: autoParam } = opts

  if (rules !== undefined && (typeof rules !== 'object' || rules === null || Array.isArray(rules))) {
    return { error: true, status: 400, body: { error: 'invalid_rules' } }
  }

  let profileRules: Record<string, unknown> = {}
  if (profile !== undefined) {
    if (typeof profile !== 'string' || !(profile in PROFILES)) {
      return {
        error: true,
        status: 400,
        body: { error: 'unknown_profile', available: Object.keys(PROFILES) },
      }
    }
    profileRules = PROFILES[profile]
  }

  const merged: Record<string, unknown> = {
    ...profileRules,
    ...(rules as Record<string, unknown> | undefined),
  }
  const ruleEntries = Object.entries(merged).filter(([field]) => !field.startsWith('$'))
  if (ruleEntries.length > MAX_RULES) {
    return { error: true, status: 400, body: { error: 'too_many_rules' } }
  }

  // Allègement de la réponse : auto = true (défaut) | false | ["images"]…
  let autoSections: AutoSection[] = [...AUTO_SECTIONS]
  if (autoParam === false) autoSections = []
  else if (Array.isArray(autoParam)) {
    autoSections = AUTO_SECTIONS.filter((s) => autoParam.includes(s))
  }

  const meta = extractMetas(html)
  const jsonld = extractJsonLd(html)
  const engineAuto = { meta, jsonld }

  const body: Record<string, unknown> = {}
  if (autoSections.length > 0) {
    const auto: Record<string, unknown> = {}
    if (autoSections.includes('meta')) auto.meta = meta
    if (autoSections.includes('jsonld')) auto.jsonld = jsonld
    if (autoSections.includes('images')) auto.images = extractImages(html)
    body.auto = auto
  }

  if (ruleEntries.length > 0) {
    const data: Record<string, unknown> = {}
    for (const [field, chain] of ruleEntries) {
      data[field] = resolveField(chain as RuleChain, html, engineAuto)
    }
    body.data = data
  }

  return { body }
}
