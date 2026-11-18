import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CapacityService } from '../capacity/CapacityService'
import { Simulation } from '../decision/Simulation'
import { AppFleet, APPS_TOPIC } from '../apps/AppFleet'
import { buildSegments, pointOnSegment } from '../sensors/segments'
import { buildCityNetwork } from '../sim/cityNetwork'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { ALERTS_TOPIC, wireAlerts } from './AlertPublisher'
import { agedConfidence, baseConfidence } from './confidence'
import { FusionService } from './FusionService'

const segments = buildSegments(buildCityNetwork())
const SANTOS = segments.find((x) => x.id === 'I12>I13')!
const sensorMsg = (sensorId: string, ts: number, porTrecho: unknown[]) =>
  JSON.stringify({ sensorId, tipo: 'camera+radar', ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porTrecho })
const seg = (trecho: string, contagem: number, velocidadeMediaKmh: number | null, comprimentoCobertoM: number, cobertura: number) => ({
  trecho,
  contagem,
  velocidadeMediaKmh,
  comprimentoCobertoM,
  cobertura,
})
const alertAt = (id: number, d: number, ts: number, ativo = true) => {
  const p = pointOnSegment(SANTOS, d)
  return alertMsg(id, p.x, p.y, ts, ativo)
}
const alertMsg = (id: number, x: number, y: number, ts: number, ativo = true) =>
  JSON.stringify({ id, tipo: 'acidente', x, y, ts, fonte: 'operador', ativo })

function setup(now: { t: number }) {
  const transport = new FakeTransport(true)
  const fusion = new FusionService(transport, () => now.t, segments)
  fusion.start()
  return { transport, fusion }
}

describe('fusion', () => {
  describe('state', () => {
    it('keeps a fused state for every segment', () => {
      const now = { t: 0 }
      const { fusion } = setup(now)
      const state = fusion.state()
      expect(Object.keys(state).sort()).toEqual(segments.map((s) => s.id).sort())
      for (const s of Object.values(state)) {
        expect(Object.keys(s).sort()).toEqual(
          ['alertas', 'atualizadoEm', 'confianca', 'contagem', 'demandaOD', 'densidade', 'estimado', 'fontes', 'velocidadeMedia'].sort(),
        )
        expect(s).toMatchObject({ contagem: null, densidade: null, velocidadeMedia: null, alertas: [], demandaOD: null, fontes: [], confianca: 0, atualizadoEm: null, estimado: false })
      }
    })

    it('takes count and speed from the sensor with the highest coverage', () => {
      const now = { t: 10_000 }
      const { transport, fusion } = setup(now)
      // A (0.5) arrives after B (0.9) in one order and before it in the other: B wins both times
      for (const order of [['A', 'B'], ['B', 'A']]) {
        const msgs: Record<string, string> = {
          A: sensorMsg('A', now.t, [seg('I12>I13', 10, 20, 200, 0.5)]),
          B: sensorMsg('B', now.t, [seg('I12>I13', 4, 40, 360, 0.9)]),
        }
        for (const id of order) transport.deliver(`transito/sensores/${id}/telemetria`, msgs[id])
        const s = fusion.state()['I12>I13']
        expect(s.densidade).toBeCloseTo(4 / 0.36, 6)
        expect(s.velocidadeMedia).toBe(40)
        expect(s.fontes.sort()).toEqual(['A', 'B'])
        expect(s.confianca).toBe(1)
        expect(s.estimado).toBe(false)
        now.t += 10_000
      }
    })

    it('keeps the last estimate as estimated when sensors go quiet', () => {
      const now = { t: 10_000 }
      const { transport, fusion } = setup(now)
      transport.deliver('transito/sensores/U02/telemetria', sensorMsg('U02', 10_000, [seg('I12>I13', 4, 40, 200, 0.5)]))
      now.t = 20_000 // one window later: still fresh
      expect(fusion.state()['I12>I13'].estimado).toBe(false)
      now.t = 20_100 // more than one window without a reading
      const s = fusion.state()['I12>I13']
      expect(s.estimado).toBe(true)
      expect(s.fontes).toEqual([])
      expect(s.densidade).toBeCloseTo(20, 6)
      expect(s.velocidadeMedia).toBe(40)
      expect(s.atualizadoEm).toBe(10_000)
      // a segment never measured has neither density nor speed
      expect(fusion.state()['I22>I23']).toMatchObject({ densidade: null, velocidadeMedia: null, estimado: false, confianca: 0 })
    })
  })

  describe('confidence', () => {
    it('scales with coverage and decays with age to a floor', () => {
      expect(baseConfidence(0.9)).toBe(1)
      expect(baseConfidence(0.8)).toBe(1)
      expect(baseConfidence(0.4)).toBeCloseTo(0.5, 9)
      expect(agedConfidence(1, 0)).toBe(1)
      expect(agedConfidence(1, 10_000)).toBe(1)
      expect(agedConfidence(1, 70_000)).toBeCloseTo(0.5, 9)
      expect(agedConfidence(1, 100_000)).toBeCloseTo(0.25, 9)
      expect(agedConfidence(1, 130_000)).toBeCloseTo(0.2, 9)
      expect(agedConfidence(1, 300_000)).toBe(0.2)
      // and in the fused state
      const now = { t: 10_000 }
      const { transport, fusion } = setup(now)
      transport.deliver('transito/sensores/U02/telemetria', sensorMsg('U02', 10_000, [seg('I12>I13', 4, 40, 320, 0.8)]))
      expect(fusion.state()['I12>I13'].confianca).toBe(1)
      now.t = 80_000
      expect(fusion.state()['I12>I13'].confianca).toBeCloseTo(0.5, 9)
      now.t = 310_000
      expect(fusion.state()['I12>I13'].confianca).toBe(0.2)
      transport.deliver('transito/sensores/U09/telemetria', sensorMsg('U09', 310_000, [seg('I23>I24', 1, 40, 166, 0.4)]))
      expect(fusion.state()['I23>I24'].confianca).toBeCloseTo(0.5, 9)
    })
  })

  describe('alerts', () => {
    it('publishes an accident alert when a blockage starts and clears it when it ends', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      const transport = new FakeTransport(true)
      const seen: Record<string, unknown>[] = []
      transport.subscribe(ALERTS_TOPIC, (_t, p) => seen.push(JSON.parse(p)))
      wireAlerts(engine, transport)
      for (let t = 0; t < 5_000; t += TICK_MS) engine.tick(TICK_MS)
      const b = engine.addBlockage('I12>I13', 70)
      const { x, y } = pointOnSegment(SANTOS, 70)
      expect(seen).toEqual([{ id: b.id, tipo: 'acidente', x, y, ts: 5_000, fonte: 'operador', ativo: true }])
      for (let t = 0; t < 120_000; t += TICK_MS) engine.tick(TICK_MS)
      expect(seen[1]).toEqual({ id: b.id, tipo: 'acidente', x, y, ts: 125_000, fonte: 'operador', ativo: false })
      // removed by hand: same
      const b2 = engine.addBlockage('I22>I23', 60)
      engine.removeBlockage(b2.id)
      expect(seen[3]).toMatchObject({ id: b2.id, ativo: false })
    })

    it('attaches alerts to their segment and merges duplicates within 50 m and 60 s', () => {
      const now = { t: 0 }
      const { transport, fusion } = setup(now)
      const send = (id: number, d: number, ts: number, ativo = true) => transport.deliver(ALERTS_TOPIC, alertAt(id, d, ts, ativo))
      const count = () => fusion.state()['I12>I13'].alertas.length
      send(1, 5, 1_000)
      send(2, 35, 21_000) // 30 m and 20 s later -> the same incident
      expect(count()).toBe(1)
      // within 50 m and 60 s of ANY report already merged (here #2, 45 m and 1 s away) -> still one
      send(3, 80, 22_000)
      expect(count()).toBe(1)
      expect(fusion.state()['I12>I13'].alertas[0].ids.sort()).toEqual([1, 2, 3])
      send(4, 133, 23_000) // 53 m from the nearest member -> a second alert
      expect(count()).toBe(2)
      send(5, 5, 301_000) // same point as #1, 5 min later -> another one
      expect(count()).toBe(3)
      // only on the lane that contains the point: not the opposite direction, 8 m away
      expect(fusion.state()['I13>I12'].alertas).toHaveLength(0)
      // a point in the middle of a block, 15+ m away from every road, attaches nowhere
      const corners = ['I12', 'I13', 'I22', 'I23'].map((id) => buildCityNetwork().intersections.find((i) => i.id === id)!.position)
      const mid = { x: corners.reduce((a, c) => a + c.x, 0) / 4, y: corners.reduce((a, c) => a + c.y, 0) / 4 }
      transport.deliver(ALERTS_TOPIC, alertMsg(9, mid.x, mid.y, 1_000))
      expect(Object.values(fusion.state()).reduce((n, s) => n + s.alertas.length, 0)).toBe(3)
      // ending alerts: a merged alert goes away only when all its reports ended
      send(1, 5, 400_000, false)
      send(2, 35, 400_000, false)
      expect(count()).toBe(3)
      send(3, 80, 400_000, false)
      expect(count()).toBe(2)
    })
  })

  describe('apps demand', () => {
    it('scales the apps entries per segment to all drivers in veh per hour', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green', cameras: [] })
      const fleet = new AppFleet(engine, new FakeTransport(true), 0.6)
      const L = engine.segment('I11>I12')!.length
      engine.addCar({ path: ['I11>I12', 'I12>I13'], distance: L - 5, app: 'waze' })
      engine.addCar({ path: ['I11>I12', 'I12>I13'], distance: L - 30, app: null })
      for (let t = 0; t < 5_000; t += TICK_MS) engine.tick(TICK_MS)
      // one app driver entered in the last minute: 60 per hour, over a 60 % app share -> 100 veh/h
      expect(fleet.snapshot().demandaPorTrecho).toEqual({ 'I12>I13': 100 })
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
      expect(fleet.snapshot().demandaPorTrecho).toEqual({})
    })

    it('uses the apps demand per segment and leaves the rest unknown', () => {
      const now = { t: 60_000 }
      const { transport, fusion } = setup(now)
      transport.deliver(APPS_TOPIC, JSON.stringify({ ts: 60_000, total: 3, porApp: {}, porTrecho: {}, demandaPorTrecho: { 'I12>I13': 300 } }))
      const s = fusion.state()
      expect(s['I12>I13'].demandaOD).toBeCloseTo(300, 6)
      expect(s['I13>I14'].demandaOD).toBeNull()
      // the next aggregate without it: unknown again
      transport.deliver(APPS_TOPIC, JSON.stringify({ ts: 70_000, total: 0, porApp: {}, porTrecho: {}, demandaPorTrecho: {} }))
      expect(fusion.state()['I12>I13'].demandaOD).toBeNull()
    })
  })

  describe('privacy', () => {
    it('consumes only aggregated messages without individual cars', () => {
      // the fusion module never imports the simulation engine
      for (const f of ['FusionService.ts', 'confidence.ts']) {
        const src = readFileSync(`${process.cwd()}/src/fusion/${f}`, "utf8")
        expect(src, f).not.toMatch(/sim\/SimulationEngine|CarState|\.cars\b/)
      }
      // and every message on the topics it reads has only aggregate fields
      const transport = new FakeTransport(true)
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30 }), transport })
      const payloads: { topic: string; body: Record<string, unknown> }[] = []
      for (const filter of ['transito/sensores/+/telemetria', ALERTS_TOPIC, APPS_TOPIC]) {
        transport.subscribe(filter, (topic, p) => payloads.push({ topic, body: JSON.parse(p) }))
      }
      sim.start()
      for (let t = 0; t < 180_000; t += TICK_MS) {
        if (sim.engine.getState().timeMs === 60_000) sim.engine.addBlockage('I12>I13', 70)
        sim.tick()
      }
      sim.stop()
      expect(payloads.some((p) => p.topic.startsWith('transito/sensores/'))).toBe(true)
      expect(payloads.some((p) => p.topic === ALERTS_TOPIC)).toBe(true)
      expect(payloads.some((p) => p.topic === APPS_TOPIC)).toBe(true)
      for (const { topic, body } of payloads) {
        if (topic.startsWith('transito/sensores/')) {
          expect(Object.keys(body)).toEqual(['sensorId', 'tipo', 'ts', 'janelaS', 'contagem', 'velocidadeMediaKmh', 'ruidoPct', 'porTrecho'])
          for (const t of body.porTrecho as Record<string, unknown>[]) {
            expect(Object.keys(t)).toEqual(['trecho', 'contagem', 'fonteContagem', 'velocidadeMediaKmh', 'fonteVelocidade', 'amostrasRadar', 'comprimentoCobertoM', 'cobertura'])
          }
        } else if (topic === ALERTS_TOPIC) {
          expect(Object.keys(body)).toEqual(['id', 'tipo', 'x', 'y', 'ts', 'fonte', 'ativo'])
          expect(body.fonte).toBe('operador')
        } else {
          // the apps' aggregate: counts per app and per segment, demand per segment
          expect(Object.keys(body)).toEqual(['ts', 'total', 'porApp', 'porTrecho', 'demandaPorTrecho'])
          for (const v of [...Object.values(body.porTrecho as object), ...Object.values(body.demandaPorTrecho as object)]) expect(typeof v).toBe('number')
        }
      }
    })
  })

  describe('capacity', () => {
    it('learns one chosen measurement per segment and window', () => {
      const now = { t: 10_000 }
      const transport = new FakeTransport(true)
      const service = new CapacityService(transport, () => now.t, segments)
      service.start()
      // two cameras on the same segment in the same window, with a snapshot in between (the page
      // refreshes on every message): one sample, from the 0.9 one
      transport.deliver('transito/sensores/A/telemetria', sensorMsg('A', 10_000, [seg('I12>I13', 10, 20, 200, 0.5)]))
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(0) // window still open
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 10_000, [seg('I12>I13', 4, 40, 360, 0.9)]))
      now.t = 20_000 // the window closes
      let s = service.snapshot()['I12>I13']
      expect(s.amostras).toHaveLength(1)
      expect(s.velocidade).toBe(40)
      expect(s.densidade).toBeCloseTo(4 / 0.36, 6)
      // asking again does not add the same window twice
      service.snapshot()
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
      // a newer window closes the previous one even before 10 s pass
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 20_000, [seg('I12>I13', 6, 30, 360, 0.9)]))
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 30_000, [seg('I12>I13', 8, 25, 360, 0.9)]))
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(2)
      // a quiet segment: estimated, no new sample beyond the closed windows, last state kept
      now.t = 45_000
      s = service.snapshot()['I12>I13']
      expect(s.amostras).toHaveLength(3)
      now.t = 47_000
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(3)
      expect(service.fusion.state()['I12>I13'].estimado).toBe(true)
    })
  })
})
