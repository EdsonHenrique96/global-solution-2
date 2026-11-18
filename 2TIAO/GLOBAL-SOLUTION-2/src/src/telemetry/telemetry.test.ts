import { describe, expect, it } from 'vitest'
import { bearing, type FixedCamera } from '../sensors/camera'
import { CoverageIndex } from '../sensors/coverage'
import { SensorReader, type CarSample } from '../sensors/reader'
import { buildSegments, pointOnSegment } from '../sensors/segments'
import { buildCityNetwork } from '../sim/cityNetwork'

const network = buildCityNetwork()
const segments = buildSegments(network)
const corner = (id: string) => network.intersections.find((i) => i.id === id)!.position
// a unit on I11 looking down Al. Santos: its camera and radar see the first block's eastbound lane
const C2: FixedCamera = { id: 'U01', position: corner('I11'), heading: bearing(corner('I11'), corner('I12')), fov: 40, range: 130 }
const index = new CoverageIndex(segments)
index.setCameras([C2])
const santos = segments.find((s) => s.id === 'I11>I12')!
const far = segments.find((s) => s.id === 'I13>I14')!
/** A car `d` metres down the first block (inside cone and beam from 40 m on), or far away (d = 900). */
const at = (d: number, speedKmh: number): CarSample =>
  d >= 900 ? { ...pointOnSegment(far, 60), speedKmh, segmentId: far.id } : { ...pointOnSegment(santos, d), speedKmh, segmentId: santos.id }

describe('telemetry', () => {
  describe('SensorReader', () => {
    it('closes a 10 s window with count at close and mean sampled speed', () => {
      const sensor = new SensorReader({ noisePct: 0 })
      const readings = []
      for (let t = 100; t <= 10_000; t += 100) {
        readings.push(...sensor.observe(100, t, [C2], index, [at(50, 50), at(100, 50), at(80, 0), at(900, 50)]))
        if (t < 10_000) expect(readings).toHaveLength(0)
      }
      expect(readings).toHaveLength(1)
      expect(readings[0]).toMatchObject({ sensorId: 'U01', ts: 10_000, janelaS: 10, contagem: 3, velocidadeMediaKmh: 33.3, ruidoPct: 0 })

      // the mean covers every sample of the window, not the last tick, and the next window starts empty
      const varying = new SensorReader({ noisePct: 0 })
      const first = []
      for (let tick = 1; tick <= 100; tick++) {
        first.push(...varying.observe(100, tick * 100, [C2], index, tick <= 50 ? [at(50, 50), at(100, 50)] : [at(80, 0)]))
      }
      expect(first[0].contagem).toBe(1)
      expect(first[0].velocidadeMediaKmh).toBe(33.3)
      const second = []
      for (let tick = 101; tick <= 200; tick++) second.push(...varying.observe(100, tick * 100, [C2], index, []))
      expect(second[0]).toMatchObject({ ts: 20_000, contagem: 0, velocidadeMediaKmh: null })
    })

    it('reports count 0 and null speed when no car was in range', () => {
      const sensor = new SensorReader({ noisePct: 30 })
      let readings: ReturnType<SensorReader['observe']> = []
      for (let t = 100; t <= 10_000; t += 100) readings = readings.concat(sensor.observe(100, t, [C2], index, [at(900, 50)]))
      expect(readings).toHaveLength(1)
      expect(readings[0].contagem).toBe(0)
      expect(readings[0].velocidadeMediaKmh).toBeNull()
    })
  })

  describe('noise', () => {
    it('applies uniform multiplicative noise within r percent and exact values at r 0', () => {
      const hundredCars = Array.from({ length: 100 }, () => at(80, 100))
      const exact = new SensorReader({ noisePct: 0, windowMs: 100 })
      for (let i = 1; i <= 50; i++) {
        const [r] = exact.observe(100, i * 100, [C2], index, hundredCars)
        expect(r.contagem).toBe(100)
        expect(r.velocidadeMediaKmh).toBe(100)
      }

      const noisy = new SensorReader({ noisePct: 30, windowMs: 100 })
      const counts: number[] = []
      const speeds: number[] = []
      for (let i = 1; i <= 1000; i++) {
        const [r] = noisy.observe(100, i * 100, [C2], index, hundredCars)
        expect(r.ruidoPct).toBe(30)
        expect(Number.isInteger(r.contagem)).toBe(true)
        counts.push(r.contagem)
        speeds.push(r.velocidadeMediaKmh!)
        // the per-segment values get the noise too; covered length and coverage get none
        const [seg] = r.porTrecho
        expect(seg.contagem).toBeGreaterThanOrEqual(70)
        expect(seg.contagem).toBeLessThanOrEqual(130)
        expect(seg.comprimentoCobertoM).toBe(Math.round(index.entries('I11>I12')[0].cobertura * santos.length * 10) / 10)
        expect(seg.cobertura).toBe(Math.round(index.entries('I11>I12')[0].cobertura * 1000) / 1000)
      }
      // the camera's count gets the whole 30 %, the radar's speed half of it (AD-035)
      for (const v of counts) {
        expect(v).toBeGreaterThanOrEqual(70)
        expect(v).toBeLessThanOrEqual(130)
      }
      for (const v of speeds) {
        expect(v).toBeGreaterThanOrEqual(85)
        expect(v).toBeLessThanOrEqual(115)
      }
      expect(Math.min(...counts)).toBeLessThan(75)
      expect(Math.max(...counts)).toBeGreaterThan(125)
      expect(Math.min(...speeds)).toBeLessThan(87.5)
      expect(Math.max(...speeds)).toBeGreaterThan(112.5)
      const below = counts.filter((c) => c < 100).length
      expect(below).toBeGreaterThan(400)
      expect(below).toBeLessThan(600)

      const zero = new SensorReader({ noisePct: 30, windowMs: 100 })
      for (let i = 1; i <= 100; i++) {
        const [r] = zero.observe(100, i * 100, [C2], index, [at(80, 0)])
        expect(r.contagem).toBeGreaterThanOrEqual(0)
        expect(r.velocidadeMediaKmh).toBeGreaterThanOrEqual(0)
      }
    })
  })
})
