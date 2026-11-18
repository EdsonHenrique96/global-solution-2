import type { Axis } from './types'

/** 'piscante': flashing yellow, the corner is out of its cycle (AD-056). */
export type Phase = 'verde' | 'amarelo' | 'vermelho' | 'piscante'

/** One intersection's light: the phase of the alameda approaches (H) and of the rua approaches (V). */
export interface LightState {
  intersectionId: string
  h: Phase
  v: Phase
  /** Seconds left in the current stage (Infinity when lights are always green). */
  remainingS: number
}

export const GREEN_MS = 20_000
export const YELLOW_MS = 3_000
/** Fixed cycle: H verde 20 s, H amarelo 3 s, V verde 20 s, V amarelo 3 s. */
export const CYCLE_MS = 2 * (GREEN_MS + YELLOW_MS)

/** How far into its cycle each light is at t = 0: a green wave of 10 s per block down the alamedas. */
export function lightOffsetS(intersectionId: string): number {
  const col = Number(intersectionId.slice(2)) || 1
  const row = Number(intersectionId.slice(1, 2)) || 1
  return ((col - 1) * 10 + (row - 1) * 5) % (CYCLE_MS / 1000)
}

type Stage = { axis: Axis; phase: 'verde' | 'amarelo' }

function stageLight(intersectionId: string, stage: Stage, remainingS: number): LightState {
  const other: Phase = 'vermelho'
  return stage.axis === 'H'
    ? { intersectionId, h: stage.phase, v: other, remainingS }
    : { intersectionId, h: other, v: stage.phase, remainingS }
}

/** The fixed-time light. Integer ms keeps the boundaries exact. Never green on both axes. */
export function lightAt(intersectionId: string, timeMs: number): LightState {
  const local = (((timeMs + lightOffsetS(intersectionId) * 1000) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS
  const half = GREEN_MS + YELLOW_MS
  const axis: Axis = local < half ? 'H' : 'V'
  const inStage = local % half
  if (inStage < GREEN_MS) return stageLight(intersectionId, { axis, phase: 'verde' }, (GREEN_MS - inStage) / 1000)
  return stageLight(intersectionId, { axis, phase: 'amarelo' }, (half - inStage) / 1000)
}

/** The phase a car on an approach along `axis` sees. */
export function phaseFor(light: LightState, axis: Axis): Phase {
  return axis === 'H' ? light.h : light.v
}

export const ADAPTIVE_BASE_GREEN_S = 20
export const ADAPTIVE_K_S_PER_CAR = 2
export const ADAPTIVE_MIN_GREEN_S = 15
/** ±10 s around the base is automatic; more needs approval. */
export const ADAPTIVE_MAX_GREEN_S = 30

/** Green for a phase: 20 + 2 (its queue - mean queue of the two phases) s, clamped to 15-30 s (AD-015, AD-044). */
export function adaptiveGreenS(queue: number, averageQueue: number): number {
  const raw = ADAPTIVE_BASE_GREEN_S + ADAPTIVE_K_S_PER_CAR * (queue - averageQueue)
  return Math.min(ADAPTIVE_MAX_GREEN_S, Math.max(ADAPTIVE_MIN_GREEN_S, raw))
}

/**
 * The lights of every intersection: the fixed cycle, or, when adaptive, each intersection
 * alternates H and V with each green set when it starts from the queues of the two phases there
 * (AD-044). Turning adaptive on continues from the fixed cycle's current stage.
 */
export class SignalController {
  private adaptive = false
  private readonly state = new Map<string, { stage: Stage; endsAtMs: number }>()
  /** Greens set from outside (agent or operator) for the next green of a phase, seconds. */
  private readonly nextGreen = new Map<string, number>()
  private readonly ids: readonly string[]

  constructor(intersectionIds: readonly string[]) {
    this.ids = intersectionIds
  }

  isAdaptive(): boolean {
    return this.adaptive
  }

  /** Sets the length of a phase's next green (adaptive mode only). Returns whether it was taken. */
  setNextGreen(intersectionId: string, axis: Axis, seconds: number): boolean {
    if (!this.adaptive || !this.ids.includes(intersectionId)) return false
    this.nextGreen.set(`${intersectionId}:${axis}`, seconds)
    return true
  }

  setAdaptive(on: boolean, timeMs: number): void {
    if (on === this.adaptive) return
    this.adaptive = on
    this.state.clear()
    if (on) {
      for (const id of this.ids) {
        const l = lightAt(id, timeMs)
        const axis: Axis = l.h !== 'vermelho' ? 'H' : 'V'
        const phase = (axis === 'H' ? l.h : l.v) as Stage['phase']
        this.state.set(id, { stage: { axis, phase }, endsAtMs: timeMs + Math.round(l.remainingS * 1000) })
      }
    }
  }

  /** Moves adaptive lights past every stage that ended by `timeMs`; queues are read when a green starts. */
  advance(timeMs: number, queueOf: (intersectionId: string, axis: Axis) => number): void {
    if (!this.adaptive) return
    for (const id of this.ids) {
      const s = this.state.get(id)!
      while (timeMs >= s.endsAtMs) {
        if (s.stage.phase === 'verde') {
          s.stage = { axis: s.stage.axis, phase: 'amarelo' }
          s.endsAtMs += YELLOW_MS
        } else {
          const axis: Axis = s.stage.axis === 'H' ? 'V' : 'H'
          const mine = queueOf(id, axis)
          const average = (mine + queueOf(id, s.stage.axis)) / 2
          const key = `${id}:${axis}`
          const chosen = this.nextGreen.get(key)
          this.nextGreen.delete(key)
          s.stage = { axis, phase: 'verde' }
          s.endsAtMs += (chosen ?? adaptiveGreenS(mine, average)) * 1000
        }
      }
    }
  }

  lights(timeMs: number): LightState[] {
    return this.ids.map((id) => {
      if (!this.adaptive) return lightAt(id, timeMs)
      const s = this.state.get(id)!
      return stageLight(id, s.stage, (s.endsAtMs - timeMs) / 1000)
    })
  }
}
