import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATIONS_FILTER } from '../apps/AppNotifier'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { candidatesFor, evaluate, selectNotified } from './DriverRerouter'
import { chooseFraction, FRACOES, simulateDiversion, type DiversionSimulation } from './simulateDiversion'
import { Simulation } from './Simulation'

const JAMMED = 'I12>I13'

/**
 * A live run: default demand, seed 1001, an accident on the block at 1 min, the block told to crawl
 * at 4 km/h. No plate cameras, so the injected metrics are the only speed the rerouter knows.
 */
function liveRun() {
  const transport = new FakeTransport(true)
  const engine = new SimulationEngine({ ratePerMinute: 75, seed: 1001, arrivals: 'poisson', cameras: [] })
  const sim = new Simulation({ engine, transport })
  sim.setDiversionEnabled(false)
  sim.start()
  const advance = (ms: number) => {
    const end = engine.getState().timeMs + ms
    while (engine.getState().timeMs < end) {
      const t = engine.getState().timeMs
      if (t === 60_000) engine.addBlockage(JAMMED, 120, 120_000)
      sim.tick()
      // the block crawls, so drivers have faster alternatives
      const now = engine.getState().timeMs
      if (now >= 60_000 && now % 10_000 === 0) deliverMetrics(transport, JAMMED, now, { k: 60, v: 4, ocupacao: 9 })
    }
  }
  return { transport, engine, sim, advance }
}

/** What the live engine is, compared field by field. */
function snapshot(engine: SimulationEngine) {
  const s = engine.getState()
  return {
    timeMs: s.timeMs,
    cars: s.cars.map((c) => ({ id: c.id, path: [...c.path], seg: c.seg, distance: c.distance, velocity: c.velocity, saida: c.saida, placa: c.placa, app: c.app })),
    waiting: engine.waitingCars().map((c) => ({ id: c.id, path: [...c.path], placa: c.placa, app: c.app })),
    spawnedTotal: s.spawnedTotal,
    arrivedTotal: s.arrivedTotal,
    reroutedTotal: s.reroutedTotal,
    lights: s.lights,
    blockages: s.blockages,
    co2TotalG: s.co2TotalG,
  }
}

describe('simulateDiversion', () => {
  it('C19 returns the door 6 table with one 10 min clone per fraction', { timeout: 60_000 }, () => {
    const { engine, sim, advance } = liveRun()
    advance(150_000)
    const t = engine.getState().timeMs
    // every copy made: the first from the live engine now, the others split from it on the way
    // (a copy is exportState -> restore: the job crosses a worker boundary as plain data, AD-103)
    const exports: { fromLive: boolean; at: number }[] = []
    const copies: SimulationEngine[] = []
    const originalExport = SimulationEngine.prototype.exportState
    const originalRestore = SimulationEngine.restore
    const exportSpy = vi.spyOn(SimulationEngine.prototype, 'exportState').mockImplementation(function (this: SimulationEngine, opts) {
      exports.push({ fromLive: this === engine, at: this.getState().timeMs })
      return originalExport.call(this, opts)
    })
    const restoreSpy = vi.spyOn(SimulationEngine, 'restore').mockImplementation((s) => {
      const c = originalRestore(s)
      copies.push(c)
      return c
    })
    const r = simulateDiversion(sim, JAMMED)
    exportSpy.mockRestore()
    restoreSpy.mockRestore()
    const clones = exports.map((e, i) => ({ ...e, engine: copies[i] }))
    expect(Object.keys(r).sort()).toEqual(['eficaz', 'escolhida', 'fracoes', 'horizonteMin', 'trecho'])
    expect(r.trecho).toBe(JAMMED)
    expect(r.horizonteMin).toBe(10)
    expect(r.fracoes.map((f) => f.fracao)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 1])
    for (const f of r.fracoes) {
      expect(Object.keys(f).sort()).toEqual(['co2Kg', 'fracao', 'ocupacaoMaxAlternativa', 'ocupacaoMaxTrecho', 'tempoMedioS'])
      for (const k of ['co2Kg', 'ocupacaoMaxAlternativa', 'ocupacaoMaxTrecho', 'tempoMedioS'] as const) expect(Number.isFinite(f[k])).toBe(true)
    }
    // one copy of the live engine, taken now; every copy ran to 10 simulated minutes from now
    expect(clones.filter((c) => c.fromLive)).toHaveLength(1)
    expect(clones[0]).toMatchObject({ fromLive: true, at: t })
    for (const c of clones) expect(c.engine.getState().timeMs).toBe(t + 600_000)
    // each row is what its own 10 min run from a copy of now gives: run every fraction on its own
    const segById = new Map(engine.getState().segments.map((s) => [s.id, s]))
    const fused = sim.capacity.fusion.state()
    const speedOf = (id: string) => fused[id]?.velocidadeMedia ?? null
    const rerouted: number[] = []
    for (const [i, fracao] of FRACOES.entries()) {
      const own = engine.clone({ cameras: false })
      const travel: number[] = []
      own.onArrival((a) => travel.push(a.travelS))
      const co2 = own.getState().co2TotalG
      while (own.getState().timeMs < t + 600_000) {
        if (own.getState().timeMs % 10_000 === 0) {
          const s = own.getState()
          const evals = candidatesFor([...s.cars, ...own.waitingCars()], JAMMED, segById).map((c) => evaluate(c, s.segments, speedOf, JAMMED))
          for (const e of selectNotified(evals, 'parcial', fracao)) if (e.alternative) own.reroute(e.carId, e.alternative)
        }
        own.tick(TICK_MS)
      }
      rerouted.push(own.getState().reroutedTotal - engine.getState().reroutedTotal)
      expect(r.fracoes[i].tempoMedioS).toBe(Math.round((travel.reduce((a, b) => a + b, 0) / travel.length) * 10) / 10)
      expect(r.fracoes[i].co2Kg).toBe(Math.round((own.getState().co2TotalG - co2) / 10) / 100)
    }
    // the fraction is applied: none rerouted at 0%, some at 10%, never fewer with a larger fraction
    expect(rerouted[0]).toBe(0)
    expect(rerouted[1]).toBeGreaterThan(0)
    for (let i = 1; i < rerouted.length; i++) expect(rerouted[i]).toBeGreaterThanOrEqual(rerouted[i - 1])
    expect(r.fracoes[6]).not.toEqual({ ...r.fracoes[0], fracao: 1 })
    expect(r.fracoes[6].ocupacaoMaxAlternativa).toBeGreaterThan(0)
    expect({ escolhida: r.escolhida, eficaz: r.eficaz }).toEqual(chooseFraction(r.fracoes))
  })

  it('C20 leaves the live simulation as a twin that never called it', { timeout: 60_000 }, () => {
    const a = liveRun()
    const b = liveRun()
    a.advance(150_000)
    b.advance(150_000)
    expect(snapshot(a.engine)).toEqual(snapshot(b.engine))
    const r = simulateDiversion(a.sim, JAMMED)
    // the clones rerouted drivers; the live one did not
    expect(r.fracoes[6].ocupacaoMaxAlternativa).toBeGreaterThan(0)
    expect(snapshot(a.engine)).toEqual(snapshot(b.engine))
    const publishedBefore = a.transport.published.length
    expect(publishedBefore).toBe(b.transport.published.length)
    a.advance(120_000)
    b.advance(120_000)
    // time, cars, waiting cars, lights, blockages and the random draws (spawns, plates, apps) agree
    expect(snapshot(a.engine)).toEqual(snapshot(b.engine))
    expect(a.engine.getState().spawnedTotal).toBeGreaterThan(0)
    expect(a.transport.published.map((m) => [m.topic, m.payload])).toEqual(b.transport.published.map((m) => [m.topic, m.payload]))
  })

  it('C21 picks the smallest effective fraction', () => {
    const rows = (pairs: [number, number][]) => pairs.map(([t, alt], i) => ({ fracao: FRACOES[i], ocupacaoMaxTrecho: t, ocupacaoMaxAlternativa: alt }))
    // the plan's example
    expect(chooseFraction(rows([[120, 40], [95, 50], [85, 60], [80, 70]]))).toEqual({ escolhida: 0.2, eficaz: true })
    // no fraction relieves the segment: the lowest of the two maxima, not effective
    expect(chooseFraction(rows([[120, 40], [100, 50], [95, 93], [92, 96], [91, 97], [90, 99], [90, 120]]))).toEqual({ escolhida: 0.2, eficaz: false })
    // already below 90% without diverting: 0% (no diversion)
    expect(chooseFraction(rows([[60, 30], [55, 35], [50, 40]]))).toEqual({ escolhida: 0, eficaz: true })
    // the alternative counts too: relieved segment, jammed alternative is not effective
    expect(chooseFraction(rows([[95, 20], [85, 91], [80, 60]]))).toEqual({ escolhida: 0.2, eficaz: true })
    // 89.9 is below, 90 is not
    expect(chooseFraction(rows([[90, 10], [89.9, 89.9]]))).toEqual({ escolhida: 0.1, eficaz: true })
    expect(chooseFraction(rows([[90, 10], [10, 90]]))).toEqual({ escolhida: 0, eficaz: false })
  })
})

/** A simulation that always picks `escolhida`, counting its calls. */
function fixed(escolhida: number) {
  const fn = vi.fn((_sim: Simulation, trecho: string): DiversionSimulation => ({
    trecho,
    horizonteMin: 10,
    fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: fracao >= escolhida ? 80 : 120, ocupacaoMaxAlternativa: 40, tempoMedioS: 90, co2Kg: 2 })),
    escolhida,
    eficaz: true,
  }))
  return fn
}

describe('diversion', () => {
  it('C22 notifies the simulated fraction when the segment turns Crítico', () => {
    const run = (escolhida: number) => {
      const transport = new FakeTransport(true)
      const simulate = fixed(escolhida)
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0, cameras: [] }), transport, simulateDiversion: simulate })
      sim.start()
      // 10 drivers with a map app, waiting before the block they all cross next
      for (let i = 0; i < 10; i++) sim.engine.addCar({ path: ['I11>I12', JAMMED, 'I13>I14'], distance: 5 + i * 8, velocity: 0, app: 'waze' })
      for (let t = 0; t < 9_900; t += TICK_MS) sim.tick()
      expect(sim.diversion.status).toBe('inativo')
      expect(simulate).not.toHaveBeenCalled()
      // the block crawls at 3 km/h: Crítico at the 10 s recompute
      deliverMetrics(transport, JAMMED, sim.engine.getState().timeMs, { k: 60, v: 3, ocupacao: 9 })
      sim.tick()
      const notices = transport.published.filter((m) => topicMatches(NOTIFICATIONS_FILTER, m.topic))
      return { sim, simulate, notices }
    }
    const { sim, simulate, notices } = run(0.2)
    expect(simulate).toHaveBeenCalledTimes(1)
    // the front car may already have entered the block: 9 or 10 still ahead of it, 2 told either way
    expect(sim.diversion).toMatchObject({ status: 'ativo', trecho: JAMMED, p: 0.2, notificados: 2 })
    expect(sim.diversion.status === 'ativo' && sim.diversion.candidatos).toBeGreaterThanOrEqual(9)
    expect(notices).toHaveLength(2)
    for (const n of notices) expect(JSON.parse(n.payload)).toMatchObject({ trechoEvitado: JAMMED })
    expect(sim.diversion.status === 'ativo' && sim.diversion.simulacao?.escolhida).toBe(0.2)
    // the next windows reuse the diversion's simulation
    for (let t = 0; t < 20_000; t += TICK_MS) {
      if (sim.engine.getState().timeMs % 10_000 === 9_900) deliverMetrics(new FakeTransport(true), JAMMED, 0, { k: 0, v: 0 })
      sim.tick()
    }
    expect(simulate).toHaveBeenCalledTimes(1)
    // 0%: nobody is told
    const none = run(0)
    expect(none.sim.diversion).toMatchObject({ status: 'ativo', p: 0, notificados: 0 })
    expect(none.notices).toHaveLength(0)
  })
})
