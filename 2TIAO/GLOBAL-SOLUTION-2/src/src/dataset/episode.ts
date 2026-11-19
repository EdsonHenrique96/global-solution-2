import { Simulation } from '../decision/Simulation'
import { monitoredSegments } from '../fusion/PlateMatcher'
import { clockAt, type ClockTime } from '../sim/clock'
import { mulberry32 } from '../sim/random'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { demandaPorHora } from './demand'

/** 45 simulated minutes per episode. */
export const EPISODE_MS = 45 * 60_000
export const ROW_EVERY_MS = 10_000
/** Accidents start between 5 and 35 min into the episode and last 2 or 5 min (AD-016). */
export const ACCIDENT_START_MIN = { min: 5, max: 35 } as const
export const ACCIDENT_MINUTES = [2, 5] as const

/** Door 3, literally. */
export const DATASET_HEADER =
  'episodio;semente;dia_semana;hora_min;t_s;trecho;velocidade_kmh;fluxo_veic_min;densidade_veic_km;ocupacao;acidente'

/** One CSV row (door 3): a paired segment's reading at one 10 s mark of an episode. */
export interface MetricRow {
  episodio: number
  semente: number
  dia_semana: number
  hora_min: number
  t_s: number
  trecho: string
  velocidade_kmh: number | null
  fluxo_veic_min: number | null
  densidade_veic_km: number | null
  ocupacao: number | null
  acidente: 0 | 1
}

/** What an episode is: its seed, when it starts and the accident it has, if any. */
export interface Episode {
  episodio: number
  semente: number
  inicio: ClockTime
  acidente: { trecho: string; startMs: number; durationMs: number } | null
}

/** The engine seed of one episode of a dataset seed. */
export const episodeSeed = (semente: number, episodio: number) => semente * 100_003 + episodio

/**
 * Draws an episode from the dataset seed: day and minute of the week it starts at and, in every
 * episode with an odd index (half of them), an accident in the middle of a paired segment.
 */
export function drawEpisode(semente: number, episodio: number, paired: readonly string[]): Episode {
  const seed = episodeSeed(semente, episodio)
  const rng = mulberry32(seed * 2_654_435 + 17)
  const inicio = { diaSemana: Math.floor(rng() * 7), horaMin: Math.floor(rng() * 1440) }
  const acidente =
    episodio % 2 === 1
      ? {
          trecho: paired[Math.floor(rng() * paired.length)],
          startMs: (ACCIDENT_START_MIN.min + Math.floor(rng() * (ACCIDENT_START_MIN.max - ACCIDENT_START_MIN.min + 1))) * 60_000,
          durationMs: ACCIDENT_MINUTES[Math.floor(rng() * ACCIDENT_MINUTES.length)] * 60_000,
        }
      : null
  return { episodio, semente: seed, inicio, acidente }
}

export interface EpisodeHooks {
  /** Called after every tick (tests read the engine here). */
  onTick?: (sim: Simulation) => void
}

/**
 * Runs one headless episode: the demand follows the curve of the episode's clock, minute by
 * minute; the diversion is off (the data shows the network on its own). Every 10 s, each paired
 * segment's reading - the plate matcher's metrics as the panel reads them - becomes a row.
 */
export function runEpisode(semente: number, episodio: number, hooks: EpisodeHooks = {}): MetricRow[] {
  const probe = new SimulationEngine({ ratePerMinute: 0 })
  const paired = monitoredSegments(probe.getState().cameras).map((m) => m.trecho)
  const ep = drawEpisode(semente, episodio, paired)
  const rateAt = (ms: number) => {
    const c = clockAt(ms, ep.inicio)
    return demandaPorHora(c.diaSemana, c.horaMin)
  }
  const engine = new SimulationEngine({ ratePerMinute: rateAt(0), seed: ep.semente, arrivals: 'poisson' })
  const sim = new Simulation({ engine, transport: new FakeTransport(true) })
  sim.setDiversionEnabled(false)
  sim.start()
  const rows: MetricRow[] = []
  while (engine.getState().timeMs < EPISODE_MS) {
    const now = engine.getState().timeMs
    if (now % 60_000 === 0) engine.setRate(rateAt(now))
    sim.tick()
    hooks.onTick?.(sim)
    const t = engine.getState().timeMs
    // the accident starts at its instant, so the row of that instant already has it
    if (ep.acidente && t === ep.acidente.startMs) {
      const s = engine.segment(ep.acidente.trecho)!
      engine.addBlockage(ep.acidente.trecho, s.length / 2, ep.acidente.durationMs)
    }
    if (t % ROW_EVERY_MS !== 0) continue
    const readings = sim.readings()
    const c = clockAt(t, ep.inicio)
    const acidente = engine.getState().blockages.length > 0 ? 1 : 0
    for (const trecho of paired) {
      const r = readings[trecho]
      rows.push({
        episodio,
        semente: ep.semente,
        dia_semana: c.diaSemana,
        hora_min: c.horaMin,
        t_s: t / 1000,
        trecho,
        velocidade_kmh: r.velocidade,
        fluxo_veic_min: r.fluxo === null ? null : r.fluxo / 60,
        densidade_veic_km: r.densidade,
        ocupacao: r.contagem,
        acidente,
      })
    }
  }
  sim.stop()
  return rows
}

/** A number with at most 4 decimals and a dot; null -> empty. */
const num = (v: number | null) => (v === null || !Number.isFinite(v) ? '' : String(Number(v.toFixed(4))))

/** The rows as CSV lines (no header), `\n` after each. */
export function rowsToCsv(rows: readonly MetricRow[]): string {
  let out = ''
  for (const r of rows) {
    out += `${r.episodio};${r.semente};${r.dia_semana};${r.hora_min};${r.t_s};${r.trecho};${num(r.velocidade_kmh)};${num(r.fluxo_veic_min)};${num(r.densidade_veic_km)};${num(r.ocupacao)};${r.acidente}\n`
  }
  return out
}
