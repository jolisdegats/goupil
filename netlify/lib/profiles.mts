/**
 * Registered extraction profiles — versioned JSON files under profiles/,
 * statically bundled so no runtime fs access is needed. A profile describes a
 * DOMAIN (lodging, product…), never a consuming app: that's what keeps goupil
 * agnostic while letting each app call with just `{ url, profile: "…" }`.
 *
 * Adding one = drop profiles/<name>.json + one import line here.
 */
import lodging from '../../profiles/lodging.json'

export const PROFILES: Record<string, Record<string, unknown>> = {
  lodging: lodging as Record<string, unknown>,
}
