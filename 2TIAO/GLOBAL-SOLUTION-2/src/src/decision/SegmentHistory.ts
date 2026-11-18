export const HISTORY_EVERY_MS = 10_000
/** 2 h of samples, one every 10 simulated seconds (AD-053). */
export const HISTORY_KEEP = 720

export interface HistoryPoint {
  t: number
  /** veh/h; null without a reading. */
  fluxo: number | null
  capacidade: number | null
  velocidade: number | null
}

export interface NetworkPoint {
  t: number
  avgSpeed: number | null
  travelMin: number | null
}

/** Each segment's flow, capacity and speed, and the network's mean speed and travel time, over the last 2 h. */
export class SegmentHistory {
  private readonly bySegment = new Map<string, HistoryPoint[]>()
  private readonly net: NetworkPoint[] = []

  /** Call after every tick; it keeps a sample only on each 10 s of simulated time. */
  record(t: number, segments: Record<string, Omit<HistoryPoint, 't'>>, network: Omit<NetworkPoint, 't'>): void {
    if (t === 0 || t % HISTORY_EVERY_MS !== 0) return
    for (const [id, p] of Object.entries(segments)) {
      let list = this.bySegment.get(id)
      if (!list) this.bySegment.set(id, (list = []))
      list.push({ t, ...p })
      if (list.length > HISTORY_KEEP) list.shift()
    }
    this.net.push({ t, ...network })
    if (this.net.length > HISTORY_KEEP) this.net.shift()
  }

  of(segmentId: string): readonly HistoryPoint[] {
    return this.bySegment.get(segmentId) ?? []
  }

  network(): readonly NetworkPoint[] {
    return this.net
  }
}
