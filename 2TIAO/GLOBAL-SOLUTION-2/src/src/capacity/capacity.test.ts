import { describe, expect, it } from 'vitest'
import { FakeTransport } from '../telemetry/testing'
import { CapacityModel } from './CapacityModel'
import { CapacityService } from './CapacityService'

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
  return JSON.stringify({ sensorId, tipo: 'camera+radar', ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porTrecho })
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
      expect(service.snapshot()['I12>I13'].estado).toBe('sem dados') // never received

      for (let i = 1; i <= 20; i++) {
        const k = 5 * i
        now = i * 10_000
        transport.deliver(
          topic('U02'),
          message('U02', now, [{ trecho: 'I12>I13', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoCobertoM: 1000, cobertura: 1 }]),
        )
      }
      expect(service.snapshot()['I12>I13'].estado).toBe('congestionado')
      now = 220_000 // the last (200 s) window has closed: all 20 samples in
      expect(service.snapshot()['I12>I13'].estado).toBe('congestionado')
      const capacity = service.snapshot()['I12>I13'].capacidade
      expect(capacity).not.toBeNull()
      now = 220_100
      const stale = service.snapshot()['I12>I13']
      expect(stale.estado).toBe('sem dados')
      expect(stale.capacidade).toBe(capacity)
      expect(stale.amostras).toHaveLength(20)

      // a late, older reading does not rewind the validity
      now = 230_000
      transport.deliver(topic('U02'), message('U02', 230_000, [{ trecho: 'I12>I13', contagem: 10, velocidadeMediaKmh: 45, comprimentoCobertoM: 1000, cobertura: 1 }]))
      transport.deliver(topic('U09'), message('U09', 5_000, [{ trecho: 'I12>I13', contagem: 80, velocidadeMediaKmh: 10, comprimentoCobertoM: 1000, cobertura: 1 }]))
      now = 240_000 // the 230 s window closes and reaches the model
      expect(service.snapshot()['I12>I13'].estado).toBe('fluindo')
      expect(service.snapshot()['I12>I13'].velocidade).toBe(45)
    })

    it('learns nothing while disconnected and resumes after reconnecting', () => {
      const transport = new FakeTransport(false)
      let now = 10_000
      const service = new CapacityService(transport, () => now)
      service.start()
      const send = () =>
        transport.deliver(topic('U02'), message('U02', 10_000, [{ trecho: 'I12>I13', contagem: 2, velocidadeMediaKmh: 40, comprimentoCobertoM: 220, cobertura: 0.55 }]))
      send()
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(0)
      now = 20_000
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(0)
      transport.setConnected(true)
      send() // the 10 s window, received now that the broker is back
      // received at 20 s, the 10 s window is already closed and reaches the model
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
      expect(service.snapshot()['I12>I13'].estado).toBe('fluindo')
      transport.setConnected(false)
      send()
      now = 40_000
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
    })
  })

  describe('segments', () => {
    const topic = (id: string) => `transito/sensores/${id}/telemetria`

    it('learns per segment from porTrecho entries', () => {
      const transport = new FakeTransport(true)
      let now = 10_000
      const service = new CapacityService(transport, () => now)
      service.start()
      transport.deliver(
        topic('U02'),
        message('U02', 10_000, [
          // 2 cars on the 220 m the camera sees, 1 lane -> k 9.09 veh/km; at 40 km/h q 363.6 veh/h
          { trecho: 'I12>I13', contagem: 2, velocidadeMediaKmh: 40, comprimentoCobertoM: 220, cobertura: 0.55 },
          { trecho: 'I13>I14', contagem: 0, velocidadeMediaKmh: null, comprimentoCobertoM: 50, cobertura: 0.42 },
        ]),
      )
      now = 20_000 // the window closes and reaches the models
      const s = service.snapshot()
      expect(Object.keys(s)).toHaveLength(48)
      expect(s['I12>I13'].densidade).toBeCloseTo(9.09, 2)
      expect(s['I12>I13'].velocidade).toBe(40)
      expect(s['I12>I13'].fluxo).toBeCloseTo(363.6, 1)
      expect(s['I12>I13'].amostras).toHaveLength(1)
      expect(s['I13>I14'].densidade).toBe(0)
      expect(s['I13>I14'].amostras).toHaveLength(0)
      expect(s['I13>I14'].estado).toBe('fluindo')
      // a segment no sensor reports stays without data
      expect(s['I11>I12'].estado).toBe('sem dados')
      expect(s['I23>I24'].estado).toBe('sem dados')
      // old route-based messages (porVia) are ignored
      transport.deliver(topic('U02'), JSON.stringify({ ts: 10_000, porVia: [{ via: 'central', contagem: 9, velocidadeMediaKmh: 9, comprimentoM: 220 }] }))
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
    })
  })
})
