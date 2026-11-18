/** Diversions up to this fraction apply at once; larger ones wait for the operator. */
export const AUTO_DIVERSION_MAX = 0.3
export const GREEN_AUTO = { min: 10, max: 30 } as const
export const GREEN_APPROVAL_MAX = 60

export type Verdict = 'aplicar' | 'aprovar' | 'recusar'

export function decideDiversion(p: number): Exclude<Verdict, 'recusar'> {
  return p <= AUTO_DIVERSION_MAX ? 'aplicar' : 'aprovar'
}

export function decideGreen(seconds: number): Verdict {
  if (seconds < GREEN_AUTO.min || seconds > GREEN_APPROVAL_MAX) return 'recusar'
  return seconds <= GREEN_AUTO.max ? 'aplicar' : 'aprovar'
}
