import { describe, expect, it, vi } from 'vitest'
import { FRACOES, type DiversionSimulation } from '../decision/simulateDiversion'
import { Simulation } from '../decision/Simulation'
import { monitoredSegments } from '../fusion/PlateMatcher'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { ForecastClient, type Previsao, type PrevisaoEntrada, type PrevisaoEvento, type PrevisaoSaida } from './ForecastClient'
import { SegmentHistory } from '../decision/SegmentHistory'

const JAMMED = 'I12>I13'
const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const stubSimulation = (_sim: Simulation, trecho: string): DiversionSimulation => ({
  trecho,
  horizonteMin: 10,
  fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: 80, ocupacaoMaxAlternativa: 40, tempoMedioS: 90, co2Kg: 1 })),
  escolhida: 0,
  eficaz: true,
})

/** Ticks `sim` to `ms`, letting the service's answers arrive after each 60 s mark. */
async function runTo(sim: Simulation, ms: number) {
  while (sim.engine.getState().timeMs < ms) {
    sim.tick()
    if (sim.engine.getState().timeMs % 60_000 === 0) await flush()
  }
}

describe('forecast', () => {
  it('C17 sends the door 2 body every 60 s from 10 min on', async () => {
    const calls: { t: number; body: PrevisaoEntrada }[] = []
    const engine = new SimulationEngine({ ratePerMinute: 75, seed: 1001 })
    const sim = new Simulation({
      engine,
      transport: new FakeTransport(true),
      simulateDiversion: stubSimulation,
      prever: async (body) => {
        calls.push({ t: engine.getState().timeMs, body })
        return { modelo: 'teste', previsoes: {} }
      },
    })
    sim.start()
    await runTo(sim, 599_900)
    expect(calls).toHaveLength(0)
    await runTo(sim, 600_000)
    expect(calls.map((c) => c.t)).toEqual([600_000])
    const { body } = calls[0]
    expect(Object.keys(body).sort()).toEqual(['diaSemana', 'horaMin', 'trechos'])
    // Monday 07:00 + 10 min
    expect(body.diaSemana).toBe(1)
    expect(body.horaMin).toBe(430)
    const paired = monitoredSegments(engine.getState().cameras).map((m) => m.trecho)
    expect(paired).toHaveLength(12)
    expect(Object.keys(body.trechos).sort()).toEqual([...paired].sort())
    let nullSpeeds = 0
    for (const id of paired) {
      const lags = body.trechos[id]
      expect(Object.keys(lags).sort()).toEqual(['d', 'f', 'v'])
      // the history at 60, 120, ..., 600 s, oldest first
      const points = [60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000, 540_000, 600_000].map((t) => sim.history.of(id).find((p) => p.t === t)!)
      expect(lags.v).toEqual(points.map((p) => (p.velocidade === null ? -1 : p.velocidade)))
      expect(lags.f).toEqual(points.map((p) => (p.fluxo === null ? 0 : p.fluxo / 60)))
      expect(lags.d).toEqual(points.map((p) => p.densidade ?? 0))
      nullSpeeds += points.filter((p) => p.velocidade === null).length
    }
    // the history holds a null speed somewhere, and it went as -1
    expect(nullSpeeds).toBeGreaterThan(0)
    expect(Object.values(body.trechos).some((l) => l.v.includes(-1))).toBe(true)
    expect(Object.values(body.trechos).some((l) => l.f.some((f) => f > 0))).toBe(true)
    await runTo(sim, 660_000)
    expect(calls.map((c) => c.t)).toEqual([600_000, 660_000])
    expect(calls[1].body.horaMin).toBe(431)
  })

  it('C15 emits one previsao event per crossing of 90 percent with exit below 80', async () => {
    const pcts = [89, 90, 90, 85, 92, 79, 90]
    let call = 0
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    const sim: Simulation = new Simulation({
      engine,
      transport: new FakeTransport(true),
      prever: async (body) => {
        const pct = pcts[call++] ?? 50
        const cap = sim.capacity.snapshot()[JAMMED].capacidade!
        const previsoes: Record<string, Previsao> = {}
        for (const id of Object.keys(body.trechos)) previsoes[id] = { v15: 30, f15: 1, v30: 30, f30: 1 }
        previsoes[JAMMED] = { v15: 21, f15: (pct * cap) / 6000, v30: 18, f30: (pct * cap) / 6000 + 1 }
        return { modelo: 'teste', previsoes }
      },
    })
    sim.start()
    const events: PrevisaoEvento[] = []
    sim.onPrevisao((e) => events.push(e))
    const counts: number[] = []
    const listed: boolean[] = []
    for (let i = 0; i < pcts.length; i++) {
      await runTo(sim, 600_000 + i * 60_000)
      sim.refreshIncidents()
      counts.push(events.length)
      listed.push(sim.incidents.active().some((x) => x.key === `previsto:${JAMMED}`))
    }
    // 89 none; 90 one; 90 again none; 85 then 92 none; 79 then 90 the second
    expect(counts).toEqual([0, 1, 1, 1, 1, 1, 2])
    expect(listed).toEqual([false, true, true, true, true, false, true])
    const cap = sim.capacity.snapshot()[JAMMED].capacidade!
    expect(Object.keys(events[0]).sort()).toEqual(['f15', 'ocupacao15', 'ocupacao30', 'tipo', 'trecho', 'ts', 'v15'])
    expect(events[0]).toMatchObject({ tipo: 'previsao', trecho: JAMMED, ts: 660_000, ocupacao15: 90, v15: 21 })
    expect(events[0].f15).toBeCloseTo((90 * cap) / 6000, 9)
    expect(events[0].ocupacao30).toBeCloseTo(90 + (60 * 100) / cap, 0)
    expect(events[1]).toMatchObject({ trecho: JAMMED, ts: 960_000, ocupacao15: 90 })
    const inc = sim.incidents.active().find((x) => x.key === `previsto:${JAMMED}`)!
    expect(inc).toMatchObject({ kind: 'previsto', segmentId: JAMMED, previstoPara: 960_000 + 900_000, ocupacaoPrevista: 90 })
    // the service goes down for 3 calls: the forecast segments leave the list
    const down = new Simulation({
      engine: new SimulationEngine({ ratePerMinute: 0 }),
      transport: new FakeTransport(true),
      prever: (() => {
        let n = 0
        return async (body: PrevisaoEntrada): Promise<PrevisaoSaida> => {
          if (n++ > 0) throw new Error('fora')
          return { modelo: 't', previsoes: Object.fromEntries(Object.keys(body.trechos).map((id) => [id, { v15: 10, f15: 100, v30: 10, f30: 100 }])) }
        }
      })(),
    })
    down.start()
    await runTo(down, 600_000)
    down.refreshIncidents()
    expect(down.incidents.active().filter((x) => x.kind === 'previsto')).toHaveLength(12)
    await runTo(down, 720_000)
    down.refreshIncidents()
    expect(down.incidents.active().filter((x) => x.kind === 'previsto')).toHaveLength(12)
    await runTo(down, 780_000)
    down.refreshIncidents()
    expect(down.forecast!.status).toBe('indisponivel')
    expect(down.incidents.active().filter((x) => x.kind === 'previsto')).toHaveLength(0)
  })

  it('C18 drops a response older than the one applied', async () => {
    const history = new SegmentHistory()
    for (let t = 10_000; t <= 900_000; t += 10_000) history.record(t, { [JAMMED]: { fluxo: 300, capacidade: 844, velocidade: 30, densidade: 12 } }, { avgSpeed: null, travelMin: null })
    const pending: { resolve: (r: PrevisaoSaida) => void; reject: (e: Error) => void }[] = []
    const events: PrevisaoEvento[] = []
    const client = new ForecastClient({
      prever: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      segments: [JAMMED],
      history,
      capacityOf: () => 600,
      onEvent: (e) => events.push(e),
    })
    const answer = (f15: number): PrevisaoSaida => ({ modelo: 't', previsoes: { [JAMMED]: { v15: 20, f15, v30: 20, f30: f15 } } })
    client.tick(600_000)
    client.tick(660_000)
    expect(pending).toHaveLength(2)
    // the newer one answers first: 10 cars/min of 600 veh/h -> 100%
    pending[1].resolve(answer(10))
    await flush()
    expect(client.previsoes[JAMMED].f15).toBe(10)
    expect(client.previsoesEm).toBe(660_000)
    expect(events.map((e) => e.ts)).toEqual([660_000])
    // the older one arrives late (60%): ignored, the segment stays forecast
    pending[0].resolve(answer(6))
    await flush()
    expect(client.previsoes[JAMMED].f15).toBe(10)
    expect(client.previsoesEm).toBe(660_000)
    expect(client.predicted().map((p) => p.trecho)).toEqual([JAMMED])
    expect(events).toHaveLength(1)
    // a late failure of an old call does not count against the service either
    client.tick(720_000)
    client.tick(780_000)
    client.tick(840_000)
    pending[4].resolve(answer(10))
    await flush()
    pending[2].reject(new Error('fora'))
    pending[3].reject(new Error('fora'))
    await flush()
    expect(client.status).toBe('ok')
  })

  it('C14 the simulation and the diversion keep working with the service down', async () => {
    const prever = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const transport = new FakeTransport(true)
    const engine = new SimulationEngine({ ratePerMinute: 75, seed: 1001 })
    const sim = new Simulation({ engine, transport, prever, simulateDiversion: stubSimulation })
    sim.setDiversionEnabled(true)
    sim.start()
    await runTo(sim, 780_000)
    expect(prever).toHaveBeenCalledTimes(4)
    expect(sim.forecast!.status).toBe('indisponivel')
    // the map still has a reading and a level for every paired segment, and cars still move
    const paired = monitoredSegments(engine.getState().cameras).map((m) => m.trecho)
    const readings = sim.readings()
    for (const id of paired) expect(['livre', 'moderado', 'intenso', 'critico']).toContain(readings[id].nivel)
    expect(engine.getState().arrivedTotal).toBeGreaterThan(0)
    // a segment turning Crítico still diverts: the matcher goes quiet, so only these metrics speak
    vi.spyOn(sim.matcher, 'tick').mockImplementation(() => {})
    // (within the 30 s guard after any earlier diversion's change, AD-018)
    for (let t = 0; t < 60_000 && sim.diversion.status !== 'ativo'; t += TICK_MS) {
      const now = engine.getState().timeMs
      if (now % 10_000 === 9_900) deliverMetrics(transport, JAMMED, now, { k: 60, v: 3, ocupacao: 9 })
      sim.tick()
    }
    expect(sim.diversion).toMatchObject({ status: 'ativo', trecho: JAMMED })
  })
})
