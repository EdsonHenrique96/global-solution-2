import { describe, expect, it } from 'vitest'
import { FakeTransport } from '../telemetry/testing'
import { CapacityModel, type RouteStatus } from './CapacityModel'
import { CapacityService, summariseRoute } from './CapacityService'

const entry = (contagem: number, velocidadeMediaKmh: number | null, comprimentoM = 1000) => ({
  contagem,
  velocidadeMediaKmh,
  comprimentoM,
})

/** Feeds samples that lie exactly on v = 50 (1 - k / 100), k = 5, 10, ..., 100 (20 samples). */
function trainedModel(): CapacityModel {
  const model = new CapacityModel()
  for (let i = 1; i <= 20; i++) {
    const k = 5 * i
    model.observe(entry(k, 50 * (1 - k / 100)), i * 10_000)
  }
  return model
}

function message(sensorId: string, ts: number, porTrecho: unknown[]) {
  return JSON.stringify({ sensorId, tipo: 'fixo', ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porTrecho })
}

describe('capacity', () => {
  describe('CapacityModel', () => {
    it('recovers vf 50 and kj 100 from exact samples and estimates capacity 1250', () => {
      const est = trainedModel().estimate(200_000)
      expect(est.vf!).toBeGreaterThanOrEqual(49.5)
      expect(est.vf!).toBeLessThanOrEqual(50.5)
      expect(est.kj!).toBeGreaterThanOrEqual(99)
      expect(est.kj!).toBeLessThanOrEqual(101)
      expect(est.capacidade!).toBeGreaterThanOrEqual(1235)
      expect(est.capacidade!).toBeLessThanOrEqual(1265)
    })

    it('leaves capacity and slack undefined below 5 samples or with a non-negative slope', () => {
      const few = new CapacityModel()
      for (let i = 1; i <= 4; i++) few.observe(entry(5 * i, 50 * (1 - (5 * i) / 100)), i * 10_000)
      expect(few.estimate(40_000).capacidade).toBeNull()
      expect(few.estimate(40_000).folga).toBeNull()
      // the fifth sample makes it estimable
      few.observe(entry(25, 37.5), 50_000)
      expect(few.estimate(50_000).capacidade).not.toBeNull()

      // speed rising with density: slope >= 0, no capacity however many samples
      const rising = new CapacityModel()
      for (let i = 1; i <= 10; i++) rising.observe(entry(i, 20 + i), i * 10_000)
      expect(rising.estimate(100_000).capacidade).toBeNull()
      expect(rising.estimate(100_000).folga).toBeNull()

      // flat speed: slope 0, still undefined
      const flat = new CapacityModel()
      for (let i = 1; i <= 10; i++) flat.observe(entry(i, 50), i * 10_000)
      expect(flat.estimate(100_000).capacidade).toBeNull()

      // readings without speed do not count as fit samples
      const empty = new CapacityModel()
      for (let i = 1; i <= 10; i++) empty.observe(entry(0, null), i * 10_000)
      expect(empty.estimate(100_000).capacidade).toBeNull()
      expect(empty.estimate(100_000).amostras).toHaveLength(0)
    })

    it('classifies state at 40 39.9 25 and 24.9 km/h and an empty road as flowing', () => {
      const cases: [number, number | null, string][] = [
        [2, 40, 'fluindo'],
        [2, 39.9, 'carregado'],
        [2, 25, 'carregado'],
        [2, 24.9, 'congestionado'],
        [0, null, 'fluindo'],
        [3, 60, 'fluindo'],
        [5, 0, 'congestionado'],
      ]
      for (const [contagem, v, estado] of cases) {
        const model = new CapacityModel()
        model.observe(entry(contagem, v, 220), 10_000)
        expect(model.estimate(10_000).estado, `v=${v}`).toBe(estado)
      }
      // the latest reading decides
      const model = new CapacityModel()
      model.observe(entry(2, 20, 220), 10_000)
      model.observe(entry(2, 45, 220), 20_000)
      expect(model.estimate(20_000).estado).toBe('fluindo')
    })

    it('computes slack as capacity minus current flow negative when over', () => {
      const model = trainedModel()
      expect(model.estimate(200_000).capacidade).not.toBeNull()

      // 2 cars on 220 m at 40 km/h -> k 9.0909, q 363.636
      model.observe(entry(2, 40, 220), 210_000)
      const light = model.estimate(210_000)
      expect(light.fluxo).toBeCloseTo(363.6, 1)
      expect(light.folga!).toBeCloseTo(light.capacidade! - light.fluxo, 6)

      // the plan's numbers: capacity 1250 and q 363.6 -> 886.4; q 1400 -> -150
      expect(CapacityModel.slack(1250, 363.6)).toBeCloseTo(886.4, 6)
      expect(CapacityModel.slack(1250, 1400)).toBeCloseTo(-150, 6)

      // over capacity: 70 cars on 1 km at 20 km/h -> q 1400 > capacity, negative slack
      model.observe(entry(70, 20), 220_000)
      const over = model.estimate(220_000)
      expect(over.fluxo).toBeCloseTo(1400, 6)
      expect(over.folga!).toBeLessThan(0)
      expect(over.folga!).toBeCloseTo(over.capacidade! - 1400, 6)
    })
  })

  describe('CapacityService', () => {
    const topic = (id: string) => `transito/sensores/${id}/telemetria`

    it('marks a route sem dados after 20 s without readings and keeps its model', () => {
      // per segment now (AD-022): the claim holds for each segment's model
      const transport = new FakeTransport(true)
      let now = 0
      const service = new CapacityService(transport, () => now)
      service.start()
      expect(service.snapshot()['central-I1-I2'].estado).toBe('sem dados') // never received

      for (let i = 1; i <= 20; i++) {
        const k = 5 * i
        now = i * 10_000
        transport.deliver(
          topic('C2'),
          message('C2', now, [{ trecho: 'central-I1-I2', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoCobertoM: 1000, cobertura: 1 }]),
        )
      }
      expect(service.snapshot()['central-I1-I2'].estado).toBe('congestionado')
      const capacity = service.snapshot()['central-I1-I2'].capacidade
      expect(capacity).not.toBeNull()
      now = 220_000
      expect(service.snapshot()['central-I1-I2'].estado).toBe('congestionado')
      now = 220_100
      const stale = service.snapshot()['central-I1-I2']
      expect(stale.estado).toBe('sem dados')
      expect(stale.capacidade).toBe(capacity)
      expect(stale.amostras).toHaveLength(20)

      // a late, older reading does not rewind the validity
      now = 230_000
      transport.deliver(topic('C2'), message('C2', 230_000, [{ trecho: 'central-I1-I2', contagem: 10, velocidadeMediaKmh: 45, comprimentoCobertoM: 1000, cobertura: 1 }]))
      transport.deliver(topic('C9'), message('C9', 5_000, [{ trecho: 'central-I1-I2', contagem: 80, velocidadeMediaKmh: 10, comprimentoCobertoM: 1000, cobertura: 1 }]))
      expect(service.snapshot()['central-I1-I2'].estado).toBe('fluindo')
      expect(service.snapshot()['central-I1-I2'].velocidade).toBe(45)
    })

    it('learns nothing while disconnected and resumes after reconnecting', () => {
      const transport = new FakeTransport(false)
      const service = new CapacityService(transport, () => 10_000)
      service.start()
      const send = () =>
        transport.deliver(topic('C2'), message('C2', 10_000, [{ trecho: 'central-I1-I2', contagem: 2, velocidadeMediaKmh: 40, comprimentoCobertoM: 220, cobertura: 0.55 }]))
      send()
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(0)
      transport.setConnected(true)
      send()
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(1)
      expect(service.snapshot()['central-I1-I2'].estado).toBe('fluindo')
      transport.setConnected(false)
      send()
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(1)
    })
  })

  describe('segments', () => {
    const topic = (id: string) => `transito/sensores/${id}/telemetria`

    it('learns per segment from porTrecho entries', () => {
      const transport = new FakeTransport(true)
      const service = new CapacityService(transport, () => 10_000)
      service.start()
      transport.deliver(
        topic('C2'),
        message('C2', 10_000, [
          // 2 cars on the 220 m the camera sees, 1 lane -> k 9.09 veh/km; at 40 km/h q 363.6 veh/h
          { trecho: 'central-I1-I2', contagem: 2, velocidadeMediaKmh: 40, comprimentoCobertoM: 220, cobertura: 0.55 },
          { trecho: 'central-I2-M', contagem: 0, velocidadeMediaKmh: null, comprimentoCobertoM: 50, cobertura: 0.42 },
        ]),
      )
      const s = service.snapshot()
      expect(Object.keys(s)).toHaveLength(11)
      expect(s['central-I1-I2'].densidade).toBeCloseTo(9.09, 2)
      expect(s['central-I1-I2'].velocidade).toBe(40)
      expect(s['central-I1-I2'].fluxo).toBeCloseTo(363.6, 1)
      expect(s['central-I1-I2'].amostras).toHaveLength(1)
      expect(s['central-I2-M'].densidade).toBe(0)
      expect(s['central-I2-M'].amostras).toHaveLength(0)
      expect(s['central-I2-M'].estado).toBe('fluindo')
      // a segment no sensor reports stays without data
      expect(s['central-F-I1'].estado).toBe('sem dados')
      expect(s['norte-I3-M'].estado).toBe('sem dados')
      // old route-based messages (porVia) are ignored
      transport.deliver(topic('C2'), JSON.stringify({ ts: 10_000, porVia: [{ via: 'central', contagem: 9, velocidadeMediaKmh: 9, comprimentoM: 220 }] }))
      expect(service.snapshot()['central-I1-I2'].amostras).toHaveLength(1)
    })

    it('summarises each route by its bottleneck segment', () => {
      const estimate = (estado: RouteStatus, velocidade: number | null, fluxo: number, capacidade: number | null, folga: number | null) => ({
        estado, velocidade, fluxo, capacidade, folga, densidade: 0, vf: null, kj: null, amostras: [],
      })
      const segs = new CapacityService(new FakeTransport(true), () => 0).segments
      const blank = Object.fromEntries(segs.map((s) => [s.id, estimate('sem dados', null, 0, null, null)]))
      // no data on any central segment -> sem dados
      expect(summariseRoute('central', segs, blank)).toEqual({ estado: 'sem dados', velocidade: null, fluxo: 0, capacidade: null, folga: null })

      const est = {
        ...blank,
        'central-F-I1': estimate('fluindo', 48, 300, 1200, 900),
        'central-I1-I2': estimate('congestionado', 12, 500, 900, 400),
        'central-I2-M': estimate('fluindo', null, 0, 1500, 1500), // empty road counts as free flow
        chegada: estimate('carregado', 30, 700, null, null),
      }
      expect(summariseRoute('central', segs, est)).toEqual({ estado: 'congestionado', velocidade: 12, fluxo: 500, capacidade: 900, folga: 400 })
      // the shared arrival stretch is part of every route
      expect(summariseRoute('norte', segs, est)).toEqual({ estado: 'carregado', velocidade: 30, fluxo: 700, capacidade: null, folga: null })
    })
  })
})
