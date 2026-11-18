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

function message(droneId: string, ts: number, porVia: unknown[]) {
  return JSON.stringify({ droneId, ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porVia })
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
    it('turns each porVia entry from the subscription into density, speed and flow', () => {
      const transport = new FakeTransport(true)
      const service = new CapacityService(transport, () => 10_000)
      service.start()
      transport.deliver(
        'transito/drones/D2/telemetria',
        message('D2', 10_000, [
          { via: 'central', contagem: 2, velocidadeMediaKmh: 40, comprimentoM: 220 },
          { via: 'norte', contagem: 0, velocidadeMediaKmh: null, comprimentoM: 50 },
          { via: 'sul', contagem: 3, velocidadeMediaKmh: 30, comprimentoM: 0 },
        ]),
      )
      const central = service.snapshot().central
      expect(central.densidade).toBeCloseTo(9.09, 2)
      expect(central.velocidade).toBe(40)
      expect(central.fluxo).toBeCloseTo(363.6, 1)
      expect(central.amostras).toEqual([{ k: expect.closeTo(9.0909, 3), q: expect.closeTo(363.636, 2) }])

      const norte = service.snapshot().norte
      expect(norte.densidade).toBe(0)
      expect(norte.fluxo).toBe(0)
      expect(norte.amostras).toHaveLength(0)
      expect(norte.estado).toBe('fluindo')

      // comprimentoM 0: nothing learned for sul
      expect(service.snapshot().sul.estado).toBe('sem dados')
      expect(service.snapshot().sul.amostras).toHaveLength(0)

      // malformed and old (no porVia) payloads are ignored
      transport.deliver('transito/drones/D1/telemetria', 'not json')
      transport.deliver(
        'transito/drones/D1/telemetria',
        JSON.stringify({ droneId: 'D1', ts: 10_000, janelaS: 10, contagem: 1, velocidadeMediaKmh: 9, ruidoPct: 0 }),
      )
      expect(service.snapshot().central.amostras).toHaveLength(1)
    })

    it('marks a route sem dados after 20 s without readings and keeps its model', () => {
      const transport = new FakeTransport(true)
      let now = 0
      const service = new CapacityService(transport, () => now)
      service.start()
      expect(service.snapshot().central.estado).toBe('sem dados') // never received

      for (let i = 1; i <= 20; i++) {
        const k = 5 * i
        now = i * 10_000
        transport.deliver(
          'transito/drones/D2/telemetria',
          message('D2', now, [{ via: 'central', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoM: 1000 }]),
        )
      }
      // last reading at 200 s: v = 0 -> congestionado
      expect(service.snapshot().central.estado).toBe('congestionado')
      const capacity = service.snapshot().central.capacidade
      expect(capacity).not.toBeNull()

      now = 220_000 // exactly 20 s later: still valid
      expect(service.snapshot().central.estado).toBe('congestionado')
      now = 220_100 // more than 20 s
      const stale = service.snapshot().central
      expect(stale.estado).toBe('sem dados')
      expect(stale.capacidade).toBe(capacity)
      expect(stale.amostras).toHaveLength(20)
    })

    it('learns nothing while disconnected and resumes after reconnecting', () => {
      const transport = new FakeTransport(false)
      const service = new CapacityService(transport, () => 10_000)
      service.start()
      const send = () =>
        transport.deliver(
          'transito/drones/D2/telemetria',
          message('D2', 10_000, [{ via: 'central', contagem: 2, velocidadeMediaKmh: 40, comprimentoM: 220 }]),
        )
      send()
      expect(service.snapshot().central.amostras).toHaveLength(0)
      expect(service.snapshot().central.estado).toBe('sem dados')

      transport.setConnected(true)
      send()
      expect(service.snapshot().central.amostras).toHaveLength(1)
      expect(service.snapshot().central.estado).toBe('fluindo')

      transport.setConnected(false)
      send()
      expect(service.snapshot().central.amostras).toHaveLength(1)
    })
  })
})
