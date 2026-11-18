import { describe, expect, it } from 'vitest'
import { buildCityNetwork } from '../sim/cityNetwork'
import { FakeTransport } from '../telemetry/testing'
import { TelemetryPublisher } from '../telemetry/TelemetryPublisher'
import { bearing, cameraPolygon, insidePolygon, type FixedCamera } from './camera'
import { CoverageIndex, COVERAGE_MIN, segmentCoverage } from './coverage'
import { SensorReader, type CarSample } from './reader'
import { buildSegments, pointOnSegment } from './segments'

const network = buildCityNetwork()
const segments = buildSegments(network)
const at = (id: string) => network.intersections.find((i) => i.id === id)!.position
const segOf = (id: string) => segments.find((s) => s.id === id)!
const cam = (id: string, x: number, y: number, heading = 90, fov = 90, range = 100): FixedCamera => ({
  id,
  position: { x, y },
  heading,
  fov,
  range,
})
/** A unit on I11 looking down Al. Santos towards I12. */
const santos = (range = 130, fov = 40) => cam('U01', at('I11').x, at('I11').y, bearing(at('I11'), at('I12')), fov, range)

describe('sensors', () => {
  describe('camera', () => {
    it('builds a GeoJSON sector from position heading FOV and range', () => {
      const poly = cameraPolygon(cam('X', 0, 0, 90, 90, 100))
      expect(poly.type).toBe('Feature')
      expect(poly.geometry.type).toBe('Polygon')
      expect(insidePolygon({ x: 50, y: 0 }, poly)).toBe(true)
      expect(insidePolygon({ x: -50, y: 0 }, poly)).toBe(false)
      expect(insidePolygon({ x: 50, y: 60 }, poly)).toBe(false)
      expect(insidePolygon({ x: 120, y: 0 }, poly)).toBe(false)
      // heading 0 looks up the map (smaller y)
      const up = cameraPolygon(cam('U', 0, 0, 0, 60, 100))
      expect(insidePolygon({ x: 0, y: -50 }, up)).toBe(true)
      expect(insidePolygon({ x: 0, y: 50 }, up)).toBe(false)
    })
  })

  describe('coverage', () => {
    it('computes coverage as length inside over segment length', () => {
      const line = [{ x: 0, y: 0 }, { x: 200, y: 0 }]
      // a camera at (40,0) looking east with a narrow wide-enough cone and 80 m range covers 40..120
      const c = cam('X', 40, 0, 90, 60, 80)
      expect(segmentCoverage(line, cameraPolygon(c))).toBeCloseTo(0.4, 2)
      expect(segmentCoverage([{ x: 50, y: 0 }, { x: 90, y: 0 }], cameraPolygon(c))).toBeCloseTo(1, 6)
      expect(segmentCoverage([{ x: 0, y: 300 }, { x: 200, y: 300 }], cameraPolygon(c))).toBe(0)

      const index = new CoverageIndex(segments)
      index.setCameras([cam('far', 5000, 5000)])
      for (const s of segments) expect(index.entries(s.id)).toEqual([])
      // on I12, close enough for the R-tree to propose Al. Santos, but looking back up R. Bela Cintra (away from it)
      const away = cam('away', at('I12').x, at('I12').y, bearing(at('I22'), at('I12')), 20, 100)
      const near = new CoverageIndex(segments)
      near.setCameras([away])
      expect(segmentCoverage(segOf('I12>I13').points, cameraPolygon(away))).toBe(0)
      expect(near.entries('I12>I13')).toEqual([])
    })

    it('rebuilds the index only when a camera changes', () => {
      const index = new CoverageIndex(segments)
      const c = santos()
      index.setCameras([c])
      expect(index.rebuilds).toBe(1)
      expect(index.entries('I11>I12')).toEqual([{ sensorId: 'U01', tipo: 'camera+radar', cobertura: expect.any(Number) }])

      // same camera again (as on every tick): no rebuild
      for (let i = 0; i < 100; i++) index.updateCamera({ ...c })
      expect(index.rebuilds).toBe(1)

      for (const change of [{ position: { x: c.position.x + 10, y: c.position.y } }, { heading: c.heading - 10 }, { fov: 60 }, { range: 200 }]) {
        const n = index.rebuilds
        index.updateCamera({ ...c, ...change })
        expect(index.rebuilds, JSON.stringify(change)).toBe(n + 1)
        index.updateCamera({ ...c, ...change })
        expect(index.rebuilds).toBe(n + 1)
      }
    })
  })

  describe('reader', () => {
    const window = (reader: SensorReader, cameras: FixedCamera[], index: CoverageIndex, perTick: (tick: number) => CarSample[]) => {
      const out = []
      for (let tick = 1; tick <= 100; tick++) out.push(...reader.observe(100, tick * 100, cameras, index, perTick(tick)))
      return out
    }
    const on = (id: string, d: number, speedKmh: number): CarSample => ({ ...pointOnSegment(segOf(id), d), speedKmh, segmentId: id })

    it('counts only cars inside the camera polygon', () => {
      const u = santos()
      const index = new CoverageIndex(segments)
      index.setCameras([u])
      const reader = new SensorReader({ noisePct: 0 })
      const [r] = window(reader, [u], index, () => [
        on('I11>I12', 60, 50), // inside the cone
        on('I21>I11', 60, 50), // up R. da Consolação, behind and beside the camera
      ])
      expect(r.contagem).toBe(1)
      expect(r.porTrecho.find((t) => t.trecho === 'I11>I12')!.contagem).toBe(1)
    })

    it('reports per segment only where coverage is at least 0.3', () => {
      // a long cone down Al. Santos: the whole first block, and only a sliver of the next one
      const u = santos(165, 30)
      const index = new CoverageIndex(segments)
      index.setCameras([u])
      const cov = (id: string) => index.entries(id).find((e) => e.sensorId === 'U01')?.cobertura ?? 0
      expect(cov('I11>I12')).toBeGreaterThanOrEqual(COVERAGE_MIN)
      expect(cov('I12>I13')).toBeGreaterThan(0)
      expect(cov('I12>I13')).toBeLessThan(COVERAGE_MIN)
      const reader = new SensorReader({ noisePct: 0 })
      const [r] = window(reader, [u], index, (tick) => [
        on('I11>I12', 70, 40),
        ...(tick > 50 ? [on('I11>I12', 100, 20)] : []),
        on('I12>I13', 5, 45),
      ])
      expect(r.porTrecho.map((t) => t.trecho)).not.toContain('I12>I13')
      const first = r.porTrecho.find((t) => t.trecho === 'I11>I12')!
      expect(first).toEqual({
        trecho: 'I11>I12',
        contagem: 2,
        fonteContagem: 'visao-computacional',
        velocidadeMediaKmh: 33.3, // radar: (100 x 40 + 50 x 20) / 150
        fonteVelocidade: 'radar',
        amostrasRadar: 150,
        comprimentoCobertoM: Math.round(cov('I11>I12') * segOf('I11>I12').length * 10) / 10,
        cobertura: Math.round(cov('I11>I12') * 1000) / 1000,
      })
      expect(r.contagem).toBe(3) // the camera still counts every car in its cone
    })
  })

  describe('publisher', () => {
    it('adds noise to count and speed but not to covered length and coverage', () => {
      const transport = new FakeTransport(true)
      const u = santos()
      const index = new CoverageIndex(segments)
      index.setCameras([u])
      const cover = index.entries('I11>I12')[0].cobertura
      const reader = new SensorReader({ noisePct: 30, windowMs: 100 })
      const publisher = new TelemetryPublisher(transport)
      const cars = Array.from({ length: 100 }, () => ({ ...pointOnSegment(segOf('I11>I12'), 60), speedKmh: 100, segmentId: 'I11>I12' }))
      for (let i = 1; i <= 300; i++) for (const r of reader.observe(100, i * 100, [u], index, cars)) publisher.publish(r)
      expect(transport.published).toHaveLength(300)
      const counts: number[] = []
      const speeds: number[] = []
      for (const m of transport.published) {
        expect(m.options).toEqual({ qos: 0, retain: false })
        const seg = JSON.parse(m.payload).porTrecho[0]
        counts.push(seg.contagem)
        speeds.push(seg.velocidadeMediaKmh)
        expect(seg.comprimentoCobertoM).toBe(Math.round(cover * segOf('I11>I12').length * 10) / 10)
        expect(seg.cobertura).toBe(Math.round(cover * 1000) / 1000)
      }
      // camera: the whole 30 %; radar: half of it
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(70)
      expect(Math.max(...counts)).toBeLessThanOrEqual(130)
      expect(Math.min(...counts)).toBeLessThan(80)
      expect(Math.max(...counts)).toBeGreaterThan(120)
      expect(Math.min(...speeds)).toBeGreaterThanOrEqual(85)
      expect(Math.max(...speeds)).toBeLessThanOrEqual(115)
      expect(Math.min(...speeds)).toBeLessThan(90)
      expect(Math.max(...speeds)).toBeGreaterThan(110)
    })
  })
})
