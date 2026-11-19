import { describe, expect, it } from 'vitest'
import { metricsTopic } from '../fusion/PlateMatcher'
import { FakeTransport } from '../telemetry/testing'
import { lightAt, phaseFor } from '../sim/trafficLight'
import { SimulationEngine, STOP_LINE_M, TICK_MS } from '../sim/SimulationEngine'
import { CapacityModel, CONFIGURED_CAPACITY_VEH_H, SATURATION_FLOW_VEH_H } from './CapacityModel'
import { CapacityService } from './CapacityService'

/** `contagem` cars on `comprimentoM` metres at `v` km/h, as density and flow (q = k v). */
const entry = (contagem: number, velocidadeMediaKmh: number | null, comprimentoM = 1000) => {
  const densidadeVeicKm = contagem / (comprimentoM / 1000)
  return { densidadeVeicKm, velocidadeMediaKmh, fluxoVeicH: velocidadeMediaKmh === null ? 0 : densidadeVeicKm * velocidadeMediaKmh }
}

/** Feeds samples that lie exactly on v = 50 (1 - k / 100), k = 3, 6, ..., 90 (30 samples, AD-087). */
function trainedModel(): CapacityModel {
  const model = new CapacityModel()
  for (let i = 1; i <= 30; i++) {
    const k = 3 * i
    model.observe(entry(k, 50 * (1 - k / 100)), i * 6_000)
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

    it('C39 starts from the configured capacity and learns only after 30 valid samples', () => {
      expect(CONFIGURED_CAPACITY_VEH_H).toBeCloseTo((SATURATION_FLOW_VEH_H * 20) / 46, 9)
      expect(CONFIGURED_CAPACITY_VEH_H).toBeCloseTo(843.5, 0)
      // from the start, before any sample
      const fresh = new CapacityModel()
      expect(fresh.estimate(0)).toMatchObject({ capacidade: CONFIGURED_CAPACITY_VEH_H, capacidadeFonte: 'configurada' })
      // 5 exact samples: still the configured one
      const few = new CapacityModel()
      for (let i = 1; i <= 5; i++) few.observe(entry(5 * i, 50 * (1 - (5 * i) / 100)), i * 10_000)
      expect(few.estimate(50_000)).toMatchObject({ capacidade: CONFIGURED_CAPACITY_VEH_H, capacidadeFonte: 'configurada' })
      expect(few.estimate(50_000).folga).toBeCloseTo(CONFIGURED_CAPACITY_VEH_H - few.estimate(50_000).fluxo, 9)
      // 29 valid samples: configured; the 30th makes it the learned one
      const learning = new CapacityModel()
      for (let i = 1; i <= 29; i++) learning.observe(entry(3 * i, 50 * (1 - (3 * i) / 100)), i * 10_000)
      expect(learning.estimate(290_000).capacidadeFonte).toBe('configurada')
      learning.observe(entry(90, 5), 300_000)
      expect(learning.estimate(300_000).capacidadeFonte).toBe('aprendida')
      expect(learning.estimate(300_000).capacidade).toBeCloseTo(1250, -1)
      // an invalid fit (speed rising with density: kj <= 0) keeps the configured one however many samples
      const rising = new CapacityModel()
      for (let i = 1; i <= 40; i++) rising.observe(entry(i, 20 + i), i * 10_000)
      expect(rising.estimate(400_000)).toMatchObject({ capacidade: CONFIGURED_CAPACITY_VEH_H, capacidadeFonte: 'configurada', kj: null })
      // flat speed: slope 0, still the configured one
      const flat = new CapacityModel()
      for (let i = 1; i <= 40; i++) flat.observe(entry(i, 50), i * 10_000)
      expect(flat.estimate(400_000).capacidadeFonte).toBe('configurada')
      // readings without speed do not count as fit samples
      const empty = new CapacityModel()
      for (let i = 1; i <= 40; i++) empty.observe(entry(0, null), i * 10_000)
      expect(empty.estimate(400_000).capacidadeFonte).toBe('configurada')
      expect(empty.estimate(400_000).amostras).toHaveLength(0)
    })

    it('C39 the configured saturation flow matches the measured queue discharge', () => {
      // 12 cars standing 7 m apart at a red stop line; at green, the steady headway of cars 5 to 12
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const red = () => phaseFor(lightAt('I12', engine.getState().timeMs), 'H') === 'vermelho'
      while (!red()) engine.tick(TICK_MS)
      const line = engine.segment('I11>I12')!.length - STOP_LINE_M
      const cars = Array.from({ length: 12 }, (_, k) => engine.addCar({ path: ['I11>I12', 'I12>I13'], distance: line - k * 7, velocity: 0 }))
      while (red()) engine.tick(TICK_MS)
      const green = engine.getState().timeMs
      const crossed = new Map<number, number>()
      for (let i = 0; i < 300; i++) {
        engine.tick(TICK_MS)
        for (const c of cars) {
          const s = engine.getState().cars.find((x) => x.id === c.id)
          if (!crossed.has(c.id) && (!s || s.seg > 0 || s.distance > line)) crossed.set(c.id, engine.getState().timeMs - green)
        }
      }
      const t = cars.map((c) => crossed.get(c.id)!)
      const headwayS = (t[11] - t[4]) / 7 / 1000
      const measured = 3600 / headwayS
      expect(Math.abs(measured - SATURATION_FLOW_VEH_H) / SATURATION_FLOW_VEH_H).toBeLessThanOrEqual(0.05)
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
      // 30 samples: the learned capacity replaces the configured one (AD-087)
      const ks = Array.from({ length: 30 }, (_, i) => 3 * (i + 1))
      ks.forEach((k, i) => {
        now = (i + 1) * 10_000
        // the flow published is the measured one, here 7 cars/min whatever k and v
        transport.deliver(metricsTopic('I11>I12'), metrics('I11>I12', now, k, 50 * (1 - k / 100), 7))
      })
      const s = service.snapshot()['I11>I12']
      expect(s.capacidade!).toBeCloseTo(1250, 0)
      expect(s.capacidadeFonte).toBe('aprendida')
      expect(s.densidade).toBe(90)
      expect(s.velocidade).toBeCloseTo(5, 9)
      expect(s.fluxo).toBe(420)
      expect(s.amostras).toHaveLength(30)
    })

    it('marks a route sem dados after 20 s without readings and keeps its model', () => {
      // per segment now (AD-022): the claim holds for each segment's model
      const transport = new FakeTransport(true)
      let now = 0
      const service = new CapacityService(transport, () => now)
      service.start()
      expect(service.snapshot()['I12>I13'].semDados).toBe(true) // never received

      for (let i = 1; i <= 20; i++) {
        const k = 5 * i
        now = i * 10_000
        transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', now, k, 50 * (1 - k / 100)))
      }
      expect(service.snapshot()['I12>I13'].semDados).toBe(false)
      now = 220_000 // 20 s after the last (200 s) publication: all 20 samples in
      expect(service.snapshot()['I12>I13'].semDados).toBe(false)
      const capacity = service.snapshot()['I12>I13'].capacidade
      expect(capacity).not.toBeNull()
      now = 220_100
      const stale = service.snapshot()['I12>I13']
      expect(stale.semDados).toBe(true)
      expect(stale.capacidade).toBe(capacity)
      expect(stale.amostras).toHaveLength(20)

      // a late, older publication does not rewind the validity
      now = 230_000
      transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 230_000, 10, 45))
      transport.deliver(metricsTopic('I12>I13'), metrics('I12>I13', 5_000, 80, 10))
      now = 240_000
      expect(service.snapshot()['I12>I13'].semDados).toBe(false)
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
      expect(service.snapshot()['I12>I13'].semDados).toBe(false)
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
      expect(s['I13>I14'].semDados).toBe(false)
      // a segment with no metrics stays without data
      expect(s['I11>I12'].semDados).toBe(true)
      expect(s['I23>I24'].semDados).toBe(true)
      // old telemetry messages are ignored
      transport.deliver('transito/sensores/U02/telemetria', JSON.stringify({ sensorId: 'U02', ts: 10_000, porTrecho: [{ trecho: 'I12>I13', contagem: 9, velocidadeMediaKmh: 9, comprimentoCobertoM: 220, cobertura: 1 }] }))
      expect(service.snapshot()['I12>I13'].amostras).toHaveLength(1)
    })
  })
})
