import { describe, expect, it } from 'vitest'
import { APP_NAMES } from '../apps/apps'
import { APPS_TOPIC } from '../apps/AppFleet'
import type { Segment } from '../sensors/segments'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import type { AppName } from '../sim/types'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { candidatesFor, evaluate, outOfReach, segmentTimeS, selectNotified, type DriverView, type Evaluation } from './DriverRerouter'
import { Simulation } from './Simulation'

const JAMMED = 'I12>I13'

/** A segment of a hand-made graph: `length` metres between nodes `from` and `to`. */
const seg = (from: string, to: string, length: number): Segment => ({
  id: `${from}>${to}`,
  from,
  to,
  rua: 'teste',
  axis: 'H',
  points: [
    { x: 0, y: 0 },
    { x: length, y: 0 },
  ],
  length,
  lanes: 1,
})

/**
 * A city with one app driver on Al. Santos before the jammed block, and the fusion told that the
 * jammed block crawls at 3 km/h. Returns at 10 s, right after the window's decision.
 */
function setup(app: AppName | null) {
  const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
  const transport = new FakeTransport(true)
  const sim = new Simulation({ engine, transport, agentControl: true })
  sim.start()
  for (let t = TICK_MS; t < 10_000; t += TICK_MS) sim.tick()
  deliverMetrics(transport, JAMMED, engine.getState().timeMs, { k: 8 / 0.14, v: 3, ocupacao: 8 })
  const car = engine.addCar({ path: ['I11>I12', JAMMED, 'I13>I14'], distance: 0, velocity: 0, app })
  sim.setActiveDiversion({ trecho: JAMMED, p: 1, mode: 'todos' })
  sim.tick()
  return { engine, transport, sim, car }
}

const notices = (t: FakeTransport) => t.published.filter((m) => m.topic.startsWith('transito/notificacoes/'))

describe('reroute', () => {
  it('assigns map apps with the configured shares', () => {
    const e = new SimulationEngine({ ratePerMinute: 120, seed: 1001, cameras: [] })
    const apps = new Map<number, AppName | null>()
    while (apps.size < 1000) {
      e.tick(TICK_MS)
      for (const c of [...e.waitingCars(), ...e.getState().cars]) if (!apps.has(c.id) && apps.size < 1000) apps.set(c.id, c.app)
    }
    const withApp = [...apps.values()].filter((a): a is AppName => a !== null)
    expect(withApp.length).toBeGreaterThanOrEqual(550)
    expect(withApp.length).toBeLessThanOrEqual(650)
    const share = (a: AppName) => withApp.filter((x) => x === a).length / withApp.length
    expect(Math.abs(share('waze') - 0.4)).toBeLessThanOrEqual(0.06)
    expect(Math.abs(share('google-maps') - 0.5)).toBeLessThanOrEqual(0.06)
    expect(Math.abs(share('outros') - 0.1)).toBeLessThanOrEqual(0.06)
  })

  it('publishes active app drivers every 10 s', () => {
    const engine = new SimulationEngine({ ratePerMinute: 60, seed: 3, cameras: [] })
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine, transport })
    sim.start()
    for (let t = TICK_MS; t <= 30_000; t += TICK_MS) {
      sim.tick()
      const sent = transport.published.filter((m) => m.topic === APPS_TOPIC)
      expect(sent).toHaveLength(Math.floor(t / 10_000))
      if (t % 10_000 === 0) {
        const last = sent[sent.length - 1]
        expect(last.options.retain).toBe(true)
        const msg = JSON.parse(last.payload)
        expect(msg.ts).toBe(t)
        const drivers = [...engine.getState().cars, ...engine.waitingCars()].filter((c) => c.app)
        expect(msg.total).toBe(drivers.length)
        for (const a of APP_NAMES) expect(msg.porApp[a]).toBe(drivers.filter((c) => c.app === a).length)
        expect(msg.total).toBeGreaterThan(0)
      }
    }
  })

  it('selects only app drivers still heading into the jammed segment', () => {
    const net = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    const segById = new Map(net.getState().segments.map((s) => [s.id, s]))
    const path = ['I11>I12', JAMMED, 'I13>I14']
    const drivers: DriverView[] = [
      { id: 1, app: 'waze', path, seg: 0, saida: 'I14' }, // ahead of it
      { id: 2, app: null, path, seg: 0, saida: 'I14' }, // no app
      { id: 3, app: 'google-maps', path, seg: 1, saida: 'I14' }, // already on it
      { id: 4, app: 'outros', path, seg: 2, saida: 'I14' }, // past it
      { id: 5, app: 'waze', path: ['I21>I22', 'I22>I23'], seg: 0, saida: 'I23' }, // never crosses it
    ]
    const c = candidatesFor(drivers, JAMMED, segById)
    expect(c.map((x) => x.carId)).toEqual([1])
    expect(c[0]).toMatchObject({ app: 'waze', from: 'I12', saida: 'I14', current: [JAMMED, 'I13>I14'] })
  })

  it('notifies only when the alternative takes at most 90 percent of the time', () => {
    expect(segmentTimeS(100, null)).toBeCloseTo(9, 9)
    // current: S>M then the jammed M>E, 100 s each; alternative S>K>E
    const run = (altEachS: number, altSpeed: number | null = 36) => {
      const len = altSpeed === null ? 400 : (altEachS * altSpeed) / 3.6
      const segments = [seg('S', 'M', 1000), seg('M', 'E', 1000), seg('S', 'K', len), seg('K', 'E', len)]
      const speeds: Record<string, number | null> = { 'S>M': 36, 'M>E': 36, 'S>K': altSpeed, 'K>E': altSpeed }
      return evaluate({ carId: 1, app: 'waze', from: 'S', saida: 'E', current: ['S>M', 'M>E'] }, segments, (id) => speeds[id], 'M>E')
    }
    const a = run(87.5)
    expect(a.currentS).toBeCloseTo(200, 6)
    expect(a.altS).toBeCloseTo(175, 6)
    expect(a.alternative).toEqual(['S>K', 'K>E'])
    expect(a.ok).toBe(true)
    expect(a.gainS).toBeCloseTo(25, 6)
    const b = run(92.5)
    expect(b.altS).toBeCloseTo(185, 6)
    expect(b.ok).toBe(false)
    // no measured speed on the alternative: crossed at 40 km/h (2 x 400 m -> 72 s)
    const c = run(0, null)
    expect(c.altS).toBeCloseTo(72, 6)
    expect(c.ok).toBe(true)
  })

  it('caps partial diversion by p and picks the largest gains', () => {
    const evals: Evaluation[] = Array.from({ length: 10 }, (_, i) => ({
      carId: i + 1,
      app: 'waze',
      from: 'A',
      saida: 'B',
      current: [],
      alternative: ['x'],
      currentS: 100,
      altS: 100 - (i + 1),
      gainS: i + 1,
      ok: i !== 0,
    }))
    expect(selectNotified(evals, 'parcial', 0.25).map((e) => e.gainS)).toEqual([10, 9, 8])
    expect(selectNotified(evals, 'parcial', 0.3).map((e) => e.gainS)).toEqual([10, 9, 8])
    expect(selectNotified(evals, 'parcial', 0)).toEqual([])
    expect(selectNotified(evals, 'todos', 0.25).map((e) => e.gainS)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2])
  })

  it('reroutes from the next intersection and notifies the driver app', () => {
    const { engine, transport, car } = setup('google-maps')
    const now = engine.getState().cars.find((c) => c.id === car.id)!
    expect(now.path[0]).toBe('I11>I12')
    expect(now.path).not.toContain(JAMMED)
    expect(engine.segment(now.path[1])!.from).toBe('I12')
    expect(now.saida).toBe('I14')
    expect(engine.segment(now.path[now.path.length - 1])!.to).toBe('I14')
    const sent = notices(transport)
    expect(sent).toHaveLength(1)
    expect(sent[0].topic).toBe('transito/notificacoes/google-maps')
    const msg = JSON.parse(sent[0].payload)
    expect(msg.app).toBe('google-maps')
    expect(msg.trechoEvitado).toBe(JAMMED)
    expect(msg.rotaSugerida).toEqual(now.path.slice(1))
    expect(msg.ganhoS).toBeGreaterThan(0)
    expect(Object.keys(msg).sort()).toEqual(['app', 'ganhoS', 'mensagem', 'motorista', 'rotaSugerida', 'trechoEvitado', 'ts'])
  })

  it('keeps drivers without app and counts them as out of reach', () => {
    const { engine, transport, car, sim } = setup(null)
    expect(engine.getState().cars.find((c) => c.id === car.id)!.path).toEqual(['I11>I12', JAMMED, 'I13>I14'])
    expect(notices(transport)).toHaveLength(0)
    expect(sim.notifier.total).toBe(0)
    expect(outOfReach(8, 5)).toBe(3)
    expect(outOfReach(2, 5)).toBe(0)
    expect(outOfReach(null, 5)).toBeNull()
  })

  it('publishes no origin destination or position', () => {
    const { transport, car } = setup('waze')
    const forbidden = new Set(['origem', 'destino', 'entrada', 'saida', 'x', 'y', 'posicao', 'path'])
    const scan = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(scan)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(forbidden.has(k)).toBe(false)
          scan(x)
        }
      }
    }
    const sent = transport.published.filter((m) => m.topic.startsWith('transito/notificacoes/') || m.topic === APPS_TOPIC)
    expect(sent.some((m) => m.topic === APPS_TOPIC)).toBe(true)
    expect(sent.some((m) => m.topic.startsWith('transito/notificacoes/'))).toBe(true)
    for (const m of sent) scan(JSON.parse(m.payload))
    const notice = JSON.parse(notices(transport)[0].payload)
    // AD-046: the suggested route is the only trip field, and it starts at the next corner (I12),
    // never at the driver's entry (I11); it does reach the driver's exit, an accepted exception
    expect(notice.rotaSugerida[0].startsWith('I12>')).toBe(true)
    expect(notice.rotaSugerida.some((id: string) => id.startsWith('I11>'))).toBe(false)
    expect(Object.keys(notice).sort()).toEqual(['app', 'ganhoS', 'mensagem', 'motorista', 'rotaSugerida', 'trechoEvitado', 'ts'])
    expect(notice.mensagem).not.toMatch(/I\d\d/)
    expect(notice.motorista).not.toBe(String(car.id))
    expect(notice.motorista).not.toMatch(/^\d+$/)
    expect(notice.motorista).not.toContain(String(car.id).padStart(3, '0'))
  })
})
