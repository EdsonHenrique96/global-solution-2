import type { Car, Route } from './types'

/** Free-flow speed: 50 km/h, in metres per second (1 network unit = 1 m). */
export const DEFAULT_CAR_SPEED = 50 / 3.6

const MS_PER_MINUTE = 60_000

/**
 * Spawns cars at a configured rate (cars per minute) and assigns routes round-robin.
 * Integer bookkeeping (ms * cars/min) keeps the count exact over any whole number of minutes.
 */
export class CarGenerator {
  private ratePerMinute: number
  private accumulator = 0
  private nextRoute = 0
  private nextId = 1
  private readonly speed: number

  constructor(ratePerMinute: number, speed = DEFAULT_CAR_SPEED) {
    this.ratePerMinute = sanitizeRate(ratePerMinute)
    this.speed = speed
  }

  getRate(): number {
    return this.ratePerMinute
  }

  setRate(ratePerMinute: number): void {
    const next = sanitizeRate(ratePerMinute)
    if (next === this.ratePerMinute) return
    this.ratePerMinute = next
    // Carry no stale budget across a rate change: the new rate starts from now.
    this.accumulator = 0
  }

  tick(dtMs: number, routes: Route[]): Car[] {
    if (this.ratePerMinute === 0 || routes.length === 0) return []
    this.accumulator += dtMs * this.ratePerMinute
    const spawned: Car[] = []
    while (this.accumulator >= MS_PER_MINUTE) {
      this.accumulator -= MS_PER_MINUTE
      const route = routes[this.nextRoute % routes.length]
      this.nextRoute = (this.nextRoute + 1) % routes.length
      spawned.push({ id: this.nextId++, routeId: route.id, distance: 0, speed: this.speed })
    }
    return spawned
  }
}

function sanitizeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) return 0
  return Math.round(rate)
}
