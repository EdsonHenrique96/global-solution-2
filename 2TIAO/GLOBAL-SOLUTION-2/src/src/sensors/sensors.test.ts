import { describe, expect, it } from 'vitest'
import { routeLength } from '../sim/car'
import { buildRoadNetwork } from '../sim/roadNetwork'
import { cameraPolygon, insidePolygon, type FixedCamera } from './camera'
import { CoverageIndex, COVERAGE_MIN, segmentCoverage } from './coverage'
import { SensorReader, type CarSample } from './reader'
import { buildSegments } from './segments'

const network = buildRoadNetwork()
const segments = buildSegments(network)
const cam = (id: string, x: number, y: number, heading = 90, fov = 90, range = 100): FixedCamera => ({
  id,
  position: { x, y },
  heading,
  fov,
  range,
})

describe('sensors', () => {
  describe('segments', () => {
    it('splits the network into 11 segments whose lengths add up to each route', () => {
      expect(segments.map((s) => s.id).sort()).toEqual(
        [
          'central-entrada', 'norte-entrada', 'sul-entrada',
          'central-F-I1', 'central-I1-I2', 'central-I2-M',
          'norte-F-I3', 'norte-I3-M', 'sul-F-I4', 'sul-I4-M', 'chegada',
        ].sort(),
      )
      const byId = Object.fromEntries(segments.map((s) => [s.id, s]))
      expect(byId['central-I1-I2'].length).toBeCloseTo(400, 6)
      expect(byId.chegada.length).toBeCloseTo(120, 6)
      expect(byId['norte-I3-M'].length).toBeCloseTo(416.3, 1)
      expect(byId.chegada.routeIds.sort()).toEqual(['central', 'norte', 'sul'])
      expect(byId['central-I1-I2'].routeIds).toEqual(['central'])
      for (const route of network.routes) {
        const total = segments.filter((s) => s.routeIds.includes(route.id)).reduce((a, s) => a + s.length, 0)
        expect(total, route.id).toBeCloseTo(routeLength(route), 6)
        // the polyline of each segment starts where the previous one ends
        const ordered = segments.filter((s) => s.routeIds.includes(route.id)).sort((a, b) => a.from[route.id] - b.from[route.id])
        for (let i = 1; i < ordered.length; i++) {
          expect(ordered[i].from[route.id]).toBeCloseTo(ordered[i - 1].to[route.id], 9)
          expect(ordered[i].points[0]).toEqual(ordered[i - 1].points[ordered[i - 1].points.length - 1])
        }
      }
    })
  })

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
      // close enough for the R-tree to propose central I1-I2, but the cone looks away from it
      const away = cam('away', 500, 320, 180, 60, 100)
      const near = new CoverageIndex(segments)
      near.setCameras([away])
      expect(segmentCoverage(segments.find((x) => x.id === 'central-I1-I2')!.points, cameraPolygon(away))).toBe(0)
      expect(near.entries('central-I1-I2')).toEqual([])
    })

    it('rebuilds the index only when a camera changes', () => {
      const index = new CoverageIndex(segments)
      const c = cam('C2', 420, 330, 90, 70, 260)
      index.setCameras([c])
      expect(index.rebuilds).toBe(1)
      const before = index.entries('central-I1-I2')
      expect(before).toEqual([{ sensorId: 'C2', tipo: 'fixo', cobertura: expect.any(Number) }])

      // same camera again (as on every tick): no rebuild
      for (let i = 0; i < 100; i++) index.updateCamera({ ...c })
      expect(index.rebuilds).toBe(1)

      for (const change of [{ position: { x: 430, y: 330 } }, { heading: 80 }, { fov: 60 }, { range: 200 }]) {
        const n = index.rebuilds
        index.updateCamera({ ...c, ...change })
        expect(index.rebuilds, JSON.stringify(change)).toBe(n + 1)
        index.updateCamera({ ...c, ...change })
        expect(index.rebuilds).toBe(n + 1)
      }
    })

    it('default cameras cover the segment after each light', async () => {
      const { DEFAULT_CAMERAS } = await import('./camera')
      const index = new CoverageIndex(segments)
      index.setCameras(DEFAULT_CAMERAS)
      const cov = (segment: string, sensor: string) =>
        index.entries(segment).find((e) => e.sensorId === sensor)?.cobertura ?? 0
      expect(cov('norte-I3-M', 'C1')).toBeGreaterThanOrEqual(COVERAGE_MIN)
      expect(cov('central-I1-I2', 'C2')).toBeGreaterThanOrEqual(COVERAGE_MIN)
      expect(cov('sul-I4-M', 'C3')).toBeGreaterThanOrEqual(COVERAGE_MIN)
    })
  })

  describe('reader', () => {
    const window = (reader: SensorReader, cameras: FixedCamera[], index: CoverageIndex, perTick: (tick: number) => CarSample[]) => {
      const out = []
      for (let tick = 1; tick <= 100; tick++) out.push(...reader.observe(100, tick * 100, cameras, index, perTick(tick)))
      return out
    }

    it('counts only cars inside the camera polygon', () => {
      const c2 = cam('C2', 420, 330, 90, 70, 260)
      const index = new CoverageIndex(segments)
      index.setCameras([c2])
      const reader = new SensorReader({ noisePct: 0 })
      const [r] = window(reader, [c2], index, () => [
        { x: 500, y: 300, speedKmh: 50, segmentId: 'central-I1-I2' }, // inside the cone
        { x: 320, y: 300, speedKmh: 50, segmentId: 'central-I1-I2' }, // same segment, behind the camera
      ])
      expect(r.contagem).toBe(1)
      expect(r.porTrecho.find((t) => t.trecho === 'central-I1-I2')!.contagem).toBe(1)
    })

    it('reports per segment only where coverage is at least 0.3', () => {
      // looking east from (650,300): central I1-I2 0.125 and chegada 0.25 are in the index but below 0.3
      const edge = cam('C8', 650, 300, 90, 70, 200)
      const edgeIndex = new CoverageIndex(segments)
      edgeIndex.setCameras([edge])
      const covOf = (id: string) => edgeIndex.entries(id)[0]?.cobertura ?? 0
      expect(covOf('central-I1-I2')).toBeGreaterThan(0)
      expect(covOf('central-I1-I2')).toBeLessThan(0.3)
      expect(covOf('chegada')).toBeGreaterThan(0)
      expect(covOf('chegada')).toBeLessThan(0.3)
      expect(covOf('central-I2-M')).toBeCloseTo(1, 6)
      const edgeReader = new SensorReader({ noisePct: 0 })
      const [er] = window(edgeReader, [edge], edgeIndex, () => [
        { x: 680, y: 300, speedKmh: 30, segmentId: 'central-I1-I2' },
        { x: 750, y: 300, speedKmh: 40, segmentId: 'central-I2-M' },
        { x: 840, y: 300, speedKmh: 45, segmentId: 'chegada' },
      ])
      expect(er.porTrecho.map((t) => t.trecho)).toEqual(['central-I2-M'])
      expect(er.contagem).toBe(3) // the camera still counts every car in its cone

      // a cone that covers most of central I1-I2 and only a sliver of central I2-M
      const c = cam('C9', 450, 330, 90, 70, 210)
      const index = new CoverageIndex(segments)
      index.setCameras([c])
      const i1i2 = index.entries('central-I1-I2')[0]
      const i2m = index.entries('central-I2-M')[0]
      expect(i1i2.cobertura).toBeGreaterThanOrEqual(0.3)
      expect(i2m?.cobertura ?? 0).toBeLessThan(0.3)
      const reader = new SensorReader({ noisePct: 0 })
      const [r] = window(reader, [c], index, (tick) => [
        { x: 550, y: 300, speedKmh: 40, segmentId: 'central-I1-I2' },
        ...(tick > 50 ? [{ x: 600, y: 300, speedKmh: 20, segmentId: 'central-I1-I2' }] : []),
      ])
      expect(r.porTrecho).toEqual([
        {
          trecho: 'central-I1-I2',
          contagem: 2,
          velocidadeMediaKmh: 33.3, // (100 x 40 + 50 x 20) / 150
          comprimentoCobertoM: Math.round(i1i2.cobertura * 400 * 10) / 10,
          cobertura: Math.round(i1i2.cobertura * 1000) / 1000,
        },
      ])
    })
  })
})

describe('sensors', () => {
  describe('publisher', () => {
    it('publishes the per-segment payload on the sensor topic', async () => {
      const { TelemetryPublisher } = await import('../telemetry/TelemetryPublisher')
      const { FakeTransport } = await import('../telemetry/testing')
      const transport = new FakeTransport(true)
      new TelemetryPublisher(transport).publish({
        sensorId: 'C2',
        tipo: 'fixo',
        ts: 10_000,
        janelaS: 10,
        contagem: 3,
        velocidadeMediaKmh: 40,
        ruidoPct: 10,
        porTrecho: [{ trecho: 'central-I1-I2', contagem: 3, velocidadeMediaKmh: 40, comprimentoCobertoM: 215.2, cobertura: 0.538 }],
      })
      const [msg] = transport.published
      expect(msg.topic).toBe('transito/sensores/C2/telemetria')
      expect(msg.options).toEqual({ qos: 0, retain: false })
      const payload = JSON.parse(msg.payload)
      expect(Object.keys(payload)).toEqual(['sensorId', 'tipo', 'ts', 'janelaS', 'contagem', 'velocidadeMediaKmh', 'ruidoPct', 'porTrecho'])
      expect(payload.tipo).toBe('fixo')
      expect(Object.keys(payload.porTrecho[0])).toEqual(['trecho', 'contagem', 'velocidadeMediaKmh', 'comprimentoCobertoM', 'cobertura'])
      expect(payload.porTrecho[0]).toEqual({ trecho: 'central-I1-I2', contagem: 3, velocidadeMediaKmh: 40, comprimentoCobertoM: 215.2, cobertura: 0.538 })

      // a real noisy reading through the publisher: count and speed of each segment get the noise,
      // covered length and coverage do not
      const c2 = cam('C2', 420, 330, 90, 70, 260)
      const index = new CoverageIndex(segments)
      index.setCameras([c2])
      const exactLen = Math.round(index.entries('central-I1-I2')[0].cobertura * 400 * 10) / 10
      const reader = new SensorReader({ noisePct: 30, windowMs: 100 })
      const publisher = new TelemetryPublisher(transport)
      const cars = Array.from({ length: 100 }, () => ({ x: 560, y: 300, speedKmh: 100, segmentId: 'central-I1-I2' }))
      const counts: number[] = []
      const speeds: number[] = []
      for (let i = 1; i <= 300; i++) {
        for (const r of reader.observe(100, i * 100, [c2], index, cars)) publisher.publish(r)
      }
      for (const m of transport.published.slice(1)) {
        const seg = JSON.parse(m.payload).porTrecho[0]
        counts.push(seg.contagem)
        speeds.push(seg.velocidadeMediaKmh)
        expect(seg.comprimentoCobertoM).toBe(exactLen)
        expect(seg.cobertura).toBe(Math.round(index.entries('central-I1-I2')[0].cobertura * 1000) / 1000)
      }
      expect(counts).toHaveLength(300)
      for (const v of [...counts, ...speeds]) {
        expect(v).toBeGreaterThanOrEqual(70)
        expect(v).toBeLessThanOrEqual(130)
      }
      expect(Math.min(...counts)).toBeLessThan(80)
      expect(Math.max(...counts)).toBeGreaterThan(120)
      expect(Math.min(...speeds)).toBeLessThan(80)
      expect(Math.max(...speeds)).toBeGreaterThan(120)
    })
  })
})
