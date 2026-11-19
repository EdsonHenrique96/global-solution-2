import { describe, expect, it } from 'vitest'
import { Simulation } from '../decision/Simulation'
import { readSegment } from '../render/levels'
import { DEFAULT_UNIT_BLOCKS } from '../sensors/camera'
import { eventsTopic, type Papel } from '../sensors/PlateCamera'
import { buildSegments } from '../sensors/segments'
import { buildCityNetwork } from '../sim/cityNetwork'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { FusionService } from './FusionService'
import { anomalyOf, anomalyTopic, METRICS_FILTER, metricsTopic, PlateMatcher, type SegmentAnomaly, type SegmentMetrics } from './PlateMatcher'

const METRIC_KEYS = ['camerasPar', 'densidadeVeicKm', 'entraram', 'fluxoVeicMin', 'janelaS', 'ocupacao', 'pares', 'sairam', 'trecho', 'ts', 'velocidadeMediaKmh']
const MONITORED = DEFAULT_UNIT_BLOCKS.map(([a, b]) => `${a}>${b}`)

/** A matcher over two 250 m segments, A and B, with a clock the test moves. */
function bench() {
  const transport = new FakeTransport(true)
  const clock = { t: 0 }
  const matcher = new PlateMatcher(transport, () => clock.t, [
    { trecho: 'A', comprimentoM: 250, camerasPar: ['C01E', 'C01S'] },
    { trecho: 'B', comprimentoM: 250, camerasPar: ['C02E', 'C02S'] },
  ])
  matcher.start()
  const ev = (trecho: string, papel: Papel, placaHash: string, ts: number) =>
    transport.deliver(eventsTopic(trecho), JSON.stringify({ cameraId: 'C01E', trecho, papel, placaHash, ts, faixa: 1, classe: 'carro' }))
  /** Moves the clock and returns what the matcher published for `trecho` at that time, if anything. */
  const at = (t: number, trecho = 'A'): SegmentMetrics | undefined => {
    clock.t = t
    matcher.tick()
    const m = transport.published.filter((p) => p.topic === metricsTopic(trecho)).map((p) => JSON.parse(p.payload) as SegmentMetrics)
    return m.filter((x) => x.ts === t).at(-1)
  }
  return { transport, matcher, ev, at }
}

describe('plate matcher', () => {
  it('C12 pairs an exit with the pending entry of the same hash on the same segment', () => {
    const { matcher, ev, at } = bench()
    ev('A', 'entrada', 'h1', 0)
    ev('A', 'saida', 'h1', 18_000)
    expect(matcher.guarda('h1')).toBe(false)
    let m = at(20_000)!
    expect(m.pares).toBe(1)
    expect(m.velocidadeMediaKmh).toBe(50)
    // an exit with no pending entry: counted as an exit and in the flow, not in the speed
    ev('A', 'saida', 'h2', 25_000)
    m = at(30_000)!
    expect(m.sairam).toBe(2)
    expect(m.fluxoVeicMin).toBe(2)
    expect(m.pares).toBe(1)
    expect(m.velocidadeMediaKmh).toBe(50)
    // in on A, out on B with the same hash: no pair
    ev('A', 'entrada', 'h3', 31_000)
    ev('B', 'saida', 'h3', 35_000)
    const b = at(40_000, 'B')!
    expect(b.pares).toBe(0)
    expect(b.velocidadeMediaKmh).toBeNull()
    expect(b.sairam).toBe(1)
    expect(matcher.guarda('h3')).toBe(true)
  })

  it('C13 drops entries without exit after 10 minutes and keeps no hash', () => {
    const { matcher, ev, at } = bench()
    for (let i = 0; i < 100; i++) ev('A', 'entrada', `h${i}`, 0)
    at(599_900)
    expect(matcher.pendentes()).toBe(100)
    at(600_000)
    expect(matcher.pendentes()).toBe(0)
    for (let i = 0; i < 100; i++) expect(matcher.guarda(`h${i}`)).toBe(false)
    ev('A', 'entrada', 'p', 600_000)
    expect(matcher.guarda('p')).toBe(true)
    ev('A', 'saida', 'p', 605_000)
    expect(matcher.guarda('p')).toBe(false)
    expect(matcher.pendentes()).toBe(0)
  })

  it('C14 publishes the door 2 metrics of the 12 paired segments every 10 s', () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30 }), transport })
    sim.start()
    for (let t = 0; t < 30_000; t += TICK_MS) sim.tick()
    const metrics = transport.published.filter((m) => topicMatches(METRICS_FILTER, m.topic))
    expect(metrics).toHaveLength(36)
    for (const ts of [10_000, 20_000, 30_000]) {
      const at = metrics.map((m) => ({ ...m, body: JSON.parse(m.payload) as SegmentMetrics })).filter((m) => m.body.ts === ts)
      expect(at.map((m) => m.body.trecho).sort()).toEqual([...MONITORED].sort())
      for (const m of at) {
        const n = String(MONITORED.indexOf(m.body.trecho) + 1).padStart(2, '0')
        expect(m.topic).toBe(`transito/vias/${m.body.trecho}/metricas`)
        expect(m.options).toEqual({ qos: 0, retain: true })
        expect(Object.keys(m.body).sort()).toEqual(METRIC_KEYS)
        expect(m.body.janelaS).toBe(60)
        expect(m.body.camerasPar).toEqual([`C${n}E`, `C${n}S`])
      }
    }
  })

  it('C15 computes the one minute window metrics', () => {
    // two pairs of 10 s and 30 s on 250 m: space mean 45 km/h, not the arithmetic 60
    {
      const { ev, at } = bench()
      ev('A', 'entrada', 'x', 0)
      ev('A', 'entrada', 'y', 0)
      ev('A', 'saida', 'x', 10_000)
      ev('A', 'saida', 'y', 30_000)
      expect(at(30_000)!.velocidadeMediaKmh).toBe(45)
    }
    // a pair closed at 5 s counts at 60 s and not at 70 s
    {
      const { ev, at } = bench()
      ev('A', 'entrada', 'p', 0)
      ev('A', 'saida', 'p', 5_000)
      expect(at(60_000)!.pares).toBe(1)
      const later = at(70_000)!
      expect(later.pares).toBe(0)
      expect(later.velocidadeMediaKmh).toBeNull()
    }
    // 8 in, 3 out on 250 m: 5 inside, 20 veh/km; flow = exits in the last 60 s
    {
      const { ev, at } = bench()
      for (let i = 0; i < 8; i++) ev('A', 'entrada', `e${i}`, 1_000)
      ev('A', 'saida', 'e0', 5_000)
      ev('A', 'saida', 'e1', 30_000)
      ev('A', 'saida', 'e2', 65_000)
      const m = at(70_000)!
      expect(m.entraram).toBe(8)
      expect(m.sairam).toBe(3)
      expect(m.ocupacao).toBe(5)
      expect(m.densidadeVeicKm).toBe(20)
      expect(m.fluxoVeicMin).toBe(2)
    }
    // entries without an exit never enter the speed (AD-091): waiting 90 s with no pair -> null
    {
      const transport = new FakeTransport(true)
      const clock = { t: 0 }
      const m = new PlateMatcher(transport, () => clock.t, [{ trecho: 'L', comprimentoM: 128, camerasPar: ['C01E', 'C01S'] }])
      m.start()
      transport.deliver(eventsTopic('L'), JSON.stringify({ cameraId: 'C01E', trecho: 'L', papel: 'entrada', placaHash: 'w', ts: 0, faixa: 1, classe: 'carro' }))
      const at = (t: number) => {
        clock.t = t
        m.tick()
        return transport.published.map((p) => JSON.parse(p.payload) as SegmentMetrics).filter((x) => x.ts === t).at(-1)!
      }
      expect(at(40_000).velocidadeMediaKmh).toBeNull()
      const blocked = at(90_000)
      expect(blocked.velocidadeMediaKmh).toBeNull()
      expect(blocked.pares).toBe(0)
    }
    // no pair: no speed; more exits than entries: never a negative occupancy
    {
      const { ev, at } = bench()
      ev('A', 'entrada', 'only', 1_000)
      expect(at(10_000)!.velocidadeMediaKmh).toBeNull()
      ev('B', 'saida', 'q1', 11_000)
      ev('B', 'saida', 'q2', 12_000)
      const b = at(20_000, 'B')!
      expect(b.ocupacao).toBe(0)
      expect(b.densidadeVeicKm).toBe(0)
    }
  })

  it('C35 opens the anomaly warning at 80 percent of overdue cars and closes below 50', () => {
    const entries = (n: number, inside: number, ts: number) => Array.from({ length: n }, (_, i) => ({ ts, exited: i >= inside }))
    const T = 100_000
    // median crossing 5 s -> overdue after max(30 s, 15 s) = 30 s
    const crossings = [5_000, 5_000, 6_000]
    // a full block: 4 of 4 overdue cars inside -> opens
    expect(anomalyOf(entries(4, 4, T - 40_000), crossings, T, false)).toMatchObject({ ativo: true, atrasados: 4, fracao: 1 })
    // exactly 80 %, 4 of 5 -> opens; 3 of 4 (75 %) -> not
    expect(anomalyOf(entries(5, 4, T - 40_000), crossings, T, false).ativo).toBe(true)
    expect(anomalyOf(entries(4, 3, T - 40_000), crossings, T, false).ativo).toBe(false)
    // 1 or 2 cars that stop while the rest pass: never 3 -> no warning, even at 100 %
    expect(anomalyOf(entries(2, 2, T - 40_000), crossings, T, false).ativo).toBe(false)
    expect(anomalyOf(entries(12, 2, T - 40_000), crossings, T, false).ativo).toBe(false)
    // 3 overdue out of 10 (30 %) -> no warning
    expect(anomalyOf(entries(10, 3, T - 40_000), crossings, T, false)).toMatchObject({ ativo: false, atrasados: 3, fracao: 0.3 })
    // not overdue yet (29 s): nothing counts
    expect(anomalyOf(entries(5, 5, T - 29_000), crossings, T, false)).toMatchObject({ ativo: false, atrasados: 0 })
    // a slow hour (median 20 s) waits 3 x 20 = 60 s
    expect(anomalyOf(entries(5, 5, T - 50_000), [20_000, 20_000], T, false).ativo).toBe(false)
    expect(anomalyOf(entries(5, 5, T - 61_000), [20_000, 20_000], T, false).ativo).toBe(true)
    // cars that entered more than 2 min ago are out of the window
    expect(anomalyOf(entries(5, 5, T - 121_000), crossings, T, false)).toMatchObject({ ativo: false, atrasados: 0 })
    // open: holds at 50 %, closes below it
    expect(anomalyOf(entries(4, 2, T - 40_000), crossings, T, true).ativo).toBe(true)
    expect(anomalyOf(entries(5, 2, T - 40_000), crossings, T, true).ativo).toBe(false)

    // through the matcher: 6 normal 5 s crossings early on (the hour's median), then 4 cars enter
    // and none leaves -> one warning on the door 5 topic, then it closes
    const { transport, ev, at } = bench()
    for (let i = 0; i < 6; i++) {
      ev('A', 'entrada', `n${i}`, i * 1_000)
      ev('A', 'saida', `n${i}`, i * 1_000 + 5_000)
    }
    const B = 200_000
    for (let i = 0; i < 4; i++) ev('A', 'entrada', `b${i}`, B + 1_000 + i * 1_000)
    at(B + 30_000)
    expect(transport.published.filter((p) => p.topic === anomalyTopic('A'))).toHaveLength(0)
    at(B + 40_000)
    const opened = transport.published.filter((p) => p.topic === anomalyTopic('A'))
    expect(opened).toHaveLength(1)
    expect(opened[0].options).toEqual({ qos: 0, retain: true })
    const body = JSON.parse(opened[0].payload) as SegmentAnomaly
    expect(Object.keys(body).sort()).toEqual(['ativo', 'atrasados', 'fracao', 'trecho', 'ts'])
    expect(body).toMatchObject({ trecho: 'A', ts: B + 40_000, ativo: true, atrasados: 4, fracao: 1 })
    // the metrics never carry it, and the speed stays the pairs' (none -> null)
    const m = JSON.parse(transport.published.filter((p) => p.topic === metricsTopic('A')).at(-1)!.payload) as SegmentMetrics
    expect(m.velocidadeMediaKmh).toBeNull()
    expect(Object.keys(m)).not.toContain('ativo')
    // 3 of the 4 leave: 25 % < 50 % -> closes
    for (let i = 0; i < 3; i++) ev('A', 'saida', `b${i}`, B + 45_000)
    at(B + 50_000)
    const all = transport.published.filter((p) => p.topic === anomalyTopic('A')).map((p) => JSON.parse(p.payload) as SegmentAnomaly)
    expect(all.map((a) => a.ativo)).toEqual([true, false])
  })

  it('C37 exits after the salt change close the entries from before it', () => {
    const { transport, matcher, ev, at } = bench()
    // 5 cars enter at 00:59:50 and leave at 01:00:05; the hour turned, so their exit hashes differ
    for (let i = 0; i < 5; i++) ev('A', 'entrada', `antes${i}`, 3_590_000)
    for (let i = 0; i < 5; i++) ev('A', 'saida', `depois${i}`, 3_605_000)
    expect(matcher.pendentes()).toBe(0)
    const m = at(3_720_000)!
    expect(m.sairam).toBe(5)
    expect(m.pares).toBe(0)
    expect(m.velocidadeMediaKmh).toBeNull()
    // and no anomaly from them
    expect(transport.published.filter((p) => p.topic === anomalyTopic('A'))).toHaveLength(0)
    // an unmatched exit within the same hour closes nothing
    ev('A', 'entrada', 'x', 3_700_000)
    ev('A', 'saida', 'y', 3_710_000)
    expect(matcher.guarda('x')).toBe(true)
  })

  it('C18 while the broker is down no metrics reach the fusion and segments go sem dado', { timeout: 60_000 }, () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30 }), transport })
    sim.start()
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += TICK_MS) sim.tick()
    }
    const level = () => {
      const t = sim.engine.getState().timeMs
      return readSegment('I12>I13', sim.capacity.snapshot()['I12>I13'], sim.capacity.fusion.state()['I12>I13'], t).nivel
    }
    run(60_000)
    expect(sim.capacity.fusion.state()['I12>I13'].atualizadoEm).toBe(60_000)
    transport.setConnected(false)
    const spawned = sim.engine.getState().spawnedTotal
    run(20_000)
    expect(sim.capacity.fusion.state()['I12>I13'].atualizadoEm).toBe(60_000)
    expect(level()).not.toBe('sem dado')
    run(100)
    expect(level()).toBe('sem dado')
    run(30_000)
    expect(sim.capacity.fusion.state()['I12>I13'].atualizadoEm).toBe(60_000)
    expect(sim.engine.getState().spawnedTotal).toBeGreaterThan(spawned)
    transport.setConnected(true)
    run(10_000)
    expect(sim.capacity.fusion.state()['I12>I13'].atualizadoEm).toBe(120_000)
    expect(level()).not.toBe('sem dado')
  })

  it('C20 ignores malformed events and metrics', () => {
    const { transport, matcher, at } = bench()
    const raw = (payload: string) => transport.deliver(eventsTopic('A'), payload)
    raw('{not json')
    raw(JSON.stringify({ trecho: 'A', papel: 'entrada', placaHash: 5, ts: 0 }))
    raw(JSON.stringify({ trecho: 'A', papel: 'meio', placaHash: 'h', ts: 0 }))
    raw(JSON.stringify({ trecho: 'A', papel: 'entrada', placaHash: 'h' }))
    raw(JSON.stringify({ trecho: 'Z', papel: 'entrada', placaHash: 'h', ts: 0 }))
    const m = at(10_000)!
    expect(m.entraram).toBe(0)
    expect(m.sairam).toBe(0)
    expect(matcher.pendentes()).toBe(0)

    const segments = buildSegments(buildCityNetwork())
    const fusion = new FusionService(transport, () => 10_000, segments)
    fusion.start()
    const good = { trecho: 'I11>I12', ts: 10_000, janelaS: 60, fluxoVeicMin: 6, velocidadeMediaKmh: 45, pares: 2, entraram: 8, sairam: 3, ocupacao: 5, densidadeVeicKm: 20, camerasPar: ['C01E', 'C01S'] }
    const send = (body: object) => transport.deliver(metricsTopic('I11>I12'), JSON.stringify(body))
    send({ ...good, trecho: 'X1>X2' })
    send({ ...good, densidadeVeicKm: '20' })
    send({ ...good, velocidadeMediaKmh: 'rápido' })
    send({ ...good, ts: 20_000 })
    transport.deliver(metricsTopic('I11>I12'), '{oops')
    expect(fusion.state()['I11>I12'].atualizadoEm).toBeNull()
    send(good)
    expect(fusion.state()['I11>I12'].atualizadoEm).toBe(10_000)
  })
})
