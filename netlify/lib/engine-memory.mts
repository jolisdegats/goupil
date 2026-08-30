/**
 * Mémoire « quel moteur marche pour quel domaine ».
 *
 * goupil ne code en dur AUCUNE connaissance de plateforme : il l'apprend en
 * observant ses propres succès, puis réutilise le moteur gagnant. Résultat :
 * une seule requête au lieu de tâtonner dans la chaîne, et une adaptation
 * automatique le jour où un site change sa protection (le moteur mémorisé
 * échoue → on retombe dans la chaîne → on réapprend).
 *
 * Stockage : Netlify Blobs quand disponible (KV natif, gratuit, zéro
 * configuration), sinon une Map en mémoire — qui ne survit pas au cold start
 * mais rend déjà service pendant la durée de vie d'un conteneur, et permet de
 * tourner en local ou en conteneur sans dépendance.
 */
import type { Engine } from './common.mts'

export type EngineNote = {
  engine: Engine
  /** ISO 8601 — pour re-sonder périodiquement : les sites évoluent. */
  learnedAt: string
  /** Nombre de succès consécutifs — indice de confiance. */
  hits: number
}

/** Au-delà, on re-teste la chaîne complète même si un moteur est mémorisé. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const memory = new Map<string, EngineNote>()

type Store = {
  get: (key: string, opts?: { type: 'json' }) => Promise<unknown>
  setJSON: (key: string, value: unknown) => Promise<unknown>
  delete: (key: string) => Promise<unknown>
  list: () => Promise<{ blobs: Array<{ key: string }> }>
}

let storePromise: Promise<Store | null> | undefined

/** Netlify Blobs si le runtime le fournit ; sinon null (fallback mémoire). */
async function getStore(): Promise<Store | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const { getStore } = (await import('@netlify/blobs')) as {
          getStore: (name: string) => Store
        }
        return getStore('goupil-engines')
      } catch {
        return null
      }
    })()
  }
  return storePromise
}

/** Clé de mémorisation : le domaine, sans `www.` (même stack pour les deux). */
export function domainKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function isFresh(note: EngineNote): boolean {
  const age = Date.now() - new Date(note.learnedAt).getTime()
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS
}

/** Le moteur connu pour ce domaine, s'il est encore frais. */
export async function recallEngine(url: string): Promise<EngineNote | null> {
  const key = domainKey(url)
  if (!key) return null
  const local = memory.get(key)
  if (local) return isFresh(local) ? local : null
  const store = await getStore()
  if (!store) return null
  try {
    const note = (await store.get(key, { type: 'json' })) as EngineNote | null
    if (!note?.engine) return null
    memory.set(key, note)
    return isFresh(note) ? note : null
  } catch {
    return null
  }
}

/** Enregistre le moteur qui vient de réussir (incrémente la confiance). */
export async function rememberEngine(url: string, engine: Engine): Promise<void> {
  const key = domainKey(url)
  if (!key) return
  const previous = memory.get(key)
  const note: EngineNote = {
    engine,
    learnedAt: new Date().toISOString(),
    hits: previous?.engine === engine ? previous.hits + 1 : 1,
  }
  memory.set(key, note)
  const store = await getStore()
  try {
    await store?.setJSON(key, note)
  } catch {
    /* la mémoire locale suffit pour ce conteneur */
  }
}

/** Oublie un domaine — après échec du moteur mémorisé, ou sur demande. */
export async function forgetEngine(url: string): Promise<void> {
  const key = domainKey(url)
  if (!key) return
  memory.delete(key)
  const store = await getStore()
  try {
    await store?.delete(key)
  } catch {
    /* rien à faire */
  }
}

/** Tout ce qui est mémorisé — pour inspection via GET /engines. */
export async function listEngines(): Promise<Record<string, EngineNote>> {
  const out: Record<string, EngineNote> = {}
  for (const [key, note] of memory) out[key] = note
  const store = await getStore()
  if (!store) return out
  try {
    const { blobs } = await store.list()
    for (const { key } of blobs) {
      if (out[key]) continue
      const note = (await store.get(key, { type: 'json' })) as EngineNote | null
      if (note?.engine) out[key] = note
    }
  } catch {
    /* on rend au moins la mémoire locale */
  }
  return out
}
