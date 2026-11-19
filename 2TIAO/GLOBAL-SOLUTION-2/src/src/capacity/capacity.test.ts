import { describe, expect, it } from 'vitest'
import { metricsTopic } from '../fusion/PlateMatcher'
import { FakeTransport } from '../telemetry/testing'
import { CapacityModel } from './CapacityModel'
import { CapacityService } from './CapacityService'

/** `contagem` cars on `comprimentoM` metres at `v` km/h, as density and flow (q = k v). */
const entry = (contagem: number, velocidadeMediaKmh: number | null, comprimentoM = 1000) => {
  const densidadeVeicKm = contagem / (comprimentoM / 1000)
  return { densidadeVeicKm, velocidadeMediaKmh, fluxoVeicH: velocidadeMediaKmh === null ? 0 : densidadeVeicKm * velocidadeMediaKmh }
}

/** Feeds samples that lie exactly on v = 50 (1 - k / 100), k = 5, 10, ..., 100 (20 samples). */
function trainedModel(): CapacityModel {
  const model = new CapacityModel()
  for (let i = 1; i <= 20; i++) {
    const k = 5 * i
    model.observe(entry(k, 50 * (1 - k / 100)), i * 10_000)
  }
  return model
}

/** A segment's metrics (door 2): density `k`, pair speed `v` and `fluxo` exits per minute. */
function metrics(trecho: string, ts: number, k: number, v: number | null, fluxo = v === null ? 0 : (k * v) / 60) {
  return JSON.stringify({ trecho, ts, janelaS: 60, fluxoVeicMin: fluxo, velocidadeMediaKmh: v, pares: v === null ? 0 : 1, entraram: 0, sairam: 0, ocupacao: 0, densidadeVeicKm: k, camerasPar: ['C02E', 'C02S'] })
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
    it('C17 learns capacity from the metrics density and speed and shows the measured flow', () => {
      const transport = new FakeTransport(true)
      let now = 0
      const service = new CapacityService(transport, () => now)
      service.start()
      const ks = [10, 20, 30, 40, 50, 60, 70, 80]
      ks.forEach((k, i) => {
        now = (i + 1) * 10_000
        // the flow published is the measured one, here 7 cars/min whatever k and v
        transport.deliver(metricsTopic('I11>I12'), metrics('I11>I12', now, k, 50 * (1 - k / 100), 7))
      })
      const s = service.snapshot()['I11>I12']
      expect(s.capacidade!).toBeCloseTo(1250, 0)
      expect(s.densidade).toBe(80)
      expect(s.velocidade).toBeCloseTo(10, 9)
      expect(s.fluxo).toBe(420)
      expect(s.amostras).toHaveLength(8)
    })

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
        transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', now, k, 50 * (1 - k / 100)))
      }
      expect(service.snapshot()['I12>I13'].estado).toBe('congestionado')
      now = 220_000 // 20 s after the last (200 s) publication: all 20 samples in
      expect(service.snapshot()['I12>I13'].estado).toBe('congestionado')
      const capacity = service.snapshot()['I12>I13'].capacidade
      expect(capacity).not.toBeNull()
      now = 220_100
      const stale = service.snapshot()['I12>I13']
      expect(stale.estado).toBe('sem dados')
      expect(stale.capacidade).toBe(capacity)
      expect(stale.amostras).toHaveLength(20)

      // a late, older publication does not rewind the validity
      now = 230_000
      transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 230_000, 10, 45))
      transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 5_000, 80, 10))
      now = 240_000
      expect(service.snapshot()['I12>I13'].estado).toBe('fluindo')
      expect(service.snapshot()['I12>I13'].velocidade).toBe(45)
    })

    it('learns nothing while disconnected and resumes after reconnecting', () => {
      const transport = new FakeTransport(false)
      let now = 10_000
      const service = new CapacityService(transport, () => now)
      service.start()
      const send = () => transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 10_000, 9.1, 40))
      send()
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(0)
      now = 20_000
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(0)
      transport.setConnected(true)
      send() // the 10 s publication, received now that the broker is back
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
      expect(service.snapshot()['I12>I13'].estado).toBe('fluindo')
      transport.setConnected(false)
      send()
      now = 40_000
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
    })
  })

  describe('segments', () => {
    it('learns per segment from each segment metrics', () => {
      const transport = new FakeTransport(true)
      const now = 10_000
      const service = new CapacityService(transport, () => now)
      service.start()
      // 9.09 veh/km at 40 km/h, 6 cars/min measured -> 360 veh/h
      transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 10_000, 9.09, 40, 6))
      transport.deliver(metricsTopic('I13>I14'), metrics('I13>I14', 10_000, 0, null))
      const s = service.snapshot()
      expect(Object.keys(s)).toHaveLength(48)
      expect(s['I12>I13'].densidade).toBeCloseTo(9.09, 2)
      expect(s['I12>I13'].velocidade).toBe(40)
      expect(s['I12>I13'].fluxo).toBe(360)
      expect(s['I12>I13'].amostras).toHaveLength(1)
      expect(s['I13>I14'].densidade).toBe(0)
      expect(s['I13>I14'].amostras).toHaveLength(0)
      expect(s['I13>I14'].estado).toBe('fluindo')
      // a segment with no metrics stays without data
      expect(s['I11>I12'].estado).toBe('sem dados')
      expect(s['I23>I24'].estado).toBe('sem dados')
      // old telemetry messages are ignored
      transport.deliver('transito/sensores/U02/telemetria', JSON.stringify({ sensorId: 'U02', ts: 10_000, porTrecho: [{ trecho: 'I12>I13', contagem: 9, velocidadeMediaKmh: 9, comprimentoCobertoM: 220, cobertura: 1 }] }))
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
    })
  })
})
