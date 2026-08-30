/**
 * GET    /engines           → ce que goupil a appris, domaine par domaine
 * DELETE /engines?url=…     → oublie un domaine (force un réapprentissage)
 *
 * goupil ne code en dur aucune connaissance de plateforme : il apprend quel
 * moteur marche pour quel domaine en observant ses propres succès. Cette route
 * rend cette mémoire inspectable et réinitialisable — utile quand un site
 * change de protection et qu'on veut forcer une nouvelle détection sans
 * attendre l'expiration (7 jours).
 *
 * Auth : même clé `x-api-key` que le reste du service.
 */
import { checkAuth } from '../lib/common.mts'
import { listEngines, forgetEngine, domainKey } from '../lib/engine-memory.mts'

export const config = { path: '/engines' }

export default async (req: Request): Promise<Response> => {
  const denied = checkAuth(req)
  if (denied) return denied

  if (req.method === 'GET') {
    const known = await listEngines()
    return Response.json({
      count: Object.keys(known).length,
      engines: known,
      note: 'Appris par observation, jamais codé en dur. Une note expire après 7 jours.',
    })
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url).searchParams.get('url')
    if (!url || !domainKey(url)) {
      return Response.json({ error: 'invalid_url' }, { status: 400 })
    }
    await forgetEngine(url)
    return Response.json({ forgotten: domainKey(url) })
  }

  return Response.json({ error: 'method_not_allowed' }, { status: 405 })
}
