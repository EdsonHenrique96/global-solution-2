export type Phase = 'verde' | 'amarelo' | 'vermelho'

export interface LightState {
  intersectionId: string
  phase: Phase
  /** Seconds left in the current phase (Infinity when lights are always green). */
  remainingS: number
}

const GREEN_MS = 20_000
const YELLOW_MS = 3_000
const RED_MS = 20_000
export const CYCLE_MS = GREEN_MS + YELLOW_MS + RED_MS

/** How far into its cycle each light is at t = 0. */
export const LIGHT_OFFSETS_S: Record<string, number> = { I1: 0, I2: 10, I3: 5, I4: 15 }

/** Fixed-time cycle: verde 20 s -> amarelo 3 s -> vermelho 20 s. Integer ms keeps boundaries exact. */
export function lightAt(intersectionId: string, timeMs: number): LightState {
  const offsetMs = (LIGHT_OFFSETS_S[intersectionId] ?? 0) * 1000
  const local = (((timeMs + offsetMs) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS
  if (local < GREEN_MS) return { intersectionId, phase: 'verde', remainingS: (GREEN_MS - local) / 1000 }
  if (local < GREEN_MS + YELLOW_MS) {
    return { intersectionId, phase: 'amarelo', remainingS: (GREEN_MS + YELLOW_MS - local) / 1000 }
  }
  return { intersectionId, phase: 'vermelho', remainingS: (CYCLE_MS - local) / 1000 }
}
