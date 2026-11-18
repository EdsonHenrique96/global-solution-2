import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CapacityService } from '../capacity/CapacityService'
import { Simulation } from '../decision/Simulation'
import { buildSegments } from '../sensors/segments'
import { buildRoadNetwork } from '../sim/roadNetwork'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { ALERTS_TOPIC, wireAlerts } from './AlertPublisher'
import { agedConfidence, baseConfidence } from './confidence'
import { FusionService } from './FusionService'
import { OD_TOPIC, OdAggregator } from './OdAggregator'

const segments = buildSegments(buildRoadNetwork())
const sensorMsg = (sensorId: string, ts: number, porTrecho: unknown[]) =>
  JSON.stringify({ sensorId, tipo: 'fixo', ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porTrecho })
const seg = (trecho: string, contagem: number, velocidadeMediaKmh: number | null, comprimentoCobertoM: number, cobertura: number) => ({
  trecho,
  contagem,
  velocidadeMediaKmh,
  comprimentoCobertoM,
  cobertura,
})
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
          ['alertas', 'atualizadoEm', 'confianca', 'demandaOD', 'densidade', 'estimado', 'fontes', 'velocidadeMedia'].sort(),
        )
        expect(s).toMatchObject({ densidade: null, velocidadeMedia: null, alertas: [], demandaOD: null, fontes: [], confianca: 0, atualizadoEm: null, estimado: false })
      }
    })

    it('takes count and speed from the sensor with the highest coverage', () => {
      const now = { t: 10_000 }
      const { transport, fusion } = setup(now)
      // A (0.5) arrives after B (0.9) in one order and before it in the other: B wins both times
      for (const order of [['A', 'B'], ['B', 'A']]) {
        const msgs: Record<string, string> = {
          A: sensorMsg('A', now.t, [seg('central-I1-I2', 10, 20, 200, 0.5)]),
          B: sensorMsg('B', now.t, [seg('central-I1-I2', 4, 40, 360, 0.9)]),
        }
        for (const id of order) transport.deliver(`transito/sensores/${id}/telemetria`, msgs[id])
        const s = fusion.state()['central-I1-I2']
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
      transport.deliver('transito/sensores/C2/telemetria', sensorMsg('C2', 10_000, [seg('central-I1-I2', 4, 40, 200, 0.5)]))
      now.t = 20_000 // one window later: still fresh
      expect(fusion.state()['central-I1-I2'].estimado).toBe(false)
      now.t = 20_100 // more than one window without a reading
      const s = fusion.state()['central-I1-I2']
      expect(s.estimado).toBe(true)
      expect(s.fontes).toEqual([])
      expect(s.densidade).toBeCloseTo(20, 6)
      expect(s.velocidadeMedia).toBe(40)
      expect(s.atualizadoEm).toBe(10_000)
      // a segment never measured has neither density nor speed
      expect(fusion.state()['norte-F-I3']).toMatchObject({ densidade: null, velocidadeMedia: null, estimado: false, confianca: 0 })
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
      transport.deliver('transito/sensores/C2/telemetria', sensorMsg('C2', 10_000, [seg('central-I1-I2', 4, 40, 320, 0.8)]))
      expect(fusion.state()['central-I1-I2'].confianca).toBe(1)
      now.t = 80_000
      expect(fusion.state()['central-I1-I2'].confianca).toBeCloseTo(0.5, 9)
      now.t = 310_000
      expect(fusion.state()['central-I1-I2'].confianca).toBe(0.2)
      transport.deliver('transito/sensores/C9/telemetria', sensorMsg('C9', 310_000, [seg('norte-I3-M', 1, 40, 166, 0.4)]))
      expect(fusion.state()['norte-I3-M'].confianca).toBeCloseTo(0.5, 9)
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
      const b = engine.addBlockage('central', 500) // x 560, y 300
      expect(seen).toEqual([{ id: b.id, tipo: 'acidente', x: 560, y: 300, ts: 5_000, fonte: 'operador', ativo: true }])
      for (let t = 0; t < 120_000; t += TICK_MS) engine.tick(TICK_MS)
      expect(seen[1]).toEqual({ id: b.id, tipo: 'acidente', x: 560, y: 300, ts: 125_000, fonte: 'operador', ativo: false })
      // removed by hand: same
      const b2 = engine.addBlockage('norte', 600)
      engine.removeBlockage(b2.id)
      expect(seen[3]).toMatchObject({ id: b2.id, ativo: false })
    })

    it('attaches alerts to their segment and merges duplicates within 50 m and 60 s', () => {
      const now = { t: 0 }
      const { transport, fusion } = setup(now)
      const send = (id: number, x: number, ts: number, ativo = true) => transport.deliver(ALERTS_TOPIC, alertMsg(id, x, 300, ts, ativo))
      const count = () => fusion.state()['central-I1-I2'].alertas.length
      send(1, 500, 1_000)
      send(2, 530, 21_000) // 30 m and 20 s later -> the same incident
      expect(count()).toBe(1)
      // within 50 m and 60 s of ANY report already merged (here #2, 50 m and 1 s away) -> still one
      send(3, 580, 22_000)
      expect(count()).toBe(1)
      expect(fusion.state()['central-I1-I2'].alertas[0].ids.sort()).toEqual([1, 2, 3])
      send(4, 661, 23_000) // 81 m from the nearest member -> a second alert
      expect(count()).toBe(2)
      send(5, 500, 301_000) // same point as #1, 5 min later -> another one
      expect(count()).toBe(3)
      // only on the segment that contains the point
      expect(fusion.state()['central-F-I1'].alertas).toHaveLength(0)
      // a point 15+ m away from every road attaches nowhere
      transport.deliver(ALERTS_TOPIC, alertMsg(9, 500, 340, 1_000))
      expect(Object.values(fusion.state()).reduce((n, s) => n + s.alertas.length, 0)).toBe(3)
      // ending alerts: a merged alert goes away only when all its reports ended
      send(1, 500, 400_000, false)
      send(2, 530, 400_000, false)
      expect(count()).toBe(3)
      send(3, 580, 400_000, false)
      expect(count()).toBe(2)
    })
  })

  describe('od', () => {
    it('publishes aggregated trips per OD cell every 60 s and drops cells under 5', () => {
      const run = (rate: number) => {
        const engine = new SimulationEngine({ ratePerMinute: rate })
        const transport = new FakeTransport(true)
        const msgs: Record<string, unknown>[] = []
        transport.subscribe(OD_TOPIC, (_t, p) => msgs.push(JSON.parse(p)))
        const od = new OdAggregator(engine, transport)
        for (let t = 0; t < 120_000; t += TICK_MS) {
          engine.tick(TICK_MS)
          od.tick()
        }
        return msgs
      }
      const busy = run(15)
      expect(busy).toEqual([
        { ts: 60_000, janelaS: 60, celulas: [{ origem: 'oeste', destino: 'leste', viagens: 15 }] },
        { ts: 120_000, janelaS: 60, celulas: [{ origem: 'oeste', destino: 'leste', viagens: 15 }] },
      ])
      const quiet = run(4)
      expect(quiet).toHaveLength(2)
      for (const m of quiet) expect(m.celulas).toEqual([])
    })

    it('spreads OD demand over the segments of the routes in veh per hour', () => {
      const now = { t: 60_000 }
      const { transport, fusion } = setup(now)
      transport.deliver(OD_TOPIC, JSON.stringify({ ts: 60_000, janelaS: 60, celulas: [{ origem: 'oeste', destino: 'leste', viagens: 15 }] }))
      const s = fusion.state()
      expect(s.chegada.demandaOD).toBeCloseTo(900, 6)
      expect(s['central-I1-I2'].demandaOD).toBeCloseTo(300, 6)
      expect(s['norte-entrada'].demandaOD).toBeCloseTo(300, 6)
      expect(s['sul-I4-M'].demandaOD).toBeCloseTo(300, 6)
      // a window without valid cells leaves the demand unknown
      transport.deliver(OD_TOPIC, JSON.stringify({ ts: 120_000, janelaS: 60, celulas: [] }))
      expect(fusion.state()['central-I1-I2'].demandaOD).toBeNull()
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
      for (const filter of ['transito/sensores/+/telemetria', ALERTS_TOPIC, OD_TOPIC]) {
        transport.subscribe(filter, (topic, p) => payloads.push({ topic, body: JSON.parse(p) }))
      }
      sim.start()
      for (let t = 0; t < 180_000; t += TICK_MS) {
        if (sim.engine.getState().timeMs === 60_000) sim.engine.addBlockage('central', 500)
        sim.tick()
      }
      sim.stop()
      expect(payloads.some((p) => p.topic.startsWith('transito/sensores/'))).toBe(true)
      expect(payloads.some((p) => p.topic === ALERTS_TOPIC)).toBe(true)
      expect(payloads.some((p) => p.topic === OD_TOPIC)).toBe(true)
      for (const { topic, body } of payloads) {
        if (topic.startsWith('transito/sensores/')) {
          expect(Object.keys(body)).toEqual(['sensorId', 'tipo', 'ts', 'janelaS', 'contagem', 'velocidadeMediaKmh', 'ruidoPct', 'porTrecho'])
          for (const t of body.porTrecho as Record<string, unknown>[]) {
            expect(Object.keys(t)).toEqual(['trecho', 'contagem', 'velocidadeMediaKmh', 'comprimentoCobertoM', 'cobertura'])
          }
        } else if (topic === ALERTS_TOPIC) {
          expect(Object.keys(body)).toEqual(['id', 'tipo', 'x', 'y', 'ts', 'fonte', 'ativo'])
          expect(body.fonte).toBe('operador')
        } else {
          expect(Object.keys(body)).toEqual(['ts', 'janelaS', 'celulas'])
          for (const c of body.celulas as Record<string, unknown>[]) {
            expect(Object.keys(c)).toEqual(['origem', 'destino', 'viagens'])
            expect(c.viagens as number).toBeGreaterThanOrEqual(5)
          }
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
      transport.deliver('transito/sensores/A/telemetria', sensorMsg('A', 10_000, [seg('central-I1-I2', 10, 20, 200, 0.5)]))
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(0) // window still open
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 10_000, [seg('central-I1-I2', 4, 40, 360, 0.9)]))
      now.t = 20_000 // the window closes
      let s = service.snapshot()['central-I1-I2']
      expect(s.amostras).toHaveLength(1)
      expect(s.velocidade).toBe(40)
      expect(s.densidade).toBeCloseTo(4 / 0.36, 6)
      // asking again does not add the same window twice
      service.snapshot()
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(1)
      // a newer window closes the previous one even before 10 s pass
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 20_000, [seg('central-I1-I2', 6, 30, 360, 0.9)]))
      transport.deliver('transito/sensores/B/telemetria', sensorMsg('B', 30_000, [seg('central-I1-I2', 8, 25, 360, 0.9)]))
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(2)
      // a quiet segment: estimated, no new sample beyond the closed windows, last state kept
      now.t = 45_000
      s = service.snapshot()['central-I1-I2']
      expect(s.amostras).toHaveLength(3)
      now.t = 47_000
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(3)
      expect(service.fusion.state()['central-I1-I2'].estimado).toBe(true)
    })
  })
})
