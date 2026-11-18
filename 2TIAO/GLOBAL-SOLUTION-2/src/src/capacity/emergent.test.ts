import { describe, expect, it } from 'vitest'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { wireTelemetry } from '../telemetry/TelemetryPublisher'
import { FakeTransport } from '../telemetry/testing'
import type { Reading } from '../telemetry/DroneSensor'
import { CapacityService } from './CapacityService'

/** 10 simulated minutes at 120 cars/min, noise 0, readings through the (fake) broker. */
function tenMinutes() {
  const engine = new SimulationEngine({ ratePerMinute: 120, noisePct: 0 })
  const transport = new FakeTransport(true)
  const service = new CapacityService(transport, () => engine.getState().timeMs)
  service.start()
  wireTelemetry(engine, transport)
  const readings: Reading[] = []
  engine.onReading((r) => readings.push(r))
  for (let t = 0; t < 600_000; t += TICK_MS) engine.tick(TICK_MS)
  return { readings, service }
}

const run = tenMinutes()

describe('capacity', () => {
  describe('emergent', () => {
    it('drones see lower mean speed at high density over 10 minutes at 120 cars per minute', () => {
      const samples = run.readings.flatMap((r) =>
        r.porVia
          .filter((v) => v.velocidadeMediaKmh !== null && v.comprimentoM > 0)
          .map((v) => ({ k: v.contagem / (v.comprimentoM / 1000), v: v.velocidadeMediaKmh! })),
      )
      const dense = samples.filter((s) => s.k >= 40)
      const light = samples.filter((s) => s.k <= 15)
      expect(dense.length).toBeGreaterThan(5)
      expect(light.length).toBeGreaterThan(5)
      const mean = (xs: { v: number }[]) => xs.reduce((a, s) => a + s.v, 0) / xs.length
      expect(mean(dense)).toBeLessThan(mean(light))
    })

    it('central learns a capacity between 500 and 3000 and kj between 60 and 250', () => {
      const central = run.service.snapshot().central
      expect(central.capacidade).not.toBeNull()
      expect(central.capacidade!).toBeGreaterThanOrEqual(500)
      expect(central.capacidade!).toBeLessThanOrEqual(3000)
      expect(central.kj!).toBeGreaterThanOrEqual(60)
      expect(central.kj!).toBeLessThanOrEqual(250)
    })
  })
})
