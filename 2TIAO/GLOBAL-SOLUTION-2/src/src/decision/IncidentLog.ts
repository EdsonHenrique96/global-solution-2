import type { SimulationState } from '../sim/SimulationEngine'
import type { Previsto } from '../forecast/ForecastClient'
import type { DiversionState } from './DiversionController'

export type IncidentKind = 'colisao' | 'obra' | 'semaforo' | 'congestionamento' | 'possivel-incidente' | 'previsto'

export const INCIDENT_TITLES: Record<IncidentKind, string> = {
  colisao: 'Colisão',
  obra: 'Obra na pista',
  semaforo: 'Semáforo intermitente',
  congestionamento: 'Congestionamento persistente',
  'possivel-incidente': 'Possível incidente',
  previsto: 'Congestionamento previsto',
}

export interface Incident {
  key: string
  kind: IncidentKind
  nivel: 'critico' | 'moderado'
  /** The engine's id of the blockage, work zone or flashing light; null for a jam. */
  refId: number | null
  segmentId: string | null
  intersectionId: string | null
  /** Metres from the segment start (collision). */
  distance: number | null
  startMs: number
  endsAtMs: number | null
  endMs: number | null
  /** "Congestionamento previsto": when the jam is expected, and the forecast occupancy (%). */
  previstoPara?: number
  ocupacaoPrevista?: number
}

const KEEP_HISTORY = 100

/**
 * What needs the operator: the engine's blockages, work zones and flashing corners, the jam a
 * diversion is active on, and each "Possível incidente" warning (to be confirmed, AD-091). `update` diffs them against the last call; whatever disappeared ended then.
 */
export class IncidentLog {
  private readonly open = new Map<string, Incident>()
  private readonly closed: Incident[] = []

  /**
   * `anomalies`: the segments with a "Possível incidente" warning (AD-091); `previstos`: the
   * segments forecast to reach 90% of their capacity (RF16).
   */
  update(state: SimulationState, diversion: DiversionState, anomalies: readonly string[] = [], previstos: readonly Previsto[] = []): void {
    const now = state.timeMs
    const seen = new Map<string, Omit<Incident, 'startMs' | 'endMs'>>()
    for (const b of state.blockages) {
      seen.set(`colisao:${b.id}`, { key: `colisao:${b.id}`, kind: 'colisao', nivel: 'critico', refId: b.id, segmentId: b.segmentId, intersectionId: null, distance: b.distance, endsAtMs: b.endsAtMs })
    }
    for (const z of state.workZones) {
      seen.set(`obra:${z.id}`, { key: `obra:${z.id}`, kind: 'obra', nivel: 'moderado', refId: z.id, segmentId: z.segmentId, intersectionId: null, distance: null, endsAtMs: z.endsAtMs })
    }
    for (const f of state.flashing) {
      seen.set(`semaforo:${f.id}`, { key: `semaforo:${f.id}`, kind: 'semaforo', nivel: 'moderado', refId: f.id, segmentId: null, intersectionId: f.intersectionId, distance: null, endsAtMs: f.endsAtMs })
    }
    if (diversion.status === 'ativo') {
      const key = `congestionamento:${diversion.trecho}`
      seen.set(key, { key, kind: 'congestionamento', nivel: 'moderado', refId: null, segmentId: diversion.trecho, intersectionId: null, distance: null, endsAtMs: null })
    }
    for (const segmentId of anomalies) {
      const key = `possivel-incidente:${segmentId}`
      seen.set(key, { key, kind: 'possivel-incidente', nivel: 'moderado', refId: null, segmentId, intersectionId: null, distance: null, endsAtMs: null })
    }
    for (const p of previstos) {
      const key = `previsto:${p.trecho}`
      seen.set(key, { key, kind: 'previsto', nivel: 'moderado', refId: null, segmentId: p.trecho, intersectionId: null, distance: null, endsAtMs: null, previstoPara: p.previstoPara, ocupacaoPrevista: p.ocupacao15 })
    }
    for (const [key, inc] of this.open) {
      if (seen.has(key)) continue
      this.open.delete(key)
      this.closed.unshift({ ...inc, endMs: now })
      if (this.closed.length > KEEP_HISTORY) this.closed.pop()
    }
    for (const [key, inc] of seen) {
      const known = this.open.get(key)
      this.open.set(key, known ? { ...known, ...inc } : { ...inc, startMs: now, endMs: null })
    }
  }

  /** Critical first, then the newest. */
  active(): Incident[] {
    return [...this.open.values()].sort((a, b) => Number(b.nivel === 'critico') - Number(a.nivel === 'critico') || b.startMs - a.startMs)
  }

  /** Ended incidents, newest first. */
  history(): readonly Incident[] {
    return this.closed
  }
}
