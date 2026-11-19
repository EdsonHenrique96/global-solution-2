import type { Segment } from '../sensors/segments'
import type { TelemetryTransport } from '../telemetry/transport'
import { ALERTS_TOPIC } from './AlertPublisher'
import { agedConfidence, FRESH_MS } from './confidence'
import { ANOMALY_FILTER, METRICS_FILTER } from './PlateMatcher'
import { APPS_TOPIC } from '../apps/AppFleet'

/**
 * Without a pair in the last minute, the last pair speed is shown for up to 5 min, and dropped at
 * once when "Possível incidente" opens (AD-099). Before a segment's first pair there is no speed.
 */
export const SPEED_HOLD_MS = 300_000

export const ALERT_MERGE_M = 50
export const ALERT_MERGE_MS = 60_000
/** How close to a segment's polyline an alert must be to belong to it. */
export const ALERT_ATTACH_M = 15

export interface FusedAlert {
  ids: number[]
  tipo: string
  x: number
  y: number
  ts: number
  /** Every report merged into this alert. */
  membros: { id: number; x: number; y: number; ts: number }[]
}

/** The fused view of one road segment (spec item 4). */
export interface FusedSegment {
  /** Cars inside the segment now: entered minus left (RF12). */
  contagem: number | null
  /** veh/km */
  densidade: number | null
  /** Space mean speed of the last minute's plate pairs, km/h; without a pair, the last measured one up to 5 min old; else null. */
  velocidadeMedia: number | null
  /** When `velocidadeMedia` is a held last-pair speed, the time of that pair; null when measured now. */
  velocidadeUltimoParEm: number | null
  /** Exits in the last minute. */
  fluxoVeicMin: number | null
  /** Plate pairs closed in the last minute. */
  pares: number | null
  /** "Possível incidente": most cars that entered did not leave in time (AD-091); never a level. */
  possivelIncidente: boolean
  alertas: FusedAlert[]
  /** Demand from the drivers with a map app, scaled to all drivers, veh/h; null when unknown (AD-038). */
  demandaOD: number | null
  /** The camera pair behind the current values; empty when estimated. */
  fontes: string[]
  confianca: number
  atualizadoEm: number | null
  estimado: boolean
}

/** One segment's metrics, as the capacity model learns from them. */
export interface ChosenMeasurement {
  segmentId: string
  ts: number
  densidadeVeicKm: number
  velocidadeMediaKmh: number | null
  fluxoVeicMin: number
}

interface Metrics {
  ts: number
  ocupacao: number
  densidadeVeicKm: number
  velocidadeMediaKmh: number | null
  fluxoVeicMin: number
  pares: number
  camerasPar: string[]
}

function distanceToPolyline(x: number, y: number, points: Segment['points']): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2))
    best = Math.min(best, Math.hypot(a.x + dx * t - x, a.y + dy * t - y))
  }
  return best
}

/**
 * Fuses, per road segment, what arrives on the broker: the plate matcher's metrics (door 2),
 * operator alerts (deduplicated) and the demand the map apps report. It only ever sees aggregate
 * messages - never the simulation, individual cars or plate hashes (LGPD).
 */
export class FusionService {
  private readonly transport: TelemetryTransport
  private readonly now: () => number
  private readonly segments: readonly Segment[]
  private readonly latest = new Map<string, Metrics>()
  /** Metrics not yet handed to the capacity model. */
  private pending: ChosenMeasurement[] = []
  private readonly alerts = new Map<string, FusedAlert[]>()
  private readonly demand = new Map<string, number | null>()
  private readonly anomalies = new Map<string, { ts: number; ativo: boolean }>()
  /** Each segment's last measured pair speed: a sparse segment still shows one (AC 24). */
  private readonly lastSpeed = new Map<string, { v: number; ts: number }>()
  private offs: (() => void)[] = []

  constructor(transport: TelemetryTransport, now: () => number, segments: readonly Segment[]) {
    this.transport = transport
    this.now = now
    this.segments = segments
  }

  start(): void {
    if (this.offs.length) return
    this.offs = [
      this.transport.subscribe(METRICS_FILTER, (_t, p) => this.onMetrics(p)),
      this.transport.subscribe(ANOMALY_FILTER, (_t, p) => this.onAnomaly(p)),
      this.transport.subscribe(ALERTS_TOPIC, (_t, p) => this.onAlert(p)),
      this.transport.subscribe(APPS_TOPIC, (_t, p) => this.onDemand(p)),
    ]
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
  }

  private static parse(payload: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(payload)
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  private onMetrics(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.trecho !== 'string' || !this.segments.some((s) => s.id === msg.trecho)) return
    const { ts, ocupacao, densidadeVeicKm, velocidadeMediaKmh, fluxoVeicMin, pares, camerasPar } = msg
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    if (!num(ts) || !num(ocupacao) || !num(densidadeVeicKm) || !num(fluxoVeicMin) || !num(pares)) return
    if (velocidadeMediaKmh !== null && !num(velocidadeMediaKmh)) return
    if (!Array.isArray(camerasPar) || !camerasPar.every((c) => typeof c === 'string')) return
    // a retained message from an earlier run can carry a time this run has not reached
    if (ts > this.now()) return
    const current = this.latest.get(msg.trecho)
    if (current && ts <= current.ts) return
    this.latest.set(msg.trecho, { ts, ocupacao, densidadeVeicKm, velocidadeMediaKmh, fluxoVeicMin, pares, camerasPar: [...camerasPar] })
    if (velocidadeMediaKmh !== null) this.lastSpeed.set(msg.trecho, { v: velocidadeMediaKmh, ts })
    this.pending.push({ segmentId: msg.trecho, ts, densidadeVeicKm, velocidadeMediaKmh, fluxoVeicMin })
  }

  /** The last pair speed, up to 5 min old and while no warning is open (AD-099), or null. */
  private heldSpeed(segmentId: string, m: Metrics): { v: number; ts: number } | null {
    const last = this.lastSpeed.get(segmentId)
    if (!last || m.ts - last.ts > SPEED_HOLD_MS) return null
    if (this.anomalies.get(segmentId)?.ativo) return null
    return { v: last.v, ts: last.ts }
  }

  private speedOf(segmentId: string, m: Metrics | undefined): { velocidadeMedia: number | null; velocidadeUltimoParEm: number | null } {
    if (!m) return { velocidadeMedia: null, velocidadeUltimoParEm: null }
    if (m.velocidadeMediaKmh !== null) return { velocidadeMedia: m.velocidadeMediaKmh, velocidadeUltimoParEm: null }
    const held = this.heldSpeed(segmentId, m)
    return { velocidadeMedia: held?.v ?? null, velocidadeUltimoParEm: held?.ts ?? null }
  }

  private onAnomaly(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.trecho !== 'string' || !this.segments.some((s) => s.id === msg.trecho)) return
    if (typeof msg.ts !== 'number' || typeof msg.ativo !== 'boolean' || msg.ts > this.now()) return
    const current = this.anomalies.get(msg.trecho)
    if (current && msg.ts < current.ts) return
    this.anomalies.set(msg.trecho, { ts: msg.ts, ativo: msg.ativo })
  }

  private onAlert(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.id !== 'number' || typeof msg.x !== 'number' || typeof msg.y !== 'number') return
    if (typeof msg.ts !== 'number' || typeof msg.tipo !== 'string') return
    const { id, x, y, ts, tipo } = msg as { id: number; x: number; y: number; ts: number; tipo: string }
    if (msg.ativo === false) {
      for (const [segmentId, list] of this.alerts) {
        for (const a of list) {
          a.ids = a.ids.filter((i) => i !== id)
          a.membros = a.membros.filter((m) => m.id !== id)
        }
        this.alerts.set(segmentId, list.filter((a) => a.ids.length > 0))
      }
      return
    }
    const home = this.segments
      .map((s) => ({ s, d: distanceToPolyline(x, y, s.points) }))
      .filter(({ d }) => d <= ALERT_ATTACH_M)
      .sort((a, b) => a.d - b.d)[0]?.s
    if (!home) return
    const list = this.alerts.get(home.id) ?? []
    // the same incident: same type and within 50 m and 60 s of any report already merged
    const twin = list.find(
      (a) =>
        a.tipo === tipo &&
        a.membros.some((m) => Math.hypot(m.x - x, m.y - y) <= ALERT_MERGE_M && Math.abs(m.ts - ts) <= ALERT_MERGE_MS),
    )
    if (twin) {
      if (!twin.ids.includes(id)) {
        twin.ids.push(id)
        twin.membros.push({ id, x, y, ts })
      }
    } else {
      list.push({ ids: [id], tipo, x, y, ts, membros: [{ id, x, y, ts }] })
    }
    this.alerts.set(home.id, list)
  }

  /** Demand per segment from the map apps' aggregate (door 4): only what the apps' drivers reveal. */
  private onDemand(payload: string): void {
    const msg = FusionService.parse(payload)
    const demand = msg?.demandaPorTrecho
    if (!demand || typeof demand !== 'object') return
    for (const s of this.segments) {
      const v = (demand as Record<string, unknown>)[s.id]
      this.demand.set(s.id, typeof v === 'number' && Number.isFinite(v) ? v : null)
    }
  }

  /** Metrics not yet handed to the capacity model, each publication once. */
  flush(): ChosenMeasurement[] {
    const out = this.pending
    this.pending = []
    return out
  }

  state(): Record<string, FusedSegment> {
    const now = this.now()
    return Object.fromEntries(
      this.segments.map((s): [string, FusedSegment] => {
        const m = this.latest.get(s.id)
        const fresh = m !== undefined && now - m.ts <= FRESH_MS
        return [
          s.id,
          {
            contagem: m ? m.ocupacao : null,
            densidade: m ? m.densidadeVeicKm : null,
            ...this.speedOf(s.id, m),
            fluxoVeicMin: m ? m.fluxoVeicMin : null,
            pares: m ? m.pares : null,
            possivelIncidente: this.anomalies.get(s.id)?.ativo ?? false,
            alertas: (this.alerts.get(s.id) ?? []).map((a) => ({ ...a, ids: [...a.ids], membros: a.membros.map((x) => ({ ...x })) })),
            demandaOD: this.demand.get(s.id) ?? null,
            fontes: fresh ? [...m.camerasPar] : [],
            confianca: m ? agedConfidence(1, now - m.ts) : 0,
            atualizadoEm: m ? m.ts : null,
            estimado: m !== undefined && !fresh,
          },
        ]
      }),
    )
  }
}
