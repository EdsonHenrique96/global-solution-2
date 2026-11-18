import { describe, expect, it } from 'vitest'
import { buildRoadNetwork } from '../sim/roadNetwork'
import type { Drone } from '../sim/types'
import { DroneSensor, type Observation } from './DroneSensor'
import { TelemetryPublisher } from './TelemetryPublisher'
import { FakeTransport } from './testing'

const routes = buildRoadNetwork().routes
const drone = (id: string, x: number, y: number): Drone => ({ id, position: { x, y }, radius: 110 })

function oneWindow(sensor: DroneSensor, drones: Drone[], perTick: (tick: number) => Observation[]) {
  const out = []
  for (let tick = 1; tick <= 100; tick++) out.push(...sensor.observe(100, tick * 100, drones, perTick(tick)))
  return out
}

describe('telemetry', () => {
  describe('DroneSensor', () => {
    it('breaks each reading down per route with count, mean speed and length inside the circle', () => {
      const sensor = new DroneSensor({ noisePct: 0, routes })
      const drones = [drone('D2', 500, 300), drone('D1', 500, 120), drone('DX', 900, 900)]
      const readings = oneWindow(sensor, drones, (tick) => [
        // central: 2 cars at 50 km/h all window, a third stopped car only in the second half
        { x: 450, y: 300, speedKmh: 50, via: 'central' },
        { x: 560, y: 300, speedKmh: 50, via: 'central' },
        ...(tick > 50 ? [{ x: 500, y: 300, speedKmh: 0, via: 'central' }] : []),
        // norte: one car at 30 km/h under D1; also inside D2? no - 180 m away
        { x: 480, y: 120, speedKmh: 30, via: 'norte' },
      ])
      const byId = Object.fromEntries(readings.map((r) => [r.droneId, r]))

      expect(byId.D2.porVia).toEqual([
        { via: 'central', contagem: 3, velocidadeMediaKmh: 40, comprimentoM: 220 },
      ])
      expect(byId.D1.porVia).toEqual([
        { via: 'norte', contagem: 1, velocidadeMediaKmh: 30, comprimentoM: 220 },
      ])
      expect(byId.DX.porVia).toEqual([])
      // aggregate still counts every car in range
      expect(byId.D2.contagem).toBe(3)
    })

    it('reports a crossing route with no car as count 0 and null speed', () => {
      const sensor = new DroneSensor({ noisePct: 0, routes })
      // at the origin-side fork (180, 300) all three routes pass under the circle
      const [r] = oneWindow(sensor, [drone('D9', 180, 300)], () => [])
      expect(r.porVia.map((v) => v.via)).toEqual(['central', 'norte', 'sul'])
      for (const v of r.porVia) {
        expect(v.contagem).toBe(0)
        expect(v.velocidadeMediaKmh).toBeNull()
        expect(v.comprimentoM).toBeGreaterThan(0)
      }
    })
  })

  describe('noise', () => {
    it('applies the same noise to porVia counts and speeds and none to comprimentoM', () => {
      const many: Observation[] = Array.from({ length: 100 }, () => ({ x: 500, y: 300, speedKmh: 100, via: 'central' }))
      const drones = [drone('D2', 500, 300)]

      const exact = new DroneSensor({ noisePct: 0, windowMs: 100, routes })
      const [e] = exact.observe(100, 100, drones, many)
      expect(e.porVia).toEqual([{ via: 'central', contagem: 100, velocidadeMediaKmh: 100, comprimentoM: 220 }])

      const noisy = new DroneSensor({ noisePct: 30, windowMs: 100, routes })
      const counts: number[] = []
      const speeds: number[] = []
      for (let i = 1; i <= 500; i++) {
        const [r] = noisy.observe(100, i * 100, drones, many)
        const [v] = r.porVia
        expect(v.comprimentoM).toBe(220)
        expect(Number.isInteger(v.contagem)).toBe(true)
        counts.push(v.contagem)
        speeds.push(v.velocidadeMediaKmh!)
      }
      for (const x of [...counts, ...speeds]) {
        expect(x).toBeGreaterThanOrEqual(70)
        expect(x).toBeLessThanOrEqual(130)
      }
      expect(Math.min(...counts)).toBeLessThan(80)
      expect(Math.max(...counts)).toBeGreaterThan(120)
      expect(Math.min(...speeds)).toBeLessThan(80)
      expect(Math.max(...speeds)).toBeGreaterThan(120)
    })
  })

  describe('TelemetryPublisher', () => {
    it('publishes porVia as the last key after ruidoPct', () => {
      const transport = new FakeTransport(true)
      new TelemetryPublisher(transport).publish({
        droneId: 'D2',
        ts: 10_000,
        janelaS: 10,
        contagem: 3,
        velocidadeMediaKmh: 40,
        ruidoPct: 10,
        porVia: [{ via: 'central', contagem: 3, velocidadeMediaKmh: 40, comprimentoM: 220 }],
      })
      const payload = JSON.parse(transport.published[0].payload)
      expect(Object.keys(payload)).toEqual([
        'droneId',
        'ts',
        'janelaS',
        'contagem',
        'velocidadeMediaKmh',
        'ruidoPct',
        'porVia',
      ])
      expect(payload.porVia).toEqual([{ via: 'central', contagem: 3, velocidadeMediaKmh: 40, comprimentoM: 220 }])
      expect(Object.keys(payload.porVia[0])).toEqual(['via', 'contagem', 'velocidadeMediaKmh', 'comprimentoM'])
    })
  })
})
