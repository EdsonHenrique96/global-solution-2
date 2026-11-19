import type { SimulationEngine } from '../sim/SimulationEngine'
import type { TelemetryTransport } from '../telemetry/transport'
import { bearing, DEFAULT_UNIT_BLOCKS, UNIT_FOV, UNIT_RANGE, type FixedCamera } from './camera'
import { plateHash } from './plates'
import { pointOnSegment, type Segment } from './segments'

export type Papel = 'entrada' | 'saida'

/** How the panel names each role. */
export const PAPEL_LABEL: Record<Papel, string> = { entrada: 'entrada', saida: 'saída' }

/**
 * A plate camera at one end of a monitored segment (door 3): it reads the plate of every car that
 * crosses its line, `linhaM` metres along `trecho`. Its cone (the FixedCamera part) is its field
 * of view.
 */
export interface PlateCamera extends FixedCamera {
  trecho: string
  papel: Papel
  linhaM: number
}

/** One car crossing one camera's line (door 1). The plate itself never leaves this module. */
export interface PlateEvent {
  cameraId: string
  trecho: string
  papel: Papel
  placaHash: string
  ts: number
  faixa: 1
  classe: 'carro'
}

/** A camera's heartbeat, every 10 s (door 3). */
export interface CameraStatus {
  cameraId: string
  trecho: string
  papel: Papel
  ts: number
  online: true
}

/** Where a car is, as the cameras see it. */
export interface PlateSample {
  id: number
  placa: string
  classe: 'carro'
  segmentId: string
  distance: number
}

export const STATUS_EVERY_MS = 10_000

export const EVENTS_FILTER = 'transito/vias/+/eventos'
export const eventsTopic = (trecho: string) => `transito/vias/${trecho}/eventos`
export const CAMERA_STATUS_FILTER = 'transito/cameras/+/status'
export const cameraStatusTopic = (cameraId: string) => `transito/cameras/${cameraId}/status`

/** `C01E`, `C12S`. */
export const cameraId = (n: number, papel: Papel) => `C${String(n).padStart(2, '0')}${papel === 'entrada' ? 'E' : 'S'}`

/**
 * The 24 cameras: for each segment `n` of DEFAULT_UNIT_BLOCKS, `C<n>E` at its start and `C<n>S` at
 * its stop line, `stopLineM` before its end. The entry camera looks down the segment, the exit
 * camera back at the cars coming to its line.
 */
export function defaultPlateCameras(segments: readonly Segment[], stopLineM: number): PlateCamera[] {
  return DEFAULT_UNIT_BLOCKS.flatMap(([a, b], i): PlateCamera[] => {
    const s = segments.find((x) => x.id === `${a}>${b}`)
    if (!s) return []
    const [start, end] = s.points
    const exitLine = s.length - stopLineM
    return [
      { id: cameraId(i + 1, 'entrada'), trecho: s.id, papel: 'entrada', linhaM: 0, position: pointOnSegment(s, 0), heading: bearing(start, end), fov: UNIT_FOV, range: UNIT_RANGE },
      { id: cameraId(i + 1, 'saida'), trecho: s.id, papel: 'saida', linhaM: exitLine, position: pointOnSegment(s, exitLine), heading: bearing(end, start), fov: UNIT_FOV, range: UNIT_RANGE },
    ]
  })
}

/** The entry and exit camera ids of a segment, or null when it has no pair. */
export function pairOf(cameras: readonly PlateCamera[], trecho: string): [string, string] | null {
  const entry = cameras.find((c) => c.trecho === trecho && c.papel === 'entrada')
  const exit = cameras.find((c) => c.trecho === trecho && c.papel === 'saida')
  return entry && exit ? [entry.id, exit.id] : null
}

const EPS = 1e-6

interface Position {
  segmentId: string
  distance: number
}

/**
 * Whether a car crossed a camera's line between two ticks; undefined means not on the road. The
 * entry line is crossed when the car comes onto the segment; the exit line when the car goes past
 * it - a car standing on it has not crossed yet.
 */
export function crossed(camera: Pick<PlateCamera, 'trecho' | 'papel' | 'linhaM'>, prev: Position | undefined, now: Position | undefined): boolean {
  const prevOn = prev?.segmentId === camera.trecho
  const nowOn = now?.segmentId === camera.trecho
  if (!prevOn && !nowOn) return false
  const line = camera.linhaM
  const before = !prevOn || (camera.papel === 'entrada' ? prev!.distance < line : prev!.distance <= line + EPS)
  const after = !nowOn || (camera.papel === 'entrada' ? now!.distance >= line : now!.distance > line + EPS)
  return before && after
}

/**
 * The cameras of a run: each tick they see where every car is, and report one event per car that
 * crossed a line, with the plate hashed with the salt of the simulated hour; every 10 s, the
 * status of every camera.
 */
export class PlateCameraSet {
  private readonly bySegment = new Map<string, PlateCamera[]>()
  private readonly cameras: readonly PlateCamera[]
  private readonly seed: number
  private last = new Map<number, PlateSample>()
  private nextStatus = STATUS_EVERY_MS

  constructor(cameras: readonly PlateCamera[], seed: number) {
    this.cameras = cameras
    this.seed = seed
    for (const c of cameras) this.bySegment.set(c.trecho, [...(this.bySegment.get(c.trecho) ?? []), c])
  }

  observe(cars: readonly PlateSample[], ts: number): { events: PlateEvent[]; statuses: CameraStatus[] } {
    const events: PlateEvent[] = []
    const check = (car: PlateSample, prev: PlateSample | undefined, now: PlateSample | undefined) => {
      const segs = new Set([prev?.segmentId, now?.segmentId])
      for (const id of segs) {
        for (const camera of (id && this.bySegment.get(id)) || []) {
          if (!crossed(camera, prev, now)) continue
          events.push({
            cameraId: camera.id,
            trecho: camera.trecho,
            papel: camera.papel,
            placaHash: plateHash(car.placa, ts, this.seed),
            ts,
            faixa: 1,
            classe: car.classe,
          })
        }
      }
    }
    const next = new Map<number, PlateSample>()
    for (const car of cars) {
      next.set(car.id, car)
      check(car, this.last.get(car.id), car)
    }
    // cars that left the city since the last tick
    for (const [id, prev] of this.last) if (!next.has(id)) check(prev, prev, undefined)
    this.last = next

    const statuses: CameraStatus[] = []
    if (ts >= this.nextStatus) {
      for (const c of this.cameras) statuses.push({ cameraId: c.id, trecho: c.trecho, papel: c.papel, ts, online: true })
      this.nextStatus = (Math.floor(ts / STATUS_EVERY_MS) + 1) * STATUS_EVERY_MS
    }
    return { events, statuses }
  }
}

/** Publishes every plate event (door 1) and camera status (door 3) the engine produces. */
export function wirePlateCameras(engine: SimulationEngine, transport: TelemetryTransport): () => void {
  const offEvents = engine.onPlateEvent((e) => transport.publish(eventsTopic(e.trecho), JSON.stringify(e), { qos: 0, retain: false }))
  const offStatus = engine.onCameraStatus((s) => transport.publish(cameraStatusTopic(s.cameraId), JSON.stringify(s), { qos: 0, retain: false }))
  return () => {
    offEvents()
    offStatus()
  }
}
