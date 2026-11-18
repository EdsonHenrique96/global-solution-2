import { describe, expect, it } from 'vitest'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { emissionFactor, IDLE_G_PER_S } from './emission'
import { CSV_HEADER, summarise, toCsv } from './csv'
import { runScenario, SCENARIOS, type RunMetrics } from './ExperimentRunner'

const FREE_MS = 50 / 3.6

function runFor(engine: SimulationEngine, ms: number) {
  const end = engine.getState().timeMs + ms
  while (engine.getState().timeMs < end) engine.tick(TICK_MS)
}

describe('experiments', () => {
  describe('emission', () => {
    it('adds moving emission by speed factor and idle emission per second', () => {
      expect(emissionFactor(10)).toBeGreaterThan(emissionFactor(30))
      expect(emissionFactor(30)).toBeGreaterThan(emissionFactor(50))
      // minimum near 70 km/h
      expect(emissionFactor(70)).toBeLessThan(emissionFactor(60))
      expect(emissionFactor(70)).toBeLessThan(emissionFactor(80))
      expect(emissionFactor(70)).toBeCloseTo(140, 0)
      expect(IDLE_G_PER_S).toBe(0.6)

      // 1 km at a constant 50 km/h on a free road (the north route is 1 073 m long): factor(50) grams
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green', cameras: [] })
      const id = engine.addCar('norte', 0).id
      const kmTicks = Math.round(1000 / (FREE_MS * 0.1))
      for (let i = 0; i < kmTicks; i++) engine.tick(TICK_MS)
      const car = engine.getState().cars.find((c) => c.id === id)!
      expect(car.traveledM).toBeCloseTo(kmTicks * FREE_MS * 0.1, 6)
      expect(car.co2G).toBeCloseTo((emissionFactor(50) * car.traveledM) / 1000, 3)

      // 60 s stopped: 36 g
      const idle = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green', cameras: [] })
      idle.addBlockage('central', 300)
      const s = idle.addCar('central', 290, 0).id // already against the blockage
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
      runFor(engine, 23_000) // I1 is red from 23 s to 43 s: the car reaches its line at ~39 s
      const id = engine.addCar('central', 0).id
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
      // the whole central route (880 m), give or take the last step past its end (< 1.4 m)
      expect(a.distanciaM).toBeGreaterThanOrEqual(880)
      expect(a.distanciaM).toBeLessThan(880 + FREE_MS * 0.1)
      expect(a.co2G).toBeGreaterThanOrEqual(last.co2G)
      expect(a.paradoS).toBeGreaterThanOrEqual(last.stoppedS)
      // it stood at I1's red: stopped time and the idle part of its CO2 are in the arrival
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
    it('runs the three scenarios with the same accident and seed', { timeout: 120_000 }, () => {
      expect(SCENARIOS).toEqual(['sem-sistema', 'notificar-todos', 'desvio-parcial'])
      const runs = Object.fromEntries(SCENARIOS.map((s) => [s, runScenario(s, 7)])) as Record<string, RunMetrics & { trace: Record<string, unknown> }>
      for (const s of SCENARIOS) {
        expect(runs[s].trace.seed).toBe(7)
        expect(runs[s].trace.accident).toEqual({ routeId: 'central', distance: 500, startMs: 300_000, durationMs: 120_000 })
        // same seed -> same demand
        expect(runs[s].trace.spawned).toBe(runs['sem-sistema'].trace.spawned)
      }
      expect(runs['sem-sistema'].trace).toMatchObject({ adaptiveSignals: false, diversionEnabled: false })
      expect(runs['sem-sistema'].desviadosPct).toBe(0)
      expect(runs['desvio-parcial'].trace).toMatchObject({ adaptiveSignals: true, diversionEnabled: true, diversionMode: 'parcial' })
      expect(runs['notificar-todos'].trace).toMatchObject({ adaptiveSignals: false, diversionEnabled: true, diversionMode: 'todos' })
      // notify-all sends every car bound for A while the diversion is on: fraction 1
      expect(runs['notificar-todos'].trace.maxFraction).toBe(1)
      expect(runs['desvio-parcial'].trace.maxFraction as number).toBeLessThanOrEqual(0.5)
      // same seed, same run
      expect(runScenario('desvio-parcial', 7)).toEqual(runs['desvio-parcial'])
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
        diverted: number
        altFlowMax: number | null
        altCapacity: number | null
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
      expect(t.arrivals.length).toBeGreaterThan(50)
      expect(r.tempoMedioViagemS).toBeCloseTo(mean(t.arrivals.map((a) => a.travelS)), 9)
      expect(r.co2TotalKg).toBeCloseTo(t.co2TotalG / 1000, 9)
      expect(r.co2GKm).toBeCloseTo(t.co2TotalG / (t.distanceTotalM / 1000), 9)
      expect(r.tempoParadoMedioS).toBeCloseTo(mean(t.arrivals.map((a) => a.paradoS)), 9)
      expect(r.filaMaxima).toBe(Math.max(...t.queueBySecond))
      expect(r.desviadosPct).toBeCloseTo((100 * t.diverted) / t.spawned, 9)
      // normalisation: first second after the accident from which the queue stays at or under the
      // threshold for 30 s
      const before = mean(t.queueBySecond.slice(0, 300))
      const limit = Math.max(1.2 * before, before + 1)
      let expected: number | null = null
      for (let s = 300; s + 30 <= t.queueBySecond.length; s++) {
        if (t.queueBySecond.slice(s, s + 30).every((q) => q <= limit)) {
          expected = s - 300
          break
        }
      }
      expect(r.tempoNormalizarS).toBe(expected)
      if (t.altFlowMax !== null && t.altCapacity) expect(r.saturacaoAlternativaPct).toBeCloseTo((100 * t.altFlowMax) / t.altCapacity, 9)
      else expect(r.saturacaoAlternativaPct).toBeNull()
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
      const csv = toCsv(results)
      expect(csv.startsWith('﻿')).toBe(true)
      const lines = csv.slice(1).trimEnd().split('\r\n')
      expect(lines[0]).toBe(CSV_HEADER)
      expect(CSV_HEADER).toBe(
        'cenario;repeticao;semente;tempo_medio_viagem_s;co2_total_kg;co2_g_km;tempo_parado_medio_s;fila_maxima;tempo_normalizar_s;saturacao_alternativa_pct;desviados_pct',
      )
      expect(lines[1]).toBe('sem-sistema;1;11;100,5;10;150;20;12;60;80;5')
      expect(lines[2]).toBe('sem-sistema;2;12;110,5;10;150;20;12;;80;5')
      expect(lines[3]).toBe('sem-sistema;media;;105,5;10;150;20;12;60;80;5')
      // sample standard deviation: sqrt(((100.5-105.5)^2 + (110.5-105.5)^2) / 1) = 7.0711
      expect(lines[4].split(';')[3]).toBe('7,0711')
      expect(lines[4].startsWith('sem-sistema;desvio_padrao;;')).toBe(true)
      expect(lines).toHaveLength(5)
      const summary = summarise(results)
      expect(summary['sem-sistema'].tempoMedioViagemS.media).toBeCloseTo(105.5, 9)
      expect(summary['sem-sistema'].tempoMedioViagemS.desvio).toBeCloseTo(Math.sqrt(50), 9)
      expect(summary['sem-sistema'].tempoNormalizarS.media).toBe(60) // nulls left out
    })
  })
})
