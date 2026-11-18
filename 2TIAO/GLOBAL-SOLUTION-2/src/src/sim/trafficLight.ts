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

export const ADAPTIVE_BASE_GREEN_S = 20
export const ADAPTIVE_K_S_PER_CAR = 2
export const ADAPTIVE_MIN_GREEN_S = 15
/** ±10 s around the base is automatic; more needs approval (Day 5). */
export const ADAPTIVE_MAX_GREEN_S = 30
const ADAPTIVE_YELLOW_MS = 3_000
const ADAPTIVE_RED_MS = 20_000

/** Green for an approach: 20 + 2 (queue - average queue) s, clamped to 15-30 s (AD-015). */
export function adaptiveGreenS(queue: number, averageQueue: number): number {
  const raw = ADAPTIVE_BASE_GREEN_S + ADAPTIVE_K_S_PER_CAR * (queue - averageQueue)
  return Math.min(ADAPTIVE_MAX_GREEN_S, Math.max(ADAPTIVE_MIN_GREEN_S, raw))
}

/**
 * The lights of every intersection: the fixed-time cycle, or, when adaptive, a cycle whose green
 * is set from the queues at the start of each green. Turning adaptive on continues from the
 * fixed cycle's current phase; turning it off returns to the fixed cycle.
 */
export class SignalController {
  private adaptive = false
  private readonly state = new Map<string, { phase: Phase; endsAtMs: number }>()
  private readonly ids: readonly string[]

  constructor(intersectionIds: readonly string[]) {
    this.ids = intersectionIds
  }

  isAdaptive(): boolean {
    return this.adaptive
  }

  setAdaptive(on: boolean, timeMs: number): void {
    if (on === this.adaptive) return
    this.adaptive = on
    this.state.clear()
    if (on) {
      for (const id of this.ids) {
        const l = lightAt(id, timeMs)
        this.state.set(id, { phase: l.phase, endsAtMs: timeMs + Math.round(l.remainingS * 1000) })
      }
    }
  }

  /** Moves adaptive lights past every phase that ended by `timeMs`; `queueOf` is read at green. */
  advance(timeMs: number, queueOf: (intersectionId: string) => number): void {
    if (!this.adaptive) return
    for (const id of this.ids) {
      const s = this.state.get(id)!
      while (timeMs >= s.endsAtMs) {
        if (s.phase === 'verde') {
          s.phase = 'amarelo'
          s.endsAtMs += ADAPTIVE_YELLOW_MS
        } else if (s.phase === 'amarelo') {
          s.phase = 'vermelho'
          s.endsAtMs += ADAPTIVE_RED_MS
        } else {
          const queues = this.ids.map((i) => queueOf(i))
          const average = queues.reduce((a, b) => a + b, 0) / queues.length
          s.phase = 'verde'
          s.endsAtMs += adaptiveGreenS(queueOf(id), average) * 1000
        }
      }
    }
  }

  lights(timeMs: number): LightState[] {
    return this.ids.map((id) => {
      if (!this.adaptive) return lightAt(id, timeMs)
      const s = this.state.get(id)!
      return { intersectionId: id, phase: s.phase, remainingS: (s.endsAtMs - timeMs) / 1000 }
    })
  }
}
