import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE_PER_MINUTE, SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { emissionFactor, IDLE_G_PER_S } from './emission'
import { CSV_HEADER, summarise, toCsv } from './csv'
import { chooseFraction, FRACOES } from '../decision/simulateDiversion'
import { ACCIDENT, normalisationS, RUN_MS, runExperiment, runScenario, SCENARIOS, seedFor, type RunMetrics } from './ExperimentRunner'

const FREE_MS = 50 / 3.6

function runFor(engine: SimulationEngine, ms: number) {
  const end = engine.getState().timeMs + ms
  while (engine.getState().timeMs < end) engine.tick(TICK_MS)
}

describe('experiments', () => {
  it('C36 runs last 25 minutes', { timeout: 120_000 }, () => {
    expect(RUN_MS).toBe(1_500_000)
    const r = runScenario('sem-sistema', seedFor(1))
    expect((r.trace.queueBySecond as number[]).length).toBe(1_500)
  })

  it('C42 the default demand normalises within the run', { timeout: 120_000 }, () => {
    const r = runScenario('sem-sistema', 1001, { acidenteMin: 2, demanda: DEFAULT_RATE_PER_MINUTE })
    expect(r.trace.demanda).toBe(75)
    expect(r.tempoNormalizarS).not.toBeNull()
    expect(r.tempoNormalizarS!).toBeGreaterThanOrEqual(0)
    expect(r.tempoNormalizarS!).toBeLessThanOrEqual(1_500 - 300)
  })

  it('C24 desvio-parcial diverts the fraction chosen by simulateDiversion', { timeout: 300_000 }, () => {
    const params = { acidenteMin: 2 as const, demanda: 75 }
    const [sem, todos, parcial] = SCENARIOS.map((c) => runScenario(c, 1001, params))
    for (const r of [sem, todos, parcial]) expect(r.trace).toMatchObject({ seed: 1001, demanda: 75, acidenteMin: 2 })
    type Sim = { t: number; trecho: string; escolhida: number; fracoes: unknown[] }
    type Win = { t: number; trecho: string; p: number; candidatos: number; aptos: number; notificados: number }
    const sims = parcial.trace.simulacoes as Sim[]
    const windows = parcial.trace.janelas as Win[]
    // the decision simulated the fractions and diverted
    expect(sims.length).toBeGreaterThan(0)
    expect(windows.length).toBeGreaterThan(0)
    expect(parcial.fracaoDesvio).toBe(sims[0].escolhida)
    for (const w of windows) {
      // no window before its segment's simulation, and the window uses that simulation's choice
      const s = sims.filter((x) => x.trecho === w.trecho && x.t <= w.t).at(-1)
      expect(s).toBeDefined()
      expect(s!.fracoes).toHaveLength(7)
      expect(w.p).toBe(s!.escolhida)
      expect(w.notificados).toBe(Math.max(0, Math.min(w.aptos, Math.ceil(w.p * w.candidatos - 1e-9))))
    }
    // what the apps were actually sent is what the windows told
    expect(parcial.trace.notified).toBe(windows.reduce((n, w) => n + w.notificados, 0))
    // "notificar todos" tells everyone with a faster alternative: no fraction simulated
    expect(todos.trace.simulacoes).toEqual([])
    expect(todos.fracaoDesvio).toBe(1)
    expect(sem.fracaoDesvio).toBeNull()
    expect(sem.trace.notified).toBe(0)
    // the same rules with a fraction above 0: a simulation that always chooses 20 %
    const fixed = runScenario('desvio-parcial', 1001, params, (_sim, trecho) => ({
      trecho,
      horizonteMin: 10,
      fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: 80, ocupacaoMaxAlternativa: 40, tempoMedioS: 90, co2Kg: 2 })),
      escolhida: 0.2,
      eficaz: true,
    }))
    const fSims = fixed.trace.simulacoes as Sim[]
    const fWindows = fixed.trace.janelas as Win[]
    expect(fixed.fracaoDesvio).toBe(0.2)
    expect(fWindows.some((w) => w.p === 0.2 && w.notificados > 0)).toBe(true)
    for (const w of fWindows) {
      expect(fSims.some((x) => x.trecho === w.trecho && x.t <= w.t)).toBe(true)
      expect(w.p).toBe(0.2)
      expect(w.notificados).toBe(Math.max(0, Math.min(w.aptos, Math.ceil(w.p * w.candidatos - 1e-9))))
    }
    expect(fixed.trace.notified).toBe(fWindows.reduce((n, w) => n + w.notificados, 0))
    expect(fixed.trace.notified).toBeGreaterThan(0)
    console.log('C24', JSON.stringify({ escolhida: sims.map((x) => [x.t, x.trecho, x.escolhida]), tempo: [sem, todos, parcial].map((r) => r.tempoMedioViagemS), notified: [todos.trace.notified, parcial.trace.notified] }))
  })

  it('C39 the confirmed accident is simulated and its fraction recorded, whatever it is (AD-104, AD-107, AD-108)', { timeout: 300_000 }, () => {
    const parcial = runScenario('desvio-parcial', 1001, { acidenteMin: 5, demanda: 75 })
    const { avisoEm, confirmadoEm } = parcial.trace as { avisoEm: number | null; confirmadoEm: number | null }
    // the warning opens and the incident is confirmed 60 s later
    expect(avisoEm).not.toBeNull()
    expect(confirmadoEm).toBe(avisoEm! + 60_000)
    type Row = { fracao: number; ocupacaoMaxTrecho: number; ocupacaoMaxAlternativa: number }
    type Sim = { t: number; trecho: string; escolhida: number; eficaz: boolean; fracoes: Row[] }
    const acc = (parcial.trace.simulacoes as Sim[]).filter((s) => s.trecho === ACCIDENT.segmentId)
    // computed when the warning opened, before the confirmation
    expect(acc.length).toBeGreaterThan(0)
    expect(acc[0].t).toBe(avisoEm)
    // the simulation sees the queue before the block (AD-107)
    expect(acc[0].fracoes[0].ocupacaoMaxTrecho).toBeGreaterThanOrEqual(90)
    // the choice is a result, not a target: it is the rule's answer on the table, 0% included (AD-108)
    for (const s of acc) expect(chooseFraction(s.fracoes).escolhida).toBe(s.escolhida)
    console.log('C39', JSON.stringify(acc.map((s) => ({ t: s.t, escolhida: s.escolhida, eficaz: s.eficaz, linhas: s.fracoes.map((f) => [f.fracao, f.ocupacaoMaxTrecho, f.ocupacaoMaxAlternativa]) }))))
  })

  it('C25 the csv ends with fracao_desvio', () => {
    const m = (fracaoDesvio: number | null): RunMetrics => ({
      tempoMedioViagemS: 100,
      co2TotalKg: 10,
      co2GKm: 150,
      tempoParadoMedioS: 20,
      filaMaxima: 12,
      tempoNormalizarS: 60,
      saturacaoAlternativaPct: 80,
      desviadosPct: 5,
      fracaoDesvio,
    })
    const rows = [
      { cenario: 'sem-sistema', repeticao: 1, semente: 1001, metrics: m(null) },
      { cenario: 'notificar-todos', repeticao: 1, semente: 1001, metrics: m(1) },
      { cenario: 'desvio-parcial', repeticao: 1, semente: 1001, metrics: m(0.2) },
      { cenario: 'desvio-parcial', repeticao: 2, semente: 1002, metrics: m(0.3) },
    ]
    const lines = toCsv(rows, { acidenteMin: 2, demanda: 75 }).slice(1).trimEnd().split('\r\n')
    expect(lines[0].split(';').at(-1)).toBe('fracao_desvio')
    expect(lines[0].endsWith(';demanda_carros_min;fracao_desvio')).toBe(true)
    const last = (prefix: string) => lines.find((l) => l.startsWith(prefix))!.split(';').at(-1)
    expect(last('sem-sistema;1;')).toBe('')
    expect(last('notificar-todos;1;')).toBe('1')
    expect(last('desvio-parcial;1;')).toBe('0,2')
    expect(last('desvio-parcial;2;')).toBe('0,3')
    expect(last('sem-sistema;media;')).toBe('')
    expect(last('notificar-todos;media;')).toBe('1')
    expect(last('desvio-parcial;media;')).toBe('0,25')
    for (const l of lines) expect(l.split(';')).toHaveLength(14)
  })

  describe('emission', () => {
    it('adds moving emission by speed factor and idle emission per second', () => {
      expect(emissionFactor(10)).toBeGreaterThan(emissionFactor(30))
      expect(emissionFactor(30)).toBeGreaterThan(emissionFactor(50))
      // minimum near 70 km/h
      expect(emissionFactor(70)).toBeLessThan(emissionFactor(60))
      expect(emissionFactor(70)).toBeLessThan(emissionFactor(80))
      expect(emissionFactor(70)).toBeCloseTo(140, 0)
      expect(IDLE_G_PER_S).toBe(0.6)

      // 1 km at a constant 50 km/h on a free road (around the grid's edge, ~1.2 km): factor(50) grams
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green', cameras: [] })
      const around = ['I11>I12', 'I12>I13', 'I13>I14', 'I14>I24', 'I24>I34', 'I34>I44', 'I44>I43', 'I43>I42', 'I42>I41']
      expect(around.reduce((m, x) => m + engine.segment(x)!.length, 0)).toBeGreaterThan(1050)
      const id = engine.addCar({ path: around }).id
      const kmTicks = Math.round(1000 / (FREE_MS * 0.1))
      for (let i = 0; i < kmTicks; i++) engine.tick(TICK_MS)
      const car = engine.getState().cars.find((c) => c.id === id)!
      expect(car.traveledM).toBeCloseTo(kmTicks * FREE_MS * 0.1, 6)
      expect(car.co2G).toBeCloseTo((emissionFactor(50) * car.traveledM) / 1000, 3)

      // 60 s stopped: 36 g
      const idle = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green', cameras: [] })
      idle.addBlockage('I12>I13', 70)
      const s = idle.addCar({ path: ['I12>I13', 'I13>I14'], distance: 63, velocity: 0 }).id // already against the blockage
      runFor(idle, 60_000)
      const stopped = idle.getState().cars.find((c) => c.id === s)!
      expect(stopped.stoppedS).toBeCloseTo(60, 6)
      expect(stopped.co2G).toBeCloseTo(36, 6)
      // the engine totals follow the cars
      expect(idle.getState().co2TotalG).toBeCloseTo(36, 6)
    })

    it("reports each car's CO2 distance and stopped time on arrival", () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const arrivals: { co2G: number; distanciaM: number; paradoS: number; carId: number }[] = []
      engine.onArrival((a) => arrivals.push(a))
      // I13 is red for Al. Santos from 43 s (offset 20 s) to 66 s: the car reaches its line at ~52 s
      runFor(engine, 43_000)
      const path = ['I12>I13', 'I13>I14']
      const total = path.reduce((m, id) => m + engine.segment(id)!.length, 0)
      const id = engine.addCar({ path, distance: 0, velocity: 0 }).id
      const snapshot: { co2G: number; traveledM: number; stoppedS: number }[] = []
      let last = { co2G: 0, traveledM: 0, stoppedS: 0 }
      for (let t = 0; t < 200_000 && arrivals.length === 0; t += TICK_MS) {
        engine.tick(TICK_MS)
        const c = engine.getState().cars.find((x) => x.id === id)
        if (c) last = { co2G: c.co2G, traveledM: c.traveledM, stoppedS: c.stoppedS }
        snapshot.push(last)
      }
      expect(arrivals).toHaveLength(1)
      const [a] = arrivals
      expect(a.carId).toBe(id)
      // the whole path (two blocks), give or take the last step past its end (< 1.4 m)
      expect(a.distanciaM).toBeGreaterThanOrEqual(total - 1e-6)
      expect(a.distanciaM).toBeLessThan(total + FREE_MS * 0.1)
      expect(a.co2G).toBeGreaterThanOrEqual(last.co2G)
      expect(a.paradoS).toBeGreaterThanOrEqual(last.stoppedS)
      // it stood at I13's red: stopped time and the idle part of its CO2 are in the arrival
      expect(a.paradoS).toBeGreaterThan(0)
    })
  })

  describe('arrivals', () => {
    it('draws exponential gaps that repeat per seed', { timeout: 60_000 }, () => {
      const run = (seed: number) => {
        const e = new SimulationEngine({ ratePerMinute: 60, arrivals: 'poisson', seed, cameras: [] })
        const times: number[] = []
        let last = 0
        for (let t = 0; t < 600_000; t += TICK_MS) {
          e.tick(TICK_MS)
          const n = e.getState().spawnedTotal
          if (n > last) times.push(e.getState().timeMs)
          last = n
        }
        return { total: e.getState().spawnedTotal, times }
      }
      const a = run(1)
      const b = run(1)
      const c = run(2)
      expect(a.total).toBeGreaterThanOrEqual(540)
      expect(a.total).toBeLessThanOrEqual(660)
      expect(b).toEqual(a)
      expect(c.times).not.toEqual(a.times)
      // gaps vary (exponential), unlike the deterministic default
      const gaps = a.times.slice(1).map((t, i) => t - a.times[i])
      expect(new Set(gaps).size).toBeGreaterThan(10)
      const det = new SimulationEngine({ ratePerMinute: 60, cameras: [] })
      runFor(det, 600_000)
      expect(det.getState().spawnedTotal).toBe(600)
    })
  })

  describe('scenarios', () => {
    it('runs the three scenarios on the city grid with the same accident and seed', { timeout: 120_000 }, () => {
      expect(SCENARIOS).toEqual(['sem-sistema', 'notificar-todos', 'desvio-parcial'])
      expect(ACCIDENT).toEqual({ segmentId: 'I12>I13', startMs: 300_000 })
      const middle = new SimulationEngine({ ratePerMinute: 0, cameras: [] }).segment('I12>I13')!.length / 2
      const runs = Object.fromEntries(SCENARIOS.map((s) => [s, runScenario(s, 7)])) as Record<string, RunMetrics & { trace: Record<string, unknown> }>
      for (const s of SCENARIOS) {
        expect(runs[s].trace.seed).toBe(7)
        // the engine's own blockage events: I12>I13, in the middle, from 300 s to 420 s
        expect(runs[s].trace.blockages).toEqual([
          { segmentId: 'I12>I13', distance: middle, ativo: true, ts: 300_000 },
          { segmentId: 'I12>I13', distance: middle, ativo: false, ts: 420_000 },
        ])
        // same seed -> same demand
        expect(runs[s].trace.spawned).toBe(runs['sem-sistema'].trace.spawned)
        // "% desviado" counts the drivers notified and rerouted
        expect(runs[s].desviadosPct).toBeCloseTo((100 * (runs[s].trace.rerouted as number)) / (runs[s].trace.spawned as number), 9)
        expect(runs[s].trace.rerouted).toBe(runs[s].trace.notified)
      }
      expect(runs['sem-sistema'].trace).toMatchObject({ adaptiveSignals: false, diversionEnabled: false })
      expect(runs['desvio-parcial'].trace).toMatchObject({ adaptiveSignals: true, diversionEnabled: true, diversionMode: 'parcial' })
      expect(runs['notificar-todos'].trace).toMatchObject({ adaptiveSignals: false, diversionEnabled: true, diversionMode: 'todos' })
      // same seed, same run
      expect(runScenario('desvio-parcial', 7)).toEqual(runs['desvio-parcial'])
    })

    it('notifies nobody without the system and someone when notifying all', { timeout: 120_000 }, () => {
      const params = { acidenteMin: 5 as const, demanda: 75 }
      const none = runScenario('sem-sistema', seedFor(1), params)
      expect(none.trace.notified).toBe(0)
      expect(none.desviadosPct).toBe(0)
      const all = runScenario('notificar-todos', seedFor(1), params)
      expect(all.trace.notified as number).toBeGreaterThanOrEqual(1)
      expect(all.desviadosPct).toBeGreaterThan(0)
    })
  })

  describe('metrics', () => {
    it('measures every run metric from its definition', { timeout: 120_000 }, () => {
      const r = runScenario('desvio-parcial', 3) as RunMetrics & { trace: Record<string, unknown> }
      const t = r.trace as {
        arrivals: { travelS: number; co2G: number; distanciaM: number; paradoS: number }[]
        co2TotalG: number
        distanceTotalM: number
        queueBySecond: number[]
        spawned: number
        rerouted: number
        altFlowMax: Record<string, number>
        altCapacity: Record<string, number | null>
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
      expect(t.arrivals.length).toBeGreaterThan(50)
      expect(r.tempoMedioViagemS).toBeCloseTo(mean(t.arrivals.map((a) => a.travelS)), 9)
      expect(r.co2TotalKg).toBeCloseTo(t.co2TotalG / 1000, 9)
      expect(r.co2GKm).toBeCloseTo(t.co2TotalG / (t.distanceTotalM / 1000), 9)
      expect(r.tempoParadoMedioS).toBeCloseTo(mean(t.arrivals.map((a) => a.paradoS)), 9)
      expect(r.filaMaxima).toBe(Math.max(...t.queueBySecond))
      expect(r.desviadosPct).toBeCloseTo((100 * t.rerouted) / t.spawned, 9)
      // normalisation: once the queue has gone over the limit after the accident, the first second
      // from which it stays at or under the limit for 30 s (AD-028)
      const before = mean(t.queueBySecond.slice(0, 300))
      const limit = Math.max(1.2 * before, before + 1)
      const over = t.queueBySecond.findIndex((q, s) => s >= 300 && q > limit)
      expect(over).toBeGreaterThanOrEqual(300) // the accident does build a queue in this run (index 300 = second 301)
      let expected: number | null = null
      for (let s = over; s + 30 <= t.queueBySecond.length; s++) {
        if (t.queueBySecond.slice(s, s + 30).every((q) => q <= limit)) {
          expected = s + 1 - 300 // queueBySecond[s] is second s + 1
          break
        }
      }
      expect(r.tempoNormalizarS).toBe(expected)
      expect(r.tempoNormalizarS).toBeGreaterThan(0)
      // the rule on fixed queues: never over -> 0; over then back -> from the accident; never back -> null
      const flat = Array(400).fill(1)
      expect(normalisationS(flat, 300)).toBe(0)
      const bump = [...Array(300).fill(1), ...Array(20).fill(1), ...Array(40).fill(9), ...Array(60).fill(1)]
      // over from second 321 to 360, back under at second 361: 61 s after the accident at 300 s
      expect(normalisationS(bump, 300)).toBe(61)
      const stuck = [...Array(300).fill(1), ...Array(100).fill(9)]
      expect(normalisationS(stuck, 300)).toBeNull()
      // saturation (AD-030 on the grid): every segment but the accident's, peak flow over end-of-run capacity, the highest
      expect(Object.keys(t.altFlowMax)).not.toContain('I12>I13')
      expect(Object.keys(t.altFlowMax).length).toBeGreaterThan(5)
      const learned = Object.keys(t.altFlowMax).filter((id) => t.altCapacity[id])
      expect(learned.length).toBeGreaterThan(0)
      const expectedSat = Math.max(...learned.map((id) => (100 * t.altFlowMax[id]) / (t.altCapacity[id] as number)))
      expect(r.saturacaoAlternativaPct).toBeCloseTo(expectedSat, 9)
      expect(r.saturacaoAlternativaPct).toBeGreaterThan(0)
      // measured with no diversion too
      expect(runScenario('sem-sistema', 3).saturacaoAlternativaPct).toBeGreaterThan(0)
    })
  })

  describe('parameters', () => {
    it('runs every scenario with the chosen accident duration and demand', { timeout: 120_000 }, () => {
      // addBlockage without a duration keeps 2 min; with one, it lasts that long
      const e = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      expect(e.addBlockage('I12>I13', 70).endsAtMs).toBe(120_000)
      expect(e.addBlockage('I22>I23', 30, 300_000).endsAtMs).toBe(300_000)

      const base = runScenario('sem-sistema', 7)
      expect(base.trace.demanda).toBe(75)
      for (const s of SCENARIOS) {
        const r = runScenario(s, 7, { acidenteMin: 5, demanda: 90 })
        expect(r.trace.blockages).toMatchObject([
          { segmentId: 'I12>I13', ativo: true, ts: 300_000 },
          { segmentId: 'I12>I13', ativo: false, ts: 600_000 },
        ])
        expect(r.trace.demanda).toBe(90)
        // 90 cars/min over 15 min: about 1 350, clearly more than at 75 cars/min
        expect(r.trace.spawned as number).toBeGreaterThan((base.trace.spawned as number) + 40)
      }
    })

    it('passes the chosen parameters from the experiment to every run', { timeout: 120_000 }, async () => {
      const { results } = await runExperiment({ repeticoes: 1, acidenteMin: 5, demanda: 90 })
      expect(results.map((r) => r.cenario)).toEqual([...SCENARIOS])
      for (const r of results) {
        const { trace: _t, ...expected } = runScenario(r.cenario, seedFor(1), { acidenteMin: 5, demanda: 90 })
        void _t
        expect(r.metrics).toEqual(expected)
        // and not what the defaults would give
        const { trace: _d, ...defaults } = runScenario(r.cenario, seedFor(1))
        void _d
        expect(r.metrics).not.toEqual(defaults)
      }
    })
  })

  describe('csv', () => {
    it('writes one row per run then mean and deviation rows in the pt-BR format', () => {
      const run = (over: Partial<RunMetrics>): RunMetrics => ({
        tempoMedioViagemS: 100,
        co2TotalKg: 10,
        co2GKm: 150,
        tempoParadoMedioS: 20,
        filaMaxima: 12,
        tempoNormalizarS: 60,
        saturacaoAlternativaPct: 80,
        desviadosPct: 5,
        ...over,
      })
      const results = [
        { cenario: 'sem-sistema', repeticao: 1, semente: 11, metrics: run({ tempoMedioViagemS: 100.5 }) },
        { cenario: 'sem-sistema', repeticao: 2, semente: 12, metrics: run({ tempoMedioViagemS: 110.5, tempoNormalizarS: null }) },
      ]
      const csv = toCsv(results, { acidenteMin: 5, demanda: 18 })
      expect(csv.startsWith('﻿')).toBe(true)
      const lines = csv.slice(1).trimEnd().split('\r\n')
      expect(lines[0]).toBe(CSV_HEADER)
      expect(CSV_HEADER).toBe(
        'cenario;repeticao;semente;tempo_medio_viagem_s;co2_total_kg;co2_g_km;tempo_parado_medio_s;fila_maxima;tempo_normalizar_s;saturacao_alternativa_pct;desviados_pct;acidente_min;demanda_carros_min;fracao_desvio',
      )
      expect(lines[1]).toBe('sem-sistema;1;11;100,5;10;150;20;12;60;80;5;5;18;')
      expect(lines[2]).toBe('sem-sistema;2;12;110,5;10;150;20;12;;80;5;5;18;')
      expect(lines[3]).toBe('sem-sistema;media;;105,5;10;150;20;12;60;80;5;5;18;')
      // sample standard deviation: sqrt(((100.5-105.5)^2 + (110.5-105.5)^2) / 1) = 7.0711
      expect(lines[4].split(';')[3]).toBe('7,0711')
      expect(lines[4].startsWith('sem-sistema;desvio_padrao;;')).toBe(true)
      expect(lines[4].endsWith(';5;18;')).toBe(true)
      expect(lines[4].split(';')).toHaveLength(14)
      expect(lines).toHaveLength(5)
      const summary = summarise(results)
      expect(summary['sem-sistema'].tempoMedioViagemS.media).toBeCloseTo(105.5, 9)
      expect(summary['sem-sistema'].tempoMedioViagemS.desvio).toBeCloseTo(Math.sqrt(50), 9)
      expect(summary['sem-sistema'].tempoNormalizarS.media).toBe(60) // nulls left out
    })
  })
})
