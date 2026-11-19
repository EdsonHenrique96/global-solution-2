import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { APPS_TOPIC } from '../apps/AppFleet'
import { NOTIFICATIONS_FILTER } from '../apps/AppNotifier'
import { Simulation } from '../decision/Simulation'
import { ALERTS_TOPIC } from '../fusion/AlertPublisher'
import { METRICS_FILTER } from '../fusion/PlateMatcher'
import { SegmentTooltip } from '../render/SegmentTooltip'
import { segmentTooltip } from '../render/tooltip'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { DEFAULT_UNIT_BLOCKS } from './camera'
import { CAMERA_STATUS_FILTER, cameraStatusTopic, EVENTS_FILTER, pairOf, PlateCameraSet, wirePlateCameras, type CameraStatus, type PlateEvent } from './PlateCamera'
import { PLACA_RE, plateHash } from './plates'
import { pointOnSegment } from './segments'

const EVENT_KEYS = ['cameraId', 'classe', 'faixa', 'papel', 'placaHash', 'trecho', 'ts']
const STATUS_KEYS = ['cameraId', 'online', 'papel', 'trecho', 'ts']
const MONITORED = DEFAULT_UNIT_BLOCKS.map(([a, b]) => `${a}>${b}`)
const id = (n: number, s: 'E' | 'S') => `C${String(n).padStart(2, '0')}${s}`

function wired(options: ConstructorParameters<typeof SimulationEngine>[0] = {}) {
  const engine = new SimulationEngine({ ratePerMinute: 0, ...options })
  const transport = new FakeTransport(true)
  wirePlateCameras(engine, transport)
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += TICK_MS) engine.tick(TICK_MS)
  }
  return { engine, transport, run }
}

const eventsOn = (transport: FakeTransport, trecho: string) =>
  transport.published.filter((m) => m.topic === `transito/vias/${trecho}/eventos`).map((m) => ({ ...m, event: JSON.parse(m.payload) as PlateEvent }))

/** Every key at any depth of a JSON value. */
function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keysOf)
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)])
  return []
}

describe('plate cameras', () => {
  it('C1 starts with 24 cameras an entry and an exit on each of the 12 segments', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    const cameras = engine.getState().cameras
    expect(cameras.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => [id(i + 1, 'E'), id(i + 1, 'S')]).flat())
    DEFAULT_UNIT_BLOCKS.forEach(([a, b], i) => {
      const seg = engine.segment(`${a}>${b}`)!
      const entry = cameras.find((c) => c.id === id(i + 1, 'E'))!
      const exit = cameras.find((c) => c.id === id(i + 1, 'S'))!
      expect(entry).toMatchObject({ trecho: seg.id, papel: 'entrada', linhaM: 0 })
      expect(exit).toMatchObject({ trecho: seg.id, papel: 'saida' })
      // 60 m before the stop line, which is 12 m before the corner (AD-079, AD-083)
      expect(exit.linhaM).toBeCloseTo(seg.length - 72, 9)
      expect(entry.position).toEqual(pointOnSegment(seg, 0))
      const stop = pointOnSegment(seg, seg.length - 72)
      expect(exit.position.x).toBeCloseTo(stop.x, 9)
      expect(exit.position.y).toBeCloseTo(stop.y, 9)
    })
  })

  it('C2 leaves the other 36 segments without a pair shown as estimado', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    const { cameras, segments } = engine.getState()
    const unpaired = segments.filter((s) => pairOf(cameras, s.id) === null)
    expect(unpaired).toHaveLength(36)
    expect(segments.filter((s) => pairOf(cameras, s.id) !== null).map((s) => s.id).sort()).toEqual([...MONITORED].sort())
    for (const s of unpaired) {
      const content = segmentTooltip(s.id, pairOf(cameras, s.id), undefined, 'sem dado', 0)
      expect(content.estimado).toBe(true)
      expect(content.unidade).toBe('estimado')
    }
    render(<SegmentTooltip content={segmentTooltip(unpaired[0].id, null, undefined, 'sem dado', 0)} x={0} y={0} />)
    const tip = screen.getByRole('tooltip')
    expect(tip.querySelector('.tag')).toHaveTextContent('estimado')
    expect(screen.getByTestId('tooltip-unidade')).toHaveTextContent('estimado')
  })

  it('C3 every generated car gets a plate and classe carro', () => {
    const { engine, run } = wired({ ratePerMinute: 60 })
    run(60_000)
    const cars = [...engine.getState().cars, ...engine.waitingCars()]
    expect(engine.getState().spawnedTotal).toBeGreaterThanOrEqual(60)
    expect(cars.length).toBeGreaterThan(0)
    for (const car of cars) {
      expect(car.placa).toMatch(PLACA_RE)
      expect(car.classe).toBe('carro')
    }
    const placed = engine.addCar({ path: ['I11>I12'] })
    expect(placed.placa).toMatch(PLACA_RE)
    expect(placed.classe).toBe('carro')
  })

  it('C4 a car driving through a monitored segment publishes one entrada and one saida', () => {
    const { engine, transport, run } = wired()
    const car = engine.addCar({ path: ['I11>I12', 'I12>I13'] })
    run(180_000)
    expect(engine.getState().cars).toHaveLength(0)
    const msgs = eventsOn(transport, 'I11>I12')
    expect(msgs).toHaveLength(2)
    const [entry, exit] = msgs.map((m) => m.event)
    expect(entry).toMatchObject({ cameraId: 'C01E', trecho: 'I11>I12', papel: 'entrada', faixa: 1, classe: 'carro' })
    expect(exit).toMatchObject({ cameraId: 'C01S', trecho: 'I11>I12', papel: 'saida', faixa: 1, classe: 'carro' })
    expect(exit.ts).toBeGreaterThan(entry.ts)
    for (const m of msgs) {
      expect(Object.keys(m.event).sort()).toEqual(EVENT_KEYS)
      expect(m.event.placaHash).toMatch(/^[0-9a-f]{16}$/)
      expect(m.event.placaHash).toBe(plateHash(car.placa, m.event.ts, 42))
      expect(m.options).toEqual({ qos: 0, retain: false })
    }
  })

  it('C5 a car standing on a camera line for 30 s makes one event', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    const cameras = engine.getState().cameras.filter((c) => c.trecho === 'I11>I12')
    const line = cameras.find((c) => c.papel === 'saida')!.linhaM
    const car = (d: number, segmentId = 'I11>I12') => [{ id: 7, placa: 'ABC1D23', classe: 'carro' as const, segmentId, distance: d }]
    const count = (track: { segmentId?: string; d: number }[]) => {
      const set = new PlateCameraSet(cameras, 42)
      let ts = 0
      const events: PlateEvent[] = []
      for (const p of track) events.push(...set.observe(car(p.d, p.segmentId), (ts += TICK_MS)).events)
      return events
    }
    const stand = (d: number) => Array.from({ length: 300 }, () => ({ d }))
    // on the exit line, exactly, then just past it
    for (const on of [line, line + 0.3]) {
      const events = count([{ d: line - 20 }, { d: line - 5 }, ...stand(on), { d: line + 2 }, { d: line + 8 }])
      expect(events.filter((e) => e.papel === 'saida')).toHaveLength(1)
    }
    // on the entry line: the car stands at the start of the segment
    const entries = count([...stand(0), { d: 1 }, { d: 3 }])
    expect(entries.filter((e) => e.papel === 'entrada')).toHaveLength(1)
  })

  it('C6 a car generated at the border corner of an entry camera makes one entrada', () => {
    const { engine, transport } = wired({ ratePerMinute: 60 })
    const border = new Set(['1', '4'])
    const entryOf = new Map(engine.getState().cameras.filter((c) => c.papel === 'entrada').map((c) => [c.trecho, c.id]))
    const isBorder = (corner: string) => border.has(corner[1]) || border.has(corner[2])
    const born = new Map<number, { placa: string; trecho: string }>()
    for (let t = 0; t < 300_000; t += TICK_MS) {
      engine.tick(TICK_MS)
      for (const c of engine.waitingCars()) {
        if (entryOf.has(c.path[0]) && isBorder(c.entrada) && c.entrada === engine.segment(c.path[0])!.from) born.set(c.id, { placa: c.placa, trecho: c.path[0] })
      }
    }
    const waiting = new Set(engine.waitingCars().map((c) => c.id))
    const entered = [...born].filter(([carId]) => !waiting.has(carId))
    expect(entered.length).toBeGreaterThan(0)
    for (const [, { placa, trecho }] of entered) {
      const mine = eventsOn(transport, trecho).filter((m) => m.event.cameraId === entryOf.get(trecho) && m.event.placaHash === plateHash(placa, m.event.ts, 42))
      expect(mine).toHaveLength(1)
      expect(mine[0].event.papel).toBe('entrada')
    }
  })

  it('C7 no payload on transito carries a plate', { timeout: 120_000 }, () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30, seed: 1001 }), transport })
    sim.start()
    for (let t = 0; t < 600_000; t += TICK_MS) {
      if (t === 120_000) sim.engine.addBlockage('I12>I13', 100, 300_000)
      sim.tick()
    }
    const all = transport.published.filter((m) => topicMatches('transito/#', m.topic))
    expect(all.filter((m) => topicMatches(EVENTS_FILTER, m.topic)).length).toBeGreaterThan(100)
    const mercosul = /[A-Z]{3}[0-9][A-Z][0-9]{2}/
    for (const m of all) {
      expect(keysOf(JSON.parse(m.payload))).not.toContain('placa')
      expect(m.payload).not.toMatch(mercosul)
    }
  })

  it('C9 publishes the status of the 24 cameras every 10 simulated seconds', () => {
    const { engine, transport, run } = wired()
    run(30_000)
    const status = transport.published.filter((m) => topicMatches(CAMERA_STATUS_FILTER, m.topic))
    expect(status).toHaveLength(72)
    const cameras = engine.getState().cameras
    for (const ts of [10_000, 20_000, 30_000]) {
      const at = status.map((m) => ({ topic: m.topic, s: JSON.parse(m.payload) as CameraStatus })).filter((x) => x.s.ts === ts)
      expect(at.map((x) => x.s.cameraId).sort()).toEqual(cameras.map((c) => c.id).sort())
      for (const { topic, s } of at) {
        const c = cameras.find((x) => x.id === s.cameraId)!
        expect(topic).toBe(cameraStatusTopic(c.id))
        expect(Object.keys(s).sort()).toEqual(STATUS_KEYS)
        expect(s).toEqual({ cameraId: c.id, trecho: c.trecho, papel: c.papel, ts, online: true })
      }
    }
  })

  it('C10 the same seed and demand give the same events', { timeout: 60_000 }, () => {
    const runOnce = () => {
      const engine = new SimulationEngine({ ratePerMinute: 15, seed: 1001, arrivals: 'poisson' })
      const events: PlateEvent[] = []
      engine.onPlateEvent((e) => events.push(e))
      for (let t = 0; t < 300_000; t += TICK_MS) engine.tick(TICK_MS)
      return events
    }
    const first = runOnce()
    expect(first.length).toBeGreaterThan(0)
    expect(runOnce()).toEqual(first)
  })

  it('C11 publishes nothing on the old telemetry topic', () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30 }), transport })
    sim.start()
    for (let t = 0; t < 30_000; t += TICK_MS) sim.tick()
    const known = [EVENTS_FILTER, CAMERA_STATUS_FILTER, METRICS_FILTER, APPS_TOPIC, ALERTS_TOPIC, NOTIFICATIONS_FILTER]
    expect(transport.published.length).toBeGreaterThan(0)
    for (const m of transport.published) {
      expect(m.topic.startsWith('transito/sensores')).toBe(false)
      expect(known.some((f) => topicMatches(f, m.topic))).toBe(true)
    }
    // a reading on the old topic changes nothing
    const before = JSON.stringify(sim.capacity.fusion.state())
    transport.deliver(
      'transito/sensores/U01/telemetria',
      JSON.stringify({ sensorId: 'U01', ts: 30_000, porTrecho: [{ trecho: 'I22>I23', contagem: 9, velocidadeMediaKmh: 10, comprimentoCobertoM: 100, cobertura: 1 }] }),
    )
    expect(JSON.stringify(sim.capacity.fusion.state())).toBe(before)
  })
})
