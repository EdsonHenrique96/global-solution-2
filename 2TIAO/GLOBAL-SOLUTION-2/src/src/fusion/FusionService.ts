import type { Segment } from '../sensors/segments'
import { TELEMETRY_FILTER } from '../telemetry/TelemetryPublisher'
import type { TelemetryTransport } from '../telemetry/transport'
import { ALERTS_TOPIC } from './AlertPublisher'
import { agedConfidence, baseConfidence, FRESH_MS } from './confidence'
import { OD_TOPIC } from './OdAggregator'

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
}

/** The fused view of one road segment (spec item 4). */
export interface FusedSegment {
  densidade: number | null
  velocidadeMedia: number | null
  alertas: FusedAlert[]
  /** Demand from the OD matrix, veh/h; null when unknown. */
  demandaOD: number | null
  /** Sensors behind the current values; empty when estimated. */
  fontes: string[]
  confianca: number
  atualizadoEm: number | null
  estimado: boolean
}

/** One sensor measurement the fusion picked for a segment and window. */
export interface ChosenMeasurement {
  segmentId: string
  ts: number
  contagem: number
  velocidadeMediaKmh: number | null
  comprimentoCobertoM: number
  cobertura: number
}

interface Reading {
  sensorId: string
  contagem: number
  velocidadeMediaKmh: number | null
  comprimentoCobertoM: number
  cobertura: number
}

interface SegmentWindow {
  ts: number
  best: Reading
  sources: Set<string>
  delivered: boolean
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
 * Fuses, per road segment, what arrives on the broker: sensor readings (highest coverage wins
 * within a window), operator alerts (deduplicated) and aggregated OD demand. It only ever sees
 * aggregate messages - never the simulation or individual cars (LGPD).
 */
export class FusionService {
  private readonly transport: TelemetryTransport
  private readonly now: () => number
  private readonly segments: readonly Segment[]
  private readonly windows = new Map<string, SegmentWindow>()
  /** Windows replaced by a newer one before they were handed to the capacity model. */
  private pending: ChosenMeasurement[] = []
  private readonly alerts = new Map<string, FusedAlert[]>()
  private readonly demand = new Map<string, number | null>()
  private offs: (() => void)[] = []

  constructor(transport: TelemetryTransport, now: () => number, segments: readonly Segment[]) {
    this.transport = transport
    this.now = now
    this.segments = segments
  }

  start(): void {
    if (this.offs.length) return
    this.offs = [
      this.transport.subscribe(TELEMETRY_FILTER, (_t, p) => this.onReading(p)),
      this.transport.subscribe(ALERTS_TOPIC, (_t, p) => this.onAlert(p)),
      this.transport.subscribe(OD_TOPIC, (_t, p) => this.onDemand(p)),
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

  private onReading(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.ts !== 'number' || typeof msg.sensorId !== 'string' || !Array.isArray(msg.porTrecho)) return
    for (const entry of msg.porTrecho as Record<string, unknown>[]) {
      const { trecho, contagem, velocidadeMediaKmh, comprimentoCobertoM, cobertura } = entry ?? {}
      if (typeof trecho !== 'string' || !this.segments.some((s) => s.id === trecho)) continue
      if (typeof contagem !== 'number' || typeof comprimentoCobertoM !== 'number' || typeof cobertura !== 'number') continue
      if (velocidadeMediaKmh !== null && typeof velocidadeMediaKmh !== 'number') continue
      const reading: Reading = { sensorId: msg.sensorId, contagem, velocidadeMediaKmh, comprimentoCobertoM, cobertura }
      const w = this.windows.get(trecho)
      if (!w || msg.ts > w.ts) {
        if (w && !w.delivered) this.pending.push({ segmentId: trecho, ts: w.ts, ...w.best })
        this.windows.set(trecho, { ts: msg.ts, best: reading, sources: new Set([msg.sensorId]), delivered: false })
      } else if (msg.ts === w.ts) {
        w.sources.add(msg.sensorId)
        if (reading.cobertura > w.best.cobertura) w.best = reading
      }
    }
  }

  private onAlert(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.id !== 'number' || typeof msg.x !== 'number' || typeof msg.y !== 'number') return
    if (typeof msg.ts !== 'number' || typeof msg.tipo !== 'string') return
    const { id, x, y, ts, tipo } = msg as { id: number; x: number; y: number; ts: number; tipo: string }
    if (msg.ativo === false) {
      for (const [segmentId, list] of this.alerts) {
        for (const a of list) a.ids = a.ids.filter((i) => i !== id)
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
    const twin = list.find(
      (a) => a.tipo === tipo && Math.hypot(a.x - x, a.y - y) <= ALERT_MERGE_M && Math.abs(a.ts - ts) <= ALERT_MERGE_MS,
    )
    if (twin) {
      if (!twin.ids.includes(id)) twin.ids.push(id)
    } else {
      list.push({ ids: [id], tipo, x, y, ts })
    }
    this.alerts.set(home.id, list)
  }

  private onDemand(payload: string): void {
    const msg = FusionService.parse(payload)
    if (!msg || typeof msg.janelaS !== 'number' || msg.janelaS <= 0 || !Array.isArray(msg.celulas)) return
    const perHour = 3600 / msg.janelaS
    const trips = (msg.celulas as Record<string, unknown>[])
      .filter((c) => c && typeof c.viagens === 'number' && c.origem === 'oeste' && c.destino === 'leste')
      .reduce((n, c) => n + (c.viagens as number), 0)
    const valid = (msg.celulas as unknown[]).length > 0 && trips > 0
    const routes = [...new Set(this.segments.flatMap((s) => s.routeIds))]
    for (const s of this.segments) {
      // trips spread evenly over the routes (round-robin); a shared segment carries all of them
      this.demand.set(s.id, valid ? (trips * perHour * s.routeIds.length) / routes.length : null)
    }
  }

  /** Measurements not yet handed to the capacity model: one per segment and window. */
  flush(): ChosenMeasurement[] {
    const out: ChosenMeasurement[] = this.pending
    this.pending = []
    for (const [segmentId, w] of this.windows) {
      if (w.delivered) continue
      w.delivered = true
      out.push({ segmentId, ts: w.ts, ...w.best })
    }
    return out
  }

  state(): Record<string, FusedSegment> {
    const now = this.now()
    return Object.fromEntries(
      this.segments.map((s): [string, FusedSegment] => {
        const w = this.windows.get(s.id)
        const fresh = w !== undefined && now - w.ts <= FRESH_MS
        return [
          s.id,
          {
            densidade: w ? w.best.contagem / ((w.best.comprimentoCobertoM / 1000) * s.lanes) : null,
            velocidadeMedia: w ? w.best.velocidadeMediaKmh : null,
            alertas: (this.alerts.get(s.id) ?? []).map((a) => ({ ...a, ids: [...a.ids] })),
            demandaOD: this.demand.get(s.id) ?? null,
            fontes: fresh ? [...w.sources].sort() : [],
            confianca: w ? agedConfidence(baseConfidence(w.best.cobertura), now - w.ts) : 0,
            atualizadoEm: w ? w.ts : null,
            estimado: w !== undefined && !fresh,
          },
        ]
      }),
    )
  }
}
