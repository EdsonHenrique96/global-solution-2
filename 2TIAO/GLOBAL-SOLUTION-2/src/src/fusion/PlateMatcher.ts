import { EVENTS_FILTER, type PlateCamera } from '../sensors/PlateCamera'
import { hourOf } from '../sensors/plates'
import type { TelemetryTransport } from '../telemetry/transport'

export const METRICS_FILTER = 'transito/vias/+/metricas'
export const metricsTopic = (trecho: string) => `transito/vias/${trecho}/metricas`

/** The window the metrics cover, and how often they are recomputed (AD-069). */
export const METRICS_WINDOW_MS = 60_000
export const METRICS_EVERY_MS = 10_000
/** An entry with no exit is dropped after this long, with its hash (RNF01). */
export const PENDING_TTL_MS = 600_000
/** The anomaly looks at the cars that entered in the last 2 min (AD-091). */
export const ANOMALY_WINDOW_MS = 120_000
/** A car is overdue past 3x the median crossing time of the last hour, and never before 30 s. */
export const OVERDUE_FACTOR = 3
export const OVERDUE_MIN_MS = 30_000
export const MEDIAN_WINDOW_MS = 3_600_000
/** Opens at 80 % of the overdue cars still inside, with at least 3; closes below 50 %. */
export const ANOMALY_OPEN_SHARE = 0.8
export const ANOMALY_MIN_CARS = 3
export const ANOMALY_CLOSE_SHARE = 0.5

export const ANOMALY_FILTER = 'transito/vias/+/anomalia'
export const anomalyTopic = (trecho: string) => `transito/vias/${trecho}/anomalia`

/** "Possível incidente" on a segment (door 5): opened and closed by the matcher, never a level. */
export interface SegmentAnomaly {
  trecho: string
  ts: number
  ativo: boolean
  /** Overdue cars still inside. */
  atrasados: number
  /** atrasados over the overdue cars that entered in the last 2 min. */
  fracao: number
}

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

/** One car that entered: when, and whether it has left. Its hash lives only in `pending`. */
interface Entry {
  ts: number
  exited: boolean
}

interface Track {
  segment: MonitoredSegment
  /** PendingEntry: hash -> entry, only until its exit or PENDING_TTL_MS. */
  pending: Map<string, Entry>
  /** The cars that entered in the last 2 min, for the anomaly. */
  recent: Entry[]
  /** Closed pairs: exit time and travel time, no hash (the last hour, for the median). */
  pairs: { ts: number; travelMs: number }[]
  exits: number[]
  entraram: number
  sairam: number
  anomaly: boolean
}

const round1 = (v: number) => Math.round(v * 10) / 10
const median = (xs: number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The anomaly of a segment (AD-091): among the cars that entered in the last 2 min and should
 * have left by now (older than 3x the median crossing of the last hour, at least 30 s), how many
 * are still inside. Opens at 80 % with at least 3 such cars, closes below 50 %, else holds.
 */
export function anomalyOf(
  recent: readonly Entry[],
  travelTimesMs: readonly number[],
  nowMs: number,
  open: boolean,
): { ativo: boolean; atrasados: number; fracao: number } {
  const typical = median([...travelTimesMs])
  const overdueAfter = Math.max(OVERDUE_MIN_MS, typical === null ? 0 : OVERDUE_FACTOR * typical)
  const due = recent.filter((e) => nowMs - e.ts > overdueAfter && nowMs - e.ts <= ANOMALY_WINDOW_MS)
  const atrasados = due.filter((e) => !e.exited).length
  const fracao = due.length ? atrasados / due.length : 0
  if (!open) return { ativo: atrasados >= ANOMALY_MIN_CARS && fracao >= ANOMALY_OPEN_SHARE, atrasados, fracao }
  return { ativo: due.length === 0 ? true : fracao >= ANOMALY_CLOSE_SHARE, atrasados, fracao }
}

/**
 * Pairs each exit with the pending entry of the same plate hash on the same segment, and every
 * 10 simulated seconds publishes each segment's last-minute metrics (speed from closed pairs only,
 * AD-091) and opens or closes its anomaly warning. It only sees the cameras' events on the broker,
 * and keeps a hash only while its entry waits for an exit.
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
      this.tracks.set(segment.trecho, { segment, pending: new Map(), recent: [], pairs: [], exits: [], entraram: 0, sairam: 0, anomaly: false })
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
      const entry = { ts, exited: false }
      track.pending.set(placaHash, entry)
      track.recent.push(entry)
    } else if (papel === 'saida') {
      track.sairam += 1
      track.exits.push(ts)
      const entry = track.pending.get(placaHash)
      if (entry !== undefined) {
        track.pending.delete(placaHash)
        entry.exited = true
        if (ts > entry.ts) track.pairs.push({ ts, travelMs: ts - entry.ts })
      } else {
        // the salt changed since this car entered, so its entry carries another hash: the exit
        // closes the oldest entry from before the change, without a pair
        let oldest: [string, Entry] | null = null
        for (const e of track.pending) if (hourOf(e[1].ts) < hourOf(ts) && (oldest === null || e[1].ts < oldest[1].ts)) oldest = e
        if (oldest) {
          track.pending.delete(oldest[0])
          oldest[1].exited = true
        }
      }
    }
  }

  /** Called every simulation tick: drops expired entries and, every 10 s, publishes the metrics. */
  tick(): void {
    const t = this.now()
    for (const track of this.tracks.values()) {
      for (const [hash, entry] of track.pending) if (t - entry.ts >= PENDING_TTL_MS) track.pending.delete(hash)
    }
    if (t < this.nextPublish) return
    this.nextPublish = (Math.floor(t / METRICS_EVERY_MS) + 1) * METRICS_EVERY_MS
    for (const track of this.tracks.values()) {
      const m = this.metrics(track, t)
      this.transport.publish(metricsTopic(m.trecho), JSON.stringify(m), { qos: 0, retain: true })
      track.recent = track.recent.filter((e) => t - e.ts <= ANOMALY_WINDOW_MS)
      const a = anomalyOf(track.recent, track.pairs.map((p) => p.travelMs), t, track.anomaly)
      if (a.ativo !== track.anomaly) {
        track.anomaly = a.ativo
        const body: SegmentAnomaly = { trecho: m.trecho, ts: t, ativo: a.ativo, atrasados: a.atrasados, fracao: round1(a.fracao * 100) / 100 }
        this.transport.publish(anomalyTopic(m.trecho), JSON.stringify(body), { qos: 0, retain: true })
      }
    }
  }

  private metrics(track: Track, t: number): SegmentMetrics {
    const from = t - METRICS_WINDOW_MS
    track.exits = track.exits.filter((ts) => ts > from)
    track.pairs = track.pairs.filter((p) => p.ts > t - MEDIAN_WINDOW_MS)
    const exits = track.exits.filter((ts) => ts <= t)
    const pairs = track.pairs.filter((p) => p.ts > from && p.ts <= t)
    const { comprimentoM, trecho, camerasPar } = track.segment
    const totalS = pairs.reduce((sum, p) => sum + p.travelMs / 1000, 0)
    const ocupacao = Math.max(0, track.entraram - track.sairam)
    return {
      trecho,
      ts: t,
      janelaS: 60,
      fluxoVeicMin: exits.length,
      // space mean speed of the closed pairs: length x pairs / sum of travel times (AD-091)
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
