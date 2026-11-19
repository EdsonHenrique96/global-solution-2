import { cloneRng } from './random'

/** Free-flow speed: 50 km/h, in metres per second (1 network unit = 1 m). */
export const DEFAULT_CAR_SPEED = 50 / 3.6

const MS_PER_MINUTE = 60_000

/**
 * Decides how many cars are born at a configured rate (cars per minute); their trips are drawn by
 * the engine.
 * Integer bookkeeping (ms * cars/min) keeps the count exact over any whole number of minutes.
 */
export class CarGenerator {
  private ratePerMinute: number
  private accumulator = 0
  private readonly arrivals: 'deterministic' | 'poisson'
  private readonly rng: () => number
  /** Poisson mode: ms until the next car. */
  private untilNextMs: number | null = null

  constructor(
    ratePerMinute: number,
    { arrivals = 'deterministic', rng = Math.random }: { arrivals?: 'deterministic' | 'poisson'; rng?: () => number } = {},
  ) {
    this.ratePerMinute = sanitizeRate(ratePerMinute)
    this.arrivals = arrivals
    this.rng = rng
  }

  /** Exponential gap for the current rate, ms. */
  private drawGapMs(): number {
    const u = this.rng()
    return (-Math.log(1 - u) / this.ratePerMinute) * MS_PER_MINUTE
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
    this.untilNextMs = null
  }

  /** A copy at the same point of its sequence. */
  clone(): CarGenerator {
    const c = new CarGenerator(this.ratePerMinute, { arrivals: this.arrivals, rng: cloneRng(this.rng) })
    c.accumulator = this.accumulator
    c.untilNextMs = this.untilNextMs
    return c
  }

  /** Cars due in this step. */
  tick(dtMs: number): number {
    if (this.ratePerMinute === 0) return 0
    let due = 0
    if (this.arrivals === 'poisson') {
      this.untilNextMs ??= this.drawGapMs()
      this.untilNextMs -= dtMs
      while (this.untilNextMs <= 0) {
        due += 1
        this.untilNextMs += this.drawGapMs()
      }
    } else {
      this.accumulator += dtMs * this.ratePerMinute
      while (this.accumulator >= MS_PER_MINUTE) {
        this.accumulator -= MS_PER_MINUTE
        due += 1
      }
    }
    return due
  }
}

function sanitizeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) return 0
  return Math.round(rate)
}
