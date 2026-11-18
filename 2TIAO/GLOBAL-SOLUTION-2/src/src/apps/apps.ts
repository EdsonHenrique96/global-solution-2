import type { AppName } from '../sim/types'

export const APP_NAMES: readonly AppName[] = ['waze', 'google-maps', 'outros']
export const APP_LABELS: Record<AppName, string> = { waze: 'Waze', 'google-maps': 'Google Maps', outros: 'Outros' }

/** Share of drivers with a map app open (plan Assumptions). */
export const DEFAULT_APP_SHARE = 0.6
/** Among drivers with an app, which one. */
export const APP_SPLIT: Record<AppName, number> = { waze: 0.4, 'google-maps': 0.5, outros: 0.1 }

/** Draws whether a new driver has a map app open and which one (AC 20). */
export function drawApp(rng: () => number, share = DEFAULT_APP_SHARE): AppName | null {
  if (rng() >= share) return null
  const u = rng()
  let acc = 0
  for (const app of APP_NAMES) {
    acc += APP_SPLIT[app]
    if (u < acc) return app
  }
  return APP_NAMES[APP_NAMES.length - 1]
}
