import type { Segment } from '../sensors/segments'
import { shortestPath } from '../sim/graph'
import type { AppName } from '../sim/types'

/** A segment with no measured speed is crossed at this speed (AC 23). */
export const FALLBACK_KMH = 40
/** A standing segment still takes a finite time. */
export const MIN_KMH = 2
/** The alternative must take at most this share of the current path's time (AC 23). */
export const MAX_TIME_RATIO = 0.9

/** What the rerouter needs of a car: what the driver's map app knows. */
export interface DriverView {
  id: number
  app: AppName | null
  path: readonly string[]
  seg: number
  saida: string
}

export interface Candidate {
  carId: number
  app: AppName
  /** Corner the new path would start at: the end of the current segment. */
  from: string
  saida: string
  /** The path after the current segment. */
  current: string[]
}

export interface Evaluation extends Candidate {
  alternative: string[] | null
  currentS: number
  altS: number | null
  gainS: number
  /** The alternative takes at most 90% of the current time. */
  ok: boolean
}

/** Seconds to cross a segment at a speed in km/h; null -> 40 km/h. */
export function segmentTimeS(length: number, speedKmh: number | null): number {
  const v = speedKmh === null ? FALLBACK_KMH : Math.max(MIN_KMH, speedKmh)
  return length / (v / 3.6)
}

/**
 * Drivers who can be told about a jammed segment (AC 22): a map app open, and the segment still
 * ahead of them after the one they are on - not entered, not passed. A waiting car is on its first
 * segment, so the same rule holds.
 */
export function candidatesFor(cars: readonly DriverView[], jammedId: string, segById: ReadonlyMap<string, Segment>): Candidate[] {
  const out: Candidate[] = []
  for (const car of cars) {
    if (!car.app) continue
    if (car.path.indexOf(jammedId, car.seg + 1) === -1) continue
    out.push({
      carId: car.id,
      app: car.app,
      from: segById.get(car.path[car.seg])!.to,
      saida: car.saida,
      current: car.path.slice(car.seg + 1),
    })
  }
  return out
}

/** Compares the current path with the fastest one to the same exit that avoids the jammed segment (AC 23). */
export function evaluate(
  c: Candidate,
  segments: readonly Segment[],
  speedOf: (segmentId: string) => number | null,
  jammedId: string,
): Evaluation {
  const byId = new Map(segments.map((s) => [s.id, s]))
  const time = (id: string) => segmentTimeS(byId.get(id)!.length, speedOf(id))
  const currentS = c.current.reduce((t, id) => t + time(id), 0)
  const alternative = shortestPath(segments, c.from, c.saida, (s) => time(s.id), new Set([jammedId]))
  const altS = alternative ? alternative.reduce((t, id) => t + time(id), 0) : null
  const ok = alternative !== null && alternative.length > 0 && altS !== null && altS <= MAX_TIME_RATIO * currentS + 1e-9
  return { ...c, alternative, currentS, altS, gainS: altS === null ? 0 : currentS - altS, ok }
}

/**
 * Who gets the notice this window (AC 24): partial diversion notifies at most ceil(p x candidates),
 * largest gain first; "notificar todos" notifies everyone whose alternative passes.
 */
export function selectNotified(evals: readonly Evaluation[], mode: 'parcial' | 'todos', p: number): Evaluation[] {
  const passing = evals.filter((e) => e.ok).sort((a, b) => b.gainS - a.gainS || a.carId - b.carId)
  if (mode === 'todos') return passing
  return passing.slice(0, Math.ceil(Math.max(0, p) * evals.length - 1e-9))
}

/** Drivers on the jammed segment without an app: the camera's count minus the apps' drivers there, never negative (AC 26). */
export function outOfReach(cameraCount: number | null, appDrivers: number): number | null {
  return cameraCount === null ? null : Math.max(0, cameraCount - appDrivers)
}
