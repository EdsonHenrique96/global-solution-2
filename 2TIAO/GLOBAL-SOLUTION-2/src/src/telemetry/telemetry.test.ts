import { describe, expect, it } from 'vitest'
import { DroneSensor, type Observation } from './DroneSensor'
import { TelemetryPublisher } from './TelemetryPublisher'
import { FakeTransport } from './testing'
import type { Drone } from '../sim/types'

const drone = (id: string, x: number, y: number): Drone => ({ id, position: { x, y }, radius: 110 })

describe('telemetry', () => {
  describe('DroneSensor', () => {
    it('closes a 10 s window with count at close and mean sampled speed', () => {
      const sensor = new DroneSensor({ noisePct: 0 })
      const drones = [drone('D2', 500, 300)]
      const inRange: Observation[] = [
        { x: 450, y: 300, speedKmh: 50 },
        { x: 560, y: 300, speedKmh: 50 },
        { x: 500, y: 300, speedKmh: 0 },
      ]
      const outOfRange: Observation = { x: 900, y: 300, speedKmh: 50 }
      const readings = []
      for (let t = 100; t <= 10_000; t += 100) {
        readings.push(...sensor.observe(100, t, drones, [...inRange, outOfRange]))
        if (t < 10_000) expect(readings).toHaveLength(0)
      }
      expect(readings).toHaveLength(1)
      expect(readings[0]).toEqual({
        droneId: 'D2',
        ts: 10_000,
        janelaS: 10,
        contagem: 3,
        velocidadeMediaKmh: 33.3,
        ruidoPct: 0,
        porVia: [],
      })

      // the mean covers every sample of the window, not the last tick, and the next window starts empty
      const varying = new DroneSensor({ noisePct: 0 })
      const twoMoving: Observation[] = [
        { x: 450, y: 300, speedKmh: 50 },
        { x: 560, y: 300, speedKmh: 50 },
      ]
      const oneStopped: Observation[] = [{ x: 500, y: 300, speedKmh: 0 }]
      const first = []
      for (let tick = 1; tick <= 100; tick++) {
        first.push(...varying.observe(100, tick * 100, drones, tick <= 50 ? twoMoving : oneStopped))
      }
      // 100 samples at 50 km/h + 50 at 0 -> 33.3; at the close only the stopped car is in range
      expect(first).toHaveLength(1)
      expect(first[0].contagem).toBe(1)
      expect(first[0].velocidadeMediaKmh).toBe(33.3)

      const second = []
      for (let tick = 101; tick <= 200; tick++) second.push(...varying.observe(100, tick * 100, drones, []))
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({ ts: 20_000, contagem: 0, velocidadeMediaKmh: null })
    })

    it('reports count 0 and null speed when no car was in range', () => {
      const sensor = new DroneSensor({ noisePct: 30 })
      const drones = [drone('D1', 500, 120)]
      let readings: ReturnType<DroneSensor['observe']> = []
      for (let t = 100; t <= 10_000; t += 100) {
        readings = readings.concat(sensor.observe(100, t, drones, [{ x: 500, y: 480, speedKmh: 50 }]))
      }
      expect(readings).toHaveLength(1)
      expect(readings[0].contagem).toBe(0)
      expect(readings[0].velocidadeMediaKmh).toBeNull()
    })
  })

  describe('noise', () => {
    it('applies uniform multiplicative noise within r percent and exact values at r 0', () => {
      const hundredCars: Observation[] = Array.from({ length: 100 }, () => ({ x: 500, y: 300, speedKmh: 100 }))
      const drones = [drone('D2', 500, 300)]

      const exact = new DroneSensor({ noisePct: 0, windowMs: 100 })
      for (let i = 1; i <= 50; i++) {
        const [r] = exact.observe(100, i * 100, drones, hundredCars)
        expect(r.contagem).toBe(100)
        expect(r.velocidadeMediaKmh).toBe(100)
      }

      const noisy = new DroneSensor({ noisePct: 30, windowMs: 100 })
      const counts: number[] = []
      const speeds: number[] = []
      for (let i = 1; i <= 1000; i++) {
        const [r] = noisy.observe(100, i * 100, drones, hundredCars)
        expect(r.ruidoPct).toBe(30)
        expect(Number.isInteger(r.contagem)).toBe(true)
        counts.push(r.contagem)
        speeds.push(r.velocidadeMediaKmh!)
      }
      for (const v of [...counts, ...speeds]) {
        expect(v).toBeGreaterThanOrEqual(70)
        expect(v).toBeLessThanOrEqual(130)
      }
      // uniform across the band, not a constant offset
      expect(Math.min(...counts)).toBeLessThan(75)
      expect(Math.max(...counts)).toBeGreaterThan(125)
      expect(Math.min(...speeds)).toBeLessThan(75)
      expect(Math.max(...speeds)).toBeGreaterThan(125)
      const below = counts.filter((c) => c < 100).length
      expect(below).toBeGreaterThan(400)
      expect(below).toBeLessThan(600)

      // never negative
      const zero = new DroneSensor({ noisePct: 30, windowMs: 100 })
      for (let i = 1; i <= 100; i++) {
        const [r] = zero.observe(100, i * 100, drones, [{ x: 500, y: 300, speedKmh: 0 }])
        expect(r.contagem).toBeGreaterThanOrEqual(0)
        expect(r.velocidadeMediaKmh).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('TelemetryPublisher', () => {
    it('publishes each reading to its drone topic as JSON with QoS 0 and no retain', () => {
      const transport = new FakeTransport(true)
      const publisher = new TelemetryPublisher(transport)
      const reading = { droneId: 'D3', ts: 20_000, janelaS: 10, contagem: 4, velocidadeMediaKmh: null, ruidoPct: 10, porVia: [] }
      publisher.publish(reading)
      publisher.publish({ ...reading, droneId: 'D1', velocidadeMediaKmh: 42.5 })

      expect(transport.published).toHaveLength(2)
      const [first, second] = transport.published
      expect(first.topic).toBe('transito/drones/D3/telemetria')
      expect(first.options).toEqual({ qos: 0, retain: false })
      expect(JSON.parse(first.payload)).toEqual({
        droneId: 'D3',
        ts: 20_000,
        janelaS: 10,
        contagem: 4,
        velocidadeMediaKmh: null,
        ruidoPct: 10,
        porVia: [],
      })
      expect(Object.keys(JSON.parse(first.payload))).toEqual([
        'droneId',
        'ts',
        'janelaS',
        'contagem',
        'velocidadeMediaKmh',
        'ruidoPct',
        'porVia',
      ])
      expect(second.topic).toBe('transito/drones/D1/telemetria')
      expect(JSON.parse(second.payload).velocidadeMediaKmh).toBe(42.5)
    })
  })
})
