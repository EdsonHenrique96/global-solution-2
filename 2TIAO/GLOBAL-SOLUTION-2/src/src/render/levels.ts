import { STALE_AFTER_MS, type Estimate } from '../capacity/CapacityModel'
import { nivelOf, ruleClassifier, type Nivel, type SegmentClassifier } from '../capacity/SegmentClassifier'
import type { FusedSegment } from '../fusion/FusionService'
import type { Segment } from '../sensors/segments'
import { ALAMEDAS, RUAS } from '../sim/cityNetwork'

export { nivelOf, type Nivel }

export const NIVEIS: Record<Nivel, { label: string; color: string; bg: string; range?: string }> = {
  livre: { label: 'Livre', color: '#3DBE7A', bg: 'rgba(61,190,122,0.14)', range: '< 50%' },
  moderado: { label: 'Moderado', color: '#F5D04E', bg: 'rgba(245,208,78,0.14)', range: '50–74%' },
  intenso: { label: 'Intenso', color: '#F59544', bg: 'rgba(245,149,68,0.16)', range: '75–89%' },
  critico: { label: 'Crítico', color: '#F0565B', bg: 'rgba(240,86,91,0.16)', range: '≥ 90%' },
  aprendendo: { label: 'Aprendendo', color: '#8A96A8', bg: 'rgba(138,150,168,0.14)' },
  'sem dado': { label: 'Sem dado', color: '#5B6676', bg: 'rgba(91,102,118,0.16)' },
}

/** Worst first: the order a street picks its segment by, and the order of the legend. */
export const NIVEL_ORDER: readonly Nivel[] = ['critico', 'intenso', 'moderado', 'livre', 'aprendendo', 'sem dado']

/** The colour every lane takes with the density layer off. */
export const NEUTRAL_LANE = '#3A4656'

/** What one segment shows on the map, in the label and in the ranking. */
export interface SegmentReading {
  id: string
  nivel: Nivel
  /** Flow over learned capacity, %; null while learning or without data. */
  pct: number | null
  /** veh/h */
  fluxo: number | null
  capacidade: number | null
  velocidade: number | null
  /** Cars inside the segment now (entered minus left). */
  contagem: number | null
  /** veh/km */
  densidade: number | null
  /** Plate pairs closed in the last minute. */
  pares: number | null
  /** When the speed is a held last-pair speed (AD-098), that pair's time; else null. */
  ultimoParEm: number | null
}

/**
 * A segment's level from its estimate and fused view: "sem dado" after 20 s without metrics, else
 * the classifier's level (AD-082) - the one the map, the ranking, the tooltip, the selected road
 * and the diversion all use.
 */
export function readSegment(
  id: string,
  estimate: Estimate | undefined,
  fused: FusedSegment | undefined,
  nowMs: number,
  classifier: SegmentClassifier = ruleClassifier,
): SegmentReading {
  const stale = !fused || fused.atualizadoEm === null || nowMs - fused.atualizadoEm > STALE_AFTER_MS
  const velocidade = stale ? null : (fused?.velocidadeMedia ?? null)
  const contagem = stale ? null : (fused?.contagem ?? null)
  const densidade = stale ? null : (fused?.densidade ?? null)
  const pares = stale ? null : (fused?.pares ?? null)
  const ultimoParEm = stale ? null : (fused?.velocidadeUltimoParEm ?? null)
  const fluxo = stale || !estimate ? null : estimate.fluxo
  const capacidade = estimate?.capacidade ?? null
  const base = { id, fluxo, capacidade, velocidade, contagem, densidade, pares, ultimoParEm }
  if (stale) return { ...base, nivel: 'sem dado', pct: null }
  const nivel = classifier.classify({ fluxo, capacidade, velocidade, densidade })
  const pct = capacidade === null || capacidade <= 0 || fluxo === null ? null : Math.round((fluxo / capacidade) * 100)
  return { ...base, nivel, pct }
}

/** veh/h -> cars per minute, rounded. */
export const perMin = (vehH: number) => Math.round(vehH / 60)

/** Most saturated first: by level (critico first), then by the highest pct. */
export function compareSaturation(a: SegmentReading, b: SegmentReading): number {
  return NIVEL_ORDER.indexOf(a.nivel) - NIVEL_ORDER.indexOf(b.nivel) || (b.pct ?? -1) - (a.pct ?? -1) || a.id.localeCompare(b.id)
}

/** The 8 streets of the grid, alamedas then ruas. */
export const STREETS: readonly string[] = [...ALAMEDAS, ...RUAS]

export interface StreetRow {
  rua: string
  /** The segment the street's label shows and a click selects (AC 14). */
  worst: SegmentReading
  /** The street's highest flow over learned capacity, %; null when no segment of it has learned one. */
  pct: number | null
}

/** Each street with its most saturated segment (AD-048) and its highest learned pct. */
export function streetRows(segments: readonly Segment[], readings: Record<string, SegmentReading>): StreetRow[] {
  return STREETS.map((rua) => {
    const own = segments.filter((s) => s.rua === rua).map((s) => readings[s.id])
    const pcts = own.map((r) => r.pct).filter((p): p is number => p !== null)
    return { rua, worst: [...own].sort(compareSaturation)[0], pct: pcts.length ? Math.max(...pcts) : null }
  })
}

/**
 * "Vias mais saturadas": by the street's highest learned pct, highest first; a street with no
 * learned capacity goes last (AC 46), even when its worst segment is a slow one still learning.
 */
export function rankStreets(rows: readonly StreetRow[]): StreetRow[] {
  return [...rows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || compareSaturation(a.worst, b.worst))
}

/** The two lines of a street label (AC 13, AC 15). */
export function labelLines(r: SegmentReading): { atual: string; suporta: string; media: string } {
  return {
    atual: r.fluxo === null ? '—' : String(perMin(r.fluxo)),
    suporta: r.capacidade === null ? 'aprendendo' : `${perMin(r.capacidade)} carros/min`,
    media: r.velocidade === null ? '—' : String(Math.round(r.velocidade)),
  }
}

export const ONLINE_MS = 20_000

/** A camera is online up to 20 s after its last status (AD-054). */
export function unitOnline(lastReadingMs: number | undefined, nowMs: number): boolean {
  return lastReadingMs !== undefined && nowMs - lastReadingMs <= ONLINE_MS
}

const minutes = (ms: number) => Math.floor(ms / 60_000)

/** "Câmeras online": count and the camera silent the longest. */
export function camerasCard(unitIds: readonly string[], lastReading: Record<string, number>, nowMs: number): { value: string; note: string } {
  const offline = unitIds.filter((id) => !unitOnline(lastReading[id], nowMs))
  const value = `${unitIds.length - offline.length} / ${unitIds.length}`
  if (offline.length === 0) return { value, note: 'todas enviando leitura' }
  // never read counts as silent since the start of the run
  const silent = [...offline].sort((a, b) => (lastReading[a] ?? -Infinity) - (lastReading[b] ?? -Infinity) || a.localeCompare(b))[0]
  const since = lastReading[silent] ?? 0
  return { value, note: `${silent} sem sinal há ${minutes(nowMs - since)} min` }
}

/** "Incidentes ativos". */
export function incidentsCard(levels: readonly ('critico' | 'moderado')[]): { value: number; note: string } {
  const crit = levels.filter((l) => l === 'critico').length
  const mod = levels.length - crit
  if (levels.length === 0) return { value: 0, note: 'nenhum crítico' }
  return { value: levels.length, note: `${crit} crítico · ${mod} ${mod === 1 ? 'moderado' : 'moderados'}` }
}

/** "Semáforos operando". */
export function signalsCard(flashing: number, total: number): { value: string; note: string } {
  return { value: `${total - flashing} / ${total}`, note: flashing === 0 ? 'todos em ciclo normal' : `${flashing} em modo intermitente` }
}

/** "Fluxo total": cars per minute over the segments with a reading. */
export function totalFlowPerMin(readings: readonly SegmentReading[]): number {
  return perMin(readings.reduce((sum, r) => sum + (r.nivel === 'sem dado' || r.fluxo === null ? 0 : r.fluxo), 0))
}

/** "Ocupação média da rede" over the learned segments, or null while none has learned. */
export function networkOccupancy(readings: readonly SegmentReading[]): { pct: number; flow: number; cap: number } | null {
  const learned = readings.filter((r) => r.pct !== null)
  const cap = learned.reduce((sum, r) => sum + r.capacidade!, 0)
  if (learned.length === 0 || cap <= 0) return null
  const flow = learned.reduce((sum, r) => sum + r.fluxo!, 0)
  return { pct: Math.round((flow / cap) * 100), flow: perMin(flow), cap: perMin(cap) }
}

/** Mean speed of the segments with a speed, weighted by the camera count (at least 1). */
export function averageSpeed(readings: readonly SegmentReading[]): number | null {
  const withSpeed = readings.filter((r) => r.velocidade !== null)
  if (withSpeed.length === 0) return null
  const w = (r: SegmentReading) => Math.max(1, r.contagem ?? 1)
  return withSpeed.reduce((sum, r) => sum + r.velocidade! * w(r), 0) / withSpeed.reduce((sum, r) => sum + w(r), 0)
}

/** A sample of the network an hour back, or null with less than an hour of history. */
export function hourAgo<T extends { t: number }>(samples: readonly T[], nowMs: number): T | null {
  if (samples.length === 0 || nowMs - samples[0].t < 3_600_000) return null
  let best = samples[0]
  for (const s of samples) if (s.t <= nowMs - 3_600_000) best = s
  return best
}

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '±0')

/** "<±N> <unit> vs. 1 h atrás", or "sem histórico de 1 h". */
export function versusHourAgo(now: number | null, before: number | null | undefined, unit: string): string {
  if (before === null || before === undefined || now === null) return 'sem histórico de 1 h'
  return `${signed(Math.round(now) - Math.round(before))} ${unit} vs. 1 h atrás`
}
