import { describe, expect, it } from 'vitest'
import { monitoredSegments } from '../fusion/PlateMatcher'
import type { SegmentReading } from '../render/levels'
import { clockAt } from '../sim/clock'
import { SimulationEngine } from '../sim/SimulationEngine'
import { demandaPorHora } from './demand'
import { DATASET_HEADER, drawEpisode, EPISODE_MS, rowsToCsv, runEpisode } from './episode'

const PAIRED = monitoredSegments(new SimulationEngine({ ratePerMinute: 0 }).getState().cameras).map((m) => m.trecho)
const SEG = 1
const SAB = 6
const at = (h: number, m = 0) => h * 60 + m

describe('dataset', () => {
  it('C3 demandaPorHora follows door 4', () => {
    expect(demandaPorHora(SEG, at(8))).toBe(150)
    expect(demandaPorHora(SEG, at(3))).toBe(30)
    expect(demandaPorHora(SEG, at(13))).toBe(75)
    expect(demandaPorHora(SAB, at(8))).toBe(90)
    const transition = demandaPorHora(SEG, at(6, 45))
    expect(transition).toBeGreaterThan(30)
    expect(transition).toBeLessThan(150)
    // linear over the 30 min before the peak
    expect(demandaPorHora(SEG, at(6, 30))).toBe(75)
    expect(demandaPorHora(SEG, at(6, 45))).toBe(112.5)
    expect(demandaPorHora(SEG, at(7))).toBe(150)
    // the evening peak and the weekend factor
    expect(demandaPorHora(SEG, at(18))).toBe(150)
    expect(demandaPorHora(0, at(18))).toBe(90)
    expect(demandaPorHora(0, at(3))).toBe(18)
  })

  it('C4 marks acidente while the engine reports the blockage active', { timeout: 60_000 }, () => {
    // half of the episodes have an accident: the odd ones
    const firstFour = [1, 2, 3, 4].map((e) => drawEpisode(1, e, PAIRED))
    expect(firstFour.map((e) => e.acidente !== null)).toEqual([true, false, true, false])
    const withAccident = firstFour[0]
    expect(PAIRED).toContain(withAccident.acidente!.trecho)

    const events: { ativo: boolean; ts: number }[] = []
    let wired = false
    const rows = runEpisode(1, 1, {
      onTick: (sim) => {
        if (wired) return
        wired = true
        sim.engine.onBlockage((e) => events.push({ ativo: e.ativo, ts: e.ts }))
      },
    })
    // the engine itself said when the blockage started and ended
    expect(events.map((e) => e.ativo)).toEqual([true, false])
    const [from, to] = [events[0].ts, events[1].ts]
    expect(to - from).toBe(withAccident.acidente!.durationMs)
    const ones = rows.filter((r) => r.acidente === 1)
    expect(ones.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.acidente).toBe(r.t_s * 1000 >= from && r.t_s * 1000 < to ? 1 : 0)

    // an episode without an accident is all zeros
    expect(runEpisode(1, 2).every((r) => r.acidente === 0)).toBe(true)
  })

  it('C5 drives the demand by the curve from the drawn day and hour and writes the readings', { timeout: 60_000 }, () => {
    const ep = drawEpisode(7, 4, PAIRED)
    expect(ep.acidente).toBeNull()
    const rates: { t: number; rate: number }[] = []
    const seen = new Map<number, Record<string, SegmentReading>>()
    const rows = runEpisode(7, 4, {
      onTick: (sim) => {
        const t = sim.engine.getState().timeMs
        // the rate set at the start of each minute is the curve at the episode's clock
        if ((t - 100) % 60_000 === 0) rates.push({ t: t - 100, rate: sim.engine.getRate() })
        if (t % 10_000 === 0) seen.set(t, sim.readings())
      },
    })
    expect(rates).toHaveLength(EPISODE_MS / 60_000)
    for (const { t, rate } of rates) {
      const c = clockAt(t, ep.inicio)
      expect(rate).toBe(Math.round(demandaPorHora(c.diaSemana, c.horaMin)))
    }
    // the drawn start: the first row is 10 s into the episode
    expect(rows[0]).toMatchObject({ dia_semana: ep.inicio.diaSemana, hora_min: ep.inicio.horaMin, t_s: 10, semente: ep.semente })
    expect(rows).toHaveLength(270 * PAIRED.length)
    let withSpeed = 0
    for (const r of rows) {
      const reading = seen.get(r.t_s * 1000)![r.trecho]
      const c = clockAt(r.t_s * 1000, ep.inicio)
      expect([r.dia_semana, r.hora_min]).toEqual([c.diaSemana, c.horaMin])
      expect(r.velocidade_kmh).toBe(reading.velocidade)
      expect(r.fluxo_veic_min).toBe(reading.fluxo === null ? null : reading.fluxo / 60)
      expect(r.densidade_veic_km).toBe(reading.densidade)
      expect(r.ocupacao).toBe(reading.contagem)
      if (r.velocidade_kmh !== null) withSpeed += 1
    }
    expect(withSpeed).toBeGreaterThan(rows.length / 2)
    // a null speed is an empty cell
    const csv = DATASET_HEADER + '\n' + rowsToCsv(rows)
    const noSpeed = rows.findIndex((r) => r.velocidade_kmh === null)
    expect(csv.split('\n')[noSpeed + 1].split(';')[6]).toBe('')
    expect(csv.split('\n')[0].split(';')).toHaveLength(11)
  })
})
