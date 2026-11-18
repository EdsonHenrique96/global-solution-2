import { describe, expect, it } from 'vitest'
import { buildCityNetwork } from '../sim/cityNetwork'
import { mulberry32 } from '../sim/random'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { FakeTransport } from '../telemetry/testing'
import { TelemetryPublisher } from '../telemetry/TelemetryPublisher'
import { bearing, insidePolygon, radarPolygon, type FixedCamera } from './camera'
import { COVERAGE_MIN, CoverageIndex } from './coverage'
import { SensorReader, type CarSample } from './reader'
import { buildSegments } from './segments'

const network = buildCityNetwork()
const segments = buildSegments(network)
const at = (id: string) => network.intersections.find((i) => i.id === id)!.position

/** A unit on I11 looking down Al. Santos towards I12. */
const unitOnSantos = (): FixedCamera => ({ id: 'U01', position: { ...at('I11') }, heading: bearing(at('I11'), at('I12')), fov: 40, range: 130 })

/** A point `ahead` metres along the unit's heading and `side` metres to its right. */
function seenFrom(u: FixedCamera, ahead: number, side: number): Point {
  const h = (u.heading * Math.PI) / 180
  const d = { x: Math.sin(h), y: -Math.cos(h) }
  const n = { x: Math.cos(h), y: Math.sin(h) }
  return { x: u.position.x + d.x * ahead + n.x * side, y: u.position.y + d.y * ahead + n.y * side }
}

function oneWindow(cars: CarSample[], noisePct = 0, rng = mulberry32(1)) {
  const index = new CoverageIndex(segments)
  const u = unitOnSantos()
  index.setCameras([u])
  const reader = new SensorReader({ noisePct, rng })
  return reader.observe(10_000, 10_000, [u], index, cars)[0]
}

describe('sensor unit', () => {
  it('starts with 12 units and leaves at least 6 segments uncovered', () => {
    const e = new SimulationEngine({ ratePerMinute: 0 })
    const units = e.getState().cameras
    expect(units.map((u) => u.id)).toEqual(['U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11', 'U12'])
    const corners = network.intersections.map((i) => i.position)
    for (const u of units) expect(corners.some((p) => Math.hypot(p.x - u.position.x, p.y - u.position.y) < 1e-6)).toBe(true)
    const uncovered = segments.filter((s) => !e.coverage.entries(s.id).some((x) => x.cobertura >= COVERAGE_MIN))
    expect(uncovered.length).toBeGreaterThanOrEqual(6)
    expect(uncovered.length).toBeLessThan(48)
  })

  it('counts with the camera cone and measures speed with the radar beam', () => {
    const u = unitOnSantos()
    const inBeam = seenFrom(u, 90, 4)
    const coneOnly = seenFrom(u, 90, 20)
    expect(insidePolygon(inBeam, radarPolygon(u))).toBe(true)
    expect(insidePolygon(coneOnly, radarPolygon(u))).toBe(false)

    const both = oneWindow([
      { ...inBeam, speedKmh: 30, segmentId: 'I11>I12' },
      { ...coneOnly, speedKmh: 10, segmentId: 'I11>I12' },
    ])
    const seg = both.porTrecho.find((t) => t.trecho === 'I11>I12')!
    expect(seg.contagem).toBe(2)
    expect(seg.velocidadeMediaKmh).toBe(30)
    expect(seg.amostrasRadar).toBe(1)

    const coneOnlyWindow = oneWindow([{ ...coneOnly, speedKmh: 10, segmentId: 'I11>I12' }])
    const quiet = coneOnlyWindow.porTrecho.find((t) => t.trecho === 'I11>I12')!
    expect(quiet.contagem).toBe(1)
    expect(quiet.velocidadeMediaKmh).toBeNull()
    expect(quiet.amostrasRadar).toBe(0)
  })

  it('publishes the camera+radar reading shape', () => {
    const u = unitOnSantos()
    const reading = oneWindow([{ ...seenFrom(u, 90, 4), speedKmh: 30, segmentId: 'I11>I12' }])
    const transport = new FakeTransport(true)
    new TelemetryPublisher(transport).publish(reading)
    expect(transport.published[0].topic).toBe('transito/sensores/U01/telemetria')
    const msg = JSON.parse(transport.published[0].payload)
    expect(msg.tipo).toBe('camera+radar')
    expect(Object.keys(msg).sort()).toEqual(['contagem', 'janelaS', 'porTrecho', 'ruidoPct', 'sensorId', 'tipo', 'ts', 'velocidadeMediaKmh'])
    const t = msg.porTrecho.find((x: { trecho: string }) => x.trecho === 'I11>I12')
    expect(Object.keys(t).sort()).toEqual([
      'amostrasRadar',
      'cobertura',
      'comprimentoCobertoM',
      'contagem',
      'fonteContagem',
      'fonteVelocidade',
      'trecho',
      'velocidadeMediaKmh',
    ])
    expect(t.fonteContagem).toBe('visao-computacional')
    expect(t.fonteVelocidade).toBe('radar')
    expect(t.amostrasRadar).toBe(1)
  })

  it('applies half the noise to the radar', () => {
    const u = unitOnSantos()
    // 20 cars in the beam at 30 km/h
    const cars: CarSample[] = Array.from({ length: 20 }, (_, i) => ({ ...seenFrom(u, 40 + i * 4, 4), speedKmh: 30, segmentId: 'I11>I12' }))
    const rng = mulberry32(7)
    let maxSpeedDev = 0
    let maxCountDev = 0
    for (let w = 0; w < 300; w++) {
      const seg = oneWindow(cars, 10, rng).porTrecho.find((t) => t.trecho === 'I11>I12')!
      const countDev = Math.abs(seg.contagem - 20) / 20
      const speedDev = Math.abs(seg.velocidadeMediaKmh! - 30) / 30
      expect(countDev).toBeLessThanOrEqual(0.1 + 1e-9)
      // rounded to 0.1 km/h
      expect(speedDev).toBeLessThanOrEqual(0.05 + 0.05 / 30)
      maxSpeedDev = Math.max(maxSpeedDev, speedDev)
      maxCountDev = Math.max(maxCountDev, countDev)
    }
    // the camera uses its whole 10 %, the radar only half of it
    expect(maxCountDev).toBeGreaterThan(0.05)
    expect(maxSpeedDev).toBeGreaterThan(0.035)
    const exact = oneWindow(cars, 0).porTrecho.find((t) => t.trecho === 'I11>I12')!
    expect(exact.contagem).toBe(20)
    expect(exact.velocidadeMediaKmh).toBe(30)
  })

  it('moves cone and beam together and recomputes coverage', () => {
    const e = new SimulationEngine({ ratePerMinute: 0 })
    const before = e.getState().cameras.find((c) => c.id === 'U01')!
    expect(e.coverage.entries('I11>I12').some((x) => x.sensorId === 'U01' && x.cobertura >= COVERAGE_MIN)).toBe(true)
    const rebuilds = e.coverage.rebuilds
    // turn U01 from Al. Santos to R. da Consolação
    const heading = bearing(at('I11'), at('I21'))
    e.updateCamera('U01', { heading })
    expect(e.coverage.rebuilds).toBe(rebuilds + 1)
    const after = e.getState().cameras.find((c) => c.id === 'U01')!
    expect(after.heading).toBe(heading)
    expect(after.heading).not.toBe(before.heading)
    // Al. Santos is no longer read by U01 (below the 0.3 reading cut-off)
    expect(e.coverage.entries('I11>I12').some((x) => x.sensorId === 'U01' && x.cobertura >= COVERAGE_MIN)).toBe(false)
    expect(e.coverage.entries('I11>I21').some((x) => x.sensorId === 'U01' && x.cobertura >= COVERAGE_MIN)).toBe(true)
    // the radar beam follows the camera
    const towardJau = seenFrom(after, 90, 0)
    expect(insidePolygon(towardJau, e.coverage.beam('U01')!)).toBe(true)
    expect(insidePolygon(towardJau, e.coverage.polygon('U01')!)).toBe(true)
    expect(insidePolygon(seenFrom(before, 90, 0), e.coverage.beam('U01')!)).toBe(false)
  })
})
