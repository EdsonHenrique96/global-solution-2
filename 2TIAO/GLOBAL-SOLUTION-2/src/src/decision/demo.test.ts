import { describe, expect, it } from 'vitest'
import { ANOMALY_FILTER } from '../fusion/PlateMatcher'
import { NIVEL_ORDER, type Nivel } from '../render/levels'
import { topicMatches } from '../telemetry/transport'
import { eventsTopic, type PlateEvent } from '../sensors/PlateCamera'
import { DEFAULT_RATE_PER_MINUTE, QUEUE_SPEED_MS, SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { CONFIGURED_CAPACITY_VEH_H } from '../capacity/CapacityModel'
import { Simulation } from './Simulation'

/** How bad a map level is: critico 3 .. livre 0; learning and no data are not on the scale. */
const severity = (n: Nivel) => (n === 'aprendendo' || n === 'sem dado' ? -1 : 3 - NIVEL_ORDER.indexOf(n))
const FIFTEEN_MIN = 900_000

/** 15 simulated minutes at `rate`: mean exits per minute on the monitored segments and the longest stop. */
function measure(rate: number) {
  const engine = new SimulationEngine({ ratePerMinute: rate, seed: 1001 })
  const monitored = new Set(engine.getState().cameras.map((c) => c.trecho))
  let exits = 0
  engine.onPlateEvent((e) => {
    if (e.papel === 'saida') exits += 1
  })
  const stopped = new Map<number, number>()
  let longestStopMs = 0
  for (let t = 0; t < FIFTEEN_MIN; t += TICK_MS) {
    engine.tick(TICK_MS)
    const now = engine.getState().timeMs
    const onRoad = new Set<number>()
    for (const car of engine.getState().cars) {
      onRoad.add(car.id)
      const ms = car.velocity < QUEUE_SPEED_MS ? (stopped.get(car.id) ?? 0) + TICK_MS : 0
      stopped.set(car.id, ms)
      longestStopMs = Math.max(longestStopMs, ms)
    }
    for (const id of [...stopped.keys()]) if (!onRoad.has(id)) stopped.delete(id)
    // a car waiting at the border to enter is standing too
    for (const car of engine.waitingCars()) longestStopMs = Math.max(longestStopMs, now - (car.bornAtMs ?? now))
  }
  return { perMinute: exits / monitored.size / 15, longestStopMs }
}

describe('v1 demo', () => {
  it('C31 the default demand is the smallest multiple of 5 with 5 cars per minute on the monitored segments', { timeout: 180_000 }, () => {
    expect(DEFAULT_RATE_PER_MINUTE).toBe(75)
    expect(new SimulationEngine().getRate()).toBe(75)
    const at75 = measure(75)
    expect(at75.perMinute).toBeGreaterThanOrEqual(5)
    expect(at75.longestStopMs).toBeLessThanOrEqual(120_000)
    expect(measure(70).perMinute).toBeLessThan(5)
  })

  it('C29 doubling the default demand worsens the most loaded monitored segment within 3 minutes', { timeout: 180_000 }, () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: DEFAULT_RATE_PER_MINUTE, seed: 1001 }), transport })
    sim.setDiversionEnabled(false)
    sim.start()
    const run = (ms: number, each?: () => void) => {
      for (let t = 0; t < ms; t += TICK_MS) {
        sim.tick()
        each?.()
      }
    }
    const monitored = [...new Set(sim.engine.getState().cameras.map((c) => c.trecho))]
    run(FIFTEEN_MIN)
    // the level the map paints: the simulation's one classifier (AD-082)
    const atSwitch = monitored
      .map((id) => sim.readings()[id])
      .filter((r) => r.pct !== null)
      .sort((a, b) => b.pct! - a.pct!)[0]
    expect(atSwitch, 'a monitored segment has learned its capacity').toBeDefined()
    const before = severity(atSwitch.nivel)
    sim.engine.setRate(2 * DEFAULT_RATE_PER_MINUTE)
    let worst = before
    let at: number | null = null
    run(180_000, () => {
      if (sim.engine.getState().timeMs % 10_000 !== 0) return
      const now = severity(sim.readings()[atSwitch.id].nivel)
      if (now > worst) {
        worst = now
        at ??= sim.engine.getState().timeMs
      }
    })
    expect(worst, `${atSwitch.id} at ${atSwitch.nivel} (${atSwitch.pct}%)`).toBeGreaterThan(before)
    expect(at! - FIFTEEN_MIN).toBeLessThanOrEqual(180_000)
  })

  it('C35 a full block warns Possível incidente without changing the level or the diversion', { timeout: 300_000 }, () => {
    const id = 'I12>I13'
    // the same seeded run twice: once as is, once with the warning dropped before it reaches the fusion
    const run = (withWarning: boolean) => {
      const transport = new FakeTransport(true)
      if (!withWarning) {
        const publish = transport.publish.bind(transport)
        transport.publish = (topic, payload, options) => {
          if (!topicMatches(ANOMALY_FILTER, topic)) publish(topic, payload, options)
        }
      }
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: DEFAULT_RATE_PER_MINUTE, seed: 1001 }), transport })
      sim.start()
      for (let t = 0; t < FIFTEEN_MIN; t += TICK_MS) sim.tick()
      const block = sim.engine.addBlockage(id, sim.engine.segment(id)!.length / 2, 120_000)
      const frames: { t: number; open: boolean; shown: string; others: string; diverted: string | null }[] = []
      while (sim.engine.getState().timeMs < block.endsAtMs + 120_000) {
        sim.tick()
        const now = sim.engine.getState().timeMs
        if (now % 10_000 !== 0) continue
        const readings = sim.readings()
        const others = Object.values(readings)
          .filter((r) => r.id !== id)
          .map((r) => `${r.id}:${r.nivel}`)
          .join(',')
        const open = sim.capacity.fusion.state()[id].possivelIncidente
        const incident = sim.incidents.active().some((x) => x.kind === 'possivel-incidente' && x.segmentId === id)
        expect(incident).toBe(open)
        frames.push({ t: now, open, shown: readings[id].exibido, others, diverted: sim.diversion.status === 'ativo' ? sim.diversion.trecho : null })
      }
      return { frames, end: block.endsAtMs }
    }
    const warned = run(true)
    const silent = run(false)
    const open = warned.frames.filter((f) => f.open)
    expect(open.length, 'the full block opens the warning').toBeGreaterThan(0)
    expect(open[0].t).toBeLessThan(warned.end)
    expect(warned.frames.at(-1)!.open, 'it closes once the cars leave').toBe(false)
    expect(silent.frames.some((f) => f.open)).toBe(false)
    // the runs are the same until their decisions differ; from the warning on, the segment shows
    // "Em verificação" and never starts a diversion (AD-100), and every other segment's level is
    // what it is without the warning
    const split = warned.frames.findIndex((f, k) => f.diverted !== silent.frames[k].diverted)
    for (const f of open) {
      const k = warned.frames.indexOf(f)
      expect(f.shown, `shown at ${f.t}`).toBe('verificacao')
      expect(silent.frames[k].shown, `shown without the warning at ${f.t}`).not.toBe('verificacao')
      if (split === -1 || k < split) expect(f.others, `other levels at ${f.t}`).toBe(silent.frames[k].others)
    }
    const startedOn = warned.frames.filter((f, k) => f.diverted === id && (k === 0 || warned.frames[k - 1].diverted !== id))
    expect(startedOn.filter((f) => f.open), 'no diversion starts on it while in verification').toHaveLength(0)
  })

  it('C38 a full block warns within 70 s of the first stuck car', { timeout: 300_000 }, () => {
    // the seeds measured when AD-097 was decided: 67.1, 68.9 and 66.8 s
    for (const seed of [1001, 1002, 1003]) {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: DEFAULT_RATE_PER_MINUTE, seed }), transport })
    sim.start()
    const id = 'I12>I13'
    const entries: { hash: string; ts: number }[] = []
    const exitAt = new Map<string, number>()
    transport.subscribe(eventsTopic(id), (_t, payload) => {
      const e = JSON.parse(payload) as PlateEvent
      if (e.papel === 'entrada') entries.push({ hash: e.placaHash, ts: e.ts })
      else exitAt.set(e.placaHash, e.ts)
    })
    for (let t = 0; t < FIFTEEN_MIN; t += TICK_MS) sim.tick()
    const block = sim.engine.addBlockage(id, sim.engine.segment(id)!.length / 2, 120_000)
    let warned: number | null = null
    while (sim.engine.getState().timeMs < block.endsAtMs + 60_000) {
      sim.tick()
      if (warned === null && sim.capacity.fusion.state()[id].possivelIncidente) warned = sim.engine.getState().timeMs
    }
    // the first stuck car: the first to enter after the block that leaves only once it is lifted
    const stuck = entries.find((e) => e.ts >= FIFTEEN_MIN && (exitAt.get(e.hash) ?? Infinity) >= block.endsAtMs)!
    expect(warned, `seed ${seed}`).not.toBeNull()
    expect(warned! - stuck.ts, `seed ${seed}`).toBeLessThanOrEqual(70_000)
    }
  })

  it('C39 no monitored segment is Aprendendo at the first recompute with metrics', () => {
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: DEFAULT_RATE_PER_MINUTE, seed: 1001 }), transport: new FakeTransport(true) })
    sim.start()
    const monitored = [...new Set(sim.engine.getState().cameras.map((c) => c.trecho))]
    for (let t = 0; t < 10_000; t += TICK_MS) sim.tick()
    // the first recomputation: every monitored segment has metrics and the configured capacity
    const fused = sim.capacity.fusion.state()
    const readings = sim.readings()
    for (const id of monitored) {
      expect(fused[id].atualizadoEm, id).toBe(10_000)
      expect(readings[id].capacidade, id).toBeCloseTo(CONFIGURED_CAPACITY_VEH_H, 6)
      expect(['aprendendo', 'sem dado'], id).not.toContain(readings[id].nivel)
    }
  })

  it('C40 low traffic still shows speed flow density and a level', { timeout: 180_000 }, () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 30, seed: 1001 }), transport })
    sim.start()
    const monitored = [...new Set(sim.engine.getState().cameras.map((c) => c.trecho))]
    let exits = 0
    sim.engine.onPlateEvent((e) => {
      if (e.papel === 'saida') exits += 1
    })
    // each segment's first pair: from then on it has a speed (AD-099)
    const firstPair = new Map<string, number>()
    let checked = 0
    for (let t = 0; t < FIFTEEN_MIN; t += TICK_MS) {
      sim.tick()
      const now = sim.engine.getState().timeMs
      if (now % 10_000 !== 0) continue
      const readings = sim.readings()
      for (const id of monitored) {
        const r = readings[id]
        expect(['aprendendo', 'sem dado'], `${id} at ${now}`).not.toContain(r.nivel)
        if (!firstPair.has(id) && sim.capacity.fusion.state()[id].pares) firstPair.set(id, now)
        if (!firstPair.has(id)) continue
        expect(r.velocidade, `${id} at ${now}`).not.toBeNull()
        expect(r.fluxo, `${id} at ${now}`).not.toBeNull()
        expect(r.densidade, `${id} at ${now}`).not.toBeNull()
        expect(['aprendendo', 'sem dado'], `${id} at ${now}`).not.toContain(r.nivel)
        checked += 1
      }
    }
    expect(firstPair.size).toBe(12)
    expect(checked).toBeGreaterThan(12 * 80)
    // about 2 cars/min on each monitored segment
    const perMinute = exits / monitored.length / 15
    expect(perMinute).toBeGreaterThan(1.5)
    expect(perMinute).toBeLessThan(2.5)
  })
})
