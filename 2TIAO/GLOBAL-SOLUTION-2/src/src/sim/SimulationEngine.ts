import { advanceCar, routeLength } from './car'
import { CarGenerator, DEFAULT_CAR_SPEED } from './carGenerator'
import { buildRoadNetwork } from './roadNetwork'
import type { Car, RoadNetwork } from './types'

export const TICK_MS = 100
export const DEFAULT_RATE_PER_MINUTE = 30

export interface SimulationState {
  network: RoadNetwork
  cars: readonly Car[]
  /** Cars generated since start; arrivals do not decrease it. */
  spawnedTotal: number
  ratePerMinute: number
}

export interface SimulationOptions {
  ratePerMinute?: number
  speed?: number
}

export class SimulationEngine {
  private readonly network: RoadNetwork
  private readonly generator: CarGenerator
  private readonly lengths: Map<string, number>
  private cars: Car[] = []
  private spawnedTotal = 0

  constructor(options: SimulationOptions = {}) {
    this.network = buildRoadNetwork()
    this.generator = new CarGenerator(
      options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE,
      options.speed ?? DEFAULT_CAR_SPEED,
    )
    this.lengths = new Map(this.network.routes.map((r) => [r.id, routeLength(r)]))
  }

  setRate(ratePerMinute: number): void {
    this.generator.setRate(ratePerMinute)
  }

  getRate(): number {
    return this.generator.getRate()
  }

  /** Move existing cars, drop the ones that arrived, then spawn new ones at the origin. */
  tick(dtMs: number): void {
    this.cars = this.cars
      .map((car) => advanceCar(car, dtMs))
      .filter((car) => car.distance < (this.lengths.get(car.routeId) ?? 0) - 1e-9)
    const spawned = this.generator.tick(dtMs, this.network.routes)
    this.spawnedTotal += spawned.length
    this.cars.push(...spawned)
  }

  getState(): SimulationState {
    return {
      network: this.network,
      cars: this.cars,
      spawnedTotal: this.spawnedTotal,
      ratePerMinute: this.generator.getRate(),
    }
  }
}
