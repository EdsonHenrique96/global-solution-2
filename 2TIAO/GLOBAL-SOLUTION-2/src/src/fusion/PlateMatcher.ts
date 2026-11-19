import { EVENTS_FILTER, type PlateCamera } from '../sensors/PlateCamera'
import type { TelemetryTransport } from '../telemetry/transport'

export const METRICS_FILTER = 'transito/vias/+/metricas'
export const metricsTopic = (trecho: string) => `transito/vias/${trecho}/metricas`

/** The window the metrics cover, and how often they are recomputed (AD-069). */
export const METRICS_WINDOW_MS = 60_000
export const METRICS_EVERY_MS = 10_000
/** An entry with no exit is dropped after this long, with its hash (RNF01). */
export const PENDING_TTL_MS = 600_000

/** One segment's figures over the last minute (door 2): aggregates only, no hash. */
export interface SegmentMetrics {
  trecho: string
  ts: number
  janelaS: 60
  fluxoVeicMin: number
  velocidadeMediaKmh: number | null
  pares: number
  entraram: number
  sairam: number
  ocupacao: number
  densidadeVeicKm: number
  camerasPar: [string, string]
}

/** A segment with a camera pair; its length is the distance between the two cameras' lines. */
export interface MonitoredSegment {
  trecho: string
  comprimentoM: number
  camerasPar: [string, string]
}

/** Every segment with both an entry and an exit camera. */
export function monitoredSegments(cameras: readonly PlateCamera[]): MonitoredSegment[] {
  const out: MonitoredSegment[] = []
  for (const entry of cameras) {
    if (entry.papel !== 'entrada') continue
    const exit = cameras.find((c) => c.trecho === entry.trecho && c.papel === 'saida')
    if (exit) out.push({ trecho: entry.trecho, comprimentoM: exit.linhaM - entry.linhaM, camerasPar: [entry.id, exit.id] })
  }
  return out
}

interface Track {
  segment: MonitoredSegment
  /** PendingEntry: hash -> entry time, only until its exit or PENDING_TTL_MS. */
  pending: Map<string, number>
  /** Closed pairs: exit time and travel time, no hash. */
  pairs: { ts: number; travelMs: number }[]
  exits: number[]
  entraram: number
  sairam: number
}

const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * Pairs each exit with the pending entry of the same plate hash on the same segment, and every
 * 10 simulated seconds publishes each segment's last-minute metrics. It only sees the cameras'
 * events on the broker, and keeps a hash only while its entry waits for an exit.
 */
export class PlateMatcher {
  private readonly transport: TelemetryTransport
  private readonly now: () => number
  private readonly tracks = new Map<string, Track>()
  private nextPublish = METRICS_EVERY_MS
  private off: (() => void) | null = null

  constructor(transport: TelemetryTransport, now: () => number, segments: readonly MonitoredSegment[]) {
    this.transport = transport
    this.now = now
    for (const segment of segments) {
      this.tracks.set(segment.trecho, { segment, pending: new Map(), pairs: [], exits: [], entraram: 0, sairam: 0 })
    }
  }

  start(): void {
    this.off ??= this.transport.subscribe(EVENTS_FILTER, (_t, payload) => this.onEvent(payload))
  }

  stop(): void {
    this.off?.()
    this.off = null
  }

  /** Entries waiting for their exit, over all segments. */
  pendentes(): number {
    let n = 0
    for (const t of this.tracks.values()) n += t.pending.size
    return n
  }

  /** Whether a hash is kept anywhere. */
  guarda(hash: string): boolean {
    return [...this.tracks.values()].some((t) => t.pending.has(hash))
  }

  private onEvent(payload: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(payload)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const { trecho, papel, placaHash, ts } = msg
    if (typeof trecho !== 'string' || typeof placaHash !== 'string' || !placaHash || typeof ts !== 'number' || !Number.isFinite(ts)) return
    const track = this.tracks.get(trecho)
    if (!track) return
    if (papel === 'entrada') {
      track.entraram += 1
      track.pending.set(placaHash, ts)
    } else if (papel === 'saida') {
      track.sairam += 1
      track.exits.push(ts)
      const entered = track.pending.get(placaHash)
      if (entered !== undefined) {
        track.pending.delete(placaHash)
        if (ts > entered) track.pairs.push({ ts, travelMs: ts - entered })
      }
    }
  }

  /** Called every simulation tick: drops expired entries and, every 10 s, publishes the metrics. */
  tick(): void {
    const t = this.now()
    for (const track of this.tracks.values()) {
      for (const [hash, entered] of track.pending) if (t - entered >= PENDING_TTL_MS) track.pending.delete(hash)
    }
    if (t < this.nextPublish) return
    this.nextPublish = (Math.floor(t / METRICS_EVERY_MS) + 1) * METRICS_EVERY_MS
    for (const track of this.tracks.values()) {
      const m = this.metrics(track, t)
      this.transport.publish(metricsTopic(m.trecho), JSON.stringify(m), { qos: 0, retain: true })
    }
  }

  private metrics(track: Track, t: number): SegmentMetrics {
    const from = t - METRICS_WINDOW_MS
    track.exits = track.exits.filter((ts) => ts > from)
    track.pairs = track.pairs.filter((p) => p.ts > from)
    const exits = track.exits.filter((ts) => ts <= t)
    const pairs = track.pairs.filter((p) => p.ts <= t)
    const { comprimentoM, trecho, camerasPar } = track.segment
    const totalS = pairs.reduce((sum, p) => sum + p.travelMs / 1000, 0)
    const ocupacao = Math.max(0, track.entraram - track.sairam)
    return {
      trecho,
      ts: t,
      janelaS: 60,
      fluxoVeicMin: exits.length,
      // space mean speed: length x pairs / sum of travel times (harmonic mean of the pairs' speeds)
      velocidadeMediaKmh: pairs.length && totalS > 0 ? round1(((comprimentoM * pairs.length) / totalS) * 3.6) : null,
      pares: pairs.length,
      entraram: track.entraram,
      sairam: track.sairam,
      ocupacao,
      densidadeVeicKm: round1(ocupacao / (comprimentoM / 1000)),
      camerasPar: [...camerasPar],
    }
  }
}
