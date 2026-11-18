import { describe, expect, it } from 'vitest'
import { IncidentLog } from '../decision/IncidentLog'
import { HISTORY_KEEP, SegmentHistory } from '../decision/SegmentHistory'
import { IDM } from './idm'
import { SimulationEngine, TICK_MS, type SimulationState } from './SimulationEngine'

const KMH20 = 20 / 3.6
const inactive = { status: 'inativo' } as const

const engineFor = (lights: 'fixed' | 'always-green' = 'always-green') => new SimulationEngine({ ratePerMinute: 0, cameras: [], trafficLights: lights })

const run = (engine: SimulationEngine, ms: number, each?: (s: SimulationState) => void) => {
  for (let t = 0; t < ms; t += TICK_MS) {
    engine.tick(TICK_MS)
    each?.(engine.getState())
  }
}

/** No two cars on one segment closer than a car length (bumper to bumper below zero). */
const noOverlap = (s: SimulationState) => {
  const by = new Map<string, number[]>()
  for (const c of s.cars) {
    const id = c.path[c.seg]
    by.set(id, [...(by.get(id) ?? []), c.distance])
  }
  for (const [id, ds] of by) {
    ds.sort((a, b) => a - b)
    for (let i = 1; i < ds.length; i++) expect(ds[i] - ds[i - 1], `${id} at ${s.timeMs} ms`).toBeGreaterThanOrEqual(IDM.length - 1e-6)
  }
}

describe('incidents', () => {
  it('C22 a collision lasts 2 simulated minutes', () => {
    const engine = engineFor()
    const log = new IncidentLog()
    engine.addBlockage('I23>I24', 60)
    log.update(engine.getState(), inactive)
    run(engine, 119_900, (s) => log.update(s, inactive))
    expect(engine.getState().blockages).toHaveLength(1)
    expect(log.active().map((i) => i.kind)).toEqual(['colisao'])
    run(engine, TICK_MS, (s) => log.update(s, inactive))
    expect(engine.getState().timeMs).toBe(120_000)
    expect(engine.getState().blockages).toHaveLength(0)
    expect(log.active()).toHaveLength(0)
    expect(log.history()[0]).toMatchObject({ kind: 'colisao', nivel: 'critico', segmentId: 'I23>I24', startMs: 0, endMs: 120_000 })
  })

  it('C23 cars in a work zone stay at or below 20 km/h for 10 min', () => {
    const engine = engineFor()
    const zone = engine.addWorkZone('I12>I13')
    expect(zone.endsAtMs).toBe(600_000)
    // cars keep arriving at 50 km/h into the zone
    const path = ['I11>I12', 'I12>I13', 'I13>I14']
    let inZone = 0
    let fastest = 0
    for (let k = 0; k < 4; k++) {
      engine.addCar({ path, distance: 0, velocity: 50 / 3.6 })
      run(engine, 20_000, (s) => {
        for (const c of s.cars) {
          if (c.path[c.seg] === 'I12>I13') {
            inZone += 1
            expect(c.velocity, `car ${c.id} at ${s.timeMs} ms`).toBeLessThanOrEqual(KMH20 + 1e-9)
          } else fastest = Math.max(fastest, c.velocity)
        }
      })
    }
    expect(inZone).toBeGreaterThan(100)
    // outside the zone they still reach 50 km/h
    expect(fastest).toBeGreaterThan(45 / 3.6)
    run(engine, 600_000 - engine.getState().timeMs - TICK_MS)
    expect(engine.getState().workZones).toHaveLength(1)
    run(engine, TICK_MS)
    expect(engine.getState().workZones).toHaveLength(0)
    // after it ends, a car crosses the segment above 20 km/h
    engine.addCar({ path, distance: 0, velocity: 50 / 3.6 })
    let top = 0
    run(engine, 25_000, (s) => {
      for (const c of s.cars) if (c.path[c.seg] === 'I12>I13') top = Math.max(top, c.velocity)
    })
    expect(top).toBeGreaterThan(40 / 3.6)
  })

  it('C24 a flashing corner shows piscante on both phases and cars cross without colliding', () => {
    const engine = engineFor('fixed')
    const f = engine.addFlashing('I22')
    expect(f.endsAtMs).toBe(600_000)
    const light = (id: string) => engine.getState().lights.find((l) => l.intersectionId === id)!
    expect(light('I22')).toMatchObject({ h: 'piscante', v: 'piscante' })
    expect(light('I23').h).not.toBe('piscante')
    expect(light('I23').v).not.toBe('piscante')
    // two cars from crossing approaches turning into the same segment, many times over
    const crossed = new Set<number>()
    for (let k = 0; k < 6; k++) {
      const a = engine.addCar({ path: ['I21>I22', 'I22>I23', 'I23>I24'], distance: 40, velocity: 30 / 3.6 })
      const b = engine.addCar({ path: ['I12>I22', 'I22>I23', 'I23>I24'], distance: 40, velocity: 30 / 3.6 })
      const watch = (s: SimulationState) => {
        noOverlap(s)
        for (const c of s.cars) if (c.seg >= 1) crossed.add(c.id)
        expect(s.lights.find((l) => l.intersectionId === 'I22')).toMatchObject({ h: 'piscante', v: 'piscante' })
      }
      // no red holds either approach: both are through within 12 s (the fixed cycle holds one up to 28 s)
      run(engine, 12_000, watch)
      expect(crossed.has(a.id), `car ${a.id}`).toBe(true)
      expect(crossed.has(b.id), `car ${b.id}`).toBe(true)
      run(engine, 18_000, watch)
    }
    run(engine, 600_000 - engine.getState().timeMs)
    expect(engine.getState().flashing).toHaveLength(0)
    expect(['verde', 'amarelo', 'vermelho']).toContain(light('I22').h)
    expect(['verde', 'amarelo', 'vermelho']).toContain(light('I22').v)
  })

  it('C29 ending an incident restores the traffic in the same tick', () => {
    const engine = engineFor()
    const path = ['I11>I12', 'I12>I13', 'I13>I14']
    const zone = engine.addWorkZone('I12>I13')
    const car = engine.addCar({ path, seg: 1, distance: 10, velocity: KMH20 })
    run(engine, 5_000)
    expect(engine.getState().cars.find((c) => c.id === car.id)!.velocity).toBeLessThanOrEqual(KMH20 + 1e-9)
    engine.removeWorkZone(zone.id)
    expect(engine.getState().workZones).toHaveLength(0)
    run(engine, TICK_MS)
    expect(engine.getState().cars.find((c) => c.id === car.id)!.velocity).toBeGreaterThan(KMH20)

    const flash = engine.addFlashing('I22')
    expect(engine.getState().lights.find((l) => l.intersectionId === 'I22')!.h).toBe('piscante')
    engine.removeFlashing(flash.id)
    const l = engine.getState().lights.find((x) => x.intersectionId === 'I22')!
    expect([l.h, l.v]).not.toContain('piscante')

    const b = engine.addBlockage('I23>I24', 60)
    engine.removeBlockage(b.id)
    expect(engine.getState().blockages).toHaveLength(0)
  })

  it('C31 an ended incident goes to the history newest first', () => {
    const engine = engineFor()
    const log = new IncidentLog()
    const zone = engine.addWorkZone('I12>I13')
    log.update(engine.getState(), inactive)
    run(engine, 30_000, (s) => log.update(s, inactive))
    const flash = engine.addFlashing('I22')
    log.update(engine.getState(), inactive)
    run(engine, 30_000, (s) => log.update(s, inactive))
    engine.removeWorkZone(zone.id)
    log.update(engine.getState(), inactive)
    run(engine, 15_000, (s) => log.update(s, inactive))
    engine.removeFlashing(flash.id)
    log.update(engine.getState(), inactive)
    // the jam ends when the diversion stops
    const jam = { status: 'ativo', trecho: 'I33>I34', n: 3, p: 0.2, candidatos: 4, notificados: 2, semAlcance: 1 } as const
    log.update(engine.getState(), jam)
    run(engine, 10_000, (s) => log.update(s, jam))
    log.update(engine.getState(), inactive)
    const h = log.history()
    expect(h.map((i) => i.kind)).toEqual(['congestionamento', 'semaforo', 'obra'])
    expect(h[2]).toMatchObject({ segmentId: 'I12>I13', startMs: 0, endMs: 60_000 })
    expect(h[1]).toMatchObject({ intersectionId: 'I22', startMs: 30_000, endMs: 75_000 })
    expect(h[0]).toMatchObject({ segmentId: 'I33>I34', startMs: 75_000, endMs: 85_000 })
  })
})

describe('segment history', () => {
  it('C36 samples every 10 s and keeps the last 720', () => {
    const history = new SegmentHistory()
    // called after every 100 ms tick for 7 300 s: one sample per 10 s, 730 in all
    for (let t = TICK_MS; t <= 7_300_000; t += TICK_MS) {
      history.record(t, { 'I11>I12': { fluxo: t / 1000, capacidade: 1800, velocidade: 40 } }, { avgSpeed: 40, travelMin: 2 })
    }
    const pts = history.of('I11>I12')
    expect(HISTORY_KEEP).toBe(720)
    expect(pts).toHaveLength(720)
    expect(pts[0]).toEqual({ t: 110_000, fluxo: 110, capacidade: 1800, velocidade: 40 })
    expect(pts.at(-1)!.t).toBe(7_300_000)
    expect(pts.every((p, i) => i === 0 || p.t - pts[i - 1].t === 10_000)).toBe(true)
    expect(history.network()).toHaveLength(720)
    // 9 samples after 99.9 s
    const fresh = new SegmentHistory()
    for (let t = TICK_MS; t <= 99_900; t += TICK_MS) fresh.record(t, { a: { fluxo: 1, capacidade: null, velocidade: null } }, { avgSpeed: null, travelMin: null })
    expect(fresh.of('a')).toHaveLength(9)
    expect(fresh.of('missing')).toEqual([])
  })
})
