import { describe, expect, it } from 'vitest'
import type { RouteStatus } from '../capacity/CapacityModel'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { DiversionController, diversionSize, type RouteView } from './DiversionController'
import { Simulation } from './Simulation'

const view = (estado: RouteStatus, velocidade: number | null, extra: Partial<RouteView> = {}): RouteView => ({
  estado,
  velocidade,
  fluxo: 0,
  capacidade: null,
  folga: null,
  ...extra,
})
const demand = { central: 1200, norte: 1200, sul: 1200 }

describe('decision', () => {
  describe('DiversionController', () => {
    /** Feeds `windows` windows (10 s apart, from `from` ms) and returns the last state. */
    const feed = (c: DiversionController, routes: Record<string, RouteView>, from: number, windows: number) => {
      let last = c.evaluate(from, routes, demand)
      for (let i = 1; i < windows; i++) last = c.evaluate(from + i * 10_000, routes, demand)
      return last
    }

    it('starts after 5 congested windows towards the route with the most slack and waits 30 s between changes', () => {
      const c = new DiversionController()
      const routes = (centralEstado: RouteStatus, v: number | null) => ({
        central: view(centralEstado, v, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 400 }),
        sul: view('fluindo', 47, { capacidade: 1100, folga: 700 }),
      })
      // 4 congested windows (40 s, less than a 43 s light cycle) are not enough
      expect(feed(c, routes('congestionado', 10), 10_000, 4).status).toBe('inativo')
      const on = c.evaluate(50_000, routes('congestionado', 10), demand)
      expect(on).toMatchObject({ status: 'ativo', from: 'central', to: 'sul' })
      // recovered right away, but the 30 s since the last change are not over yet
      expect(c.evaluate(60_000, routes('fluindo', 45), demand).status).toBe('ativo')
      expect(c.evaluate(70_000, routes('fluindo', 45), demand).status).toBe('ativo')
      expect(c.evaluate(80_000, routes('fluindo', 45), demand).status).toBe('inativo')
      // after stopping it needs 5 congested windows again, and 30 s since the stop
      expect(feed(c, routes('congestionado', 10), 90_000, 4).status).toBe('inativo')
      expect(c.evaluate(130_000, routes('congestionado', 10), demand).status).toBe('ativo')
      // a red-light queue: congested windows interrupted by a green never reach 5 in a row
      const lights = new DiversionController()
      for (let t = 10_000; t <= 300_000; t += 10_000) {
        const congested = Math.floor(t / 10_000) % 5 !== 0 // 4 congested, then 1 flowing
        expect(lights.evaluate(t, routes(congested ? 'congestionado' : 'fluindo', congested ? 10 : 45), demand).status).toBe('inativo')
      }
    })

    it('computes N and p from excess and slack with the 0.8 factor and the 50 percent cap', () => {
      expect(diversionSize(1200, 300, 600)).toEqual({ n: 480, p: 0.4 })
      expect(diversionSize(1200, 300, 2000)).toEqual({ n: 900, p: 0.5 })
      expect(diversionSize(1200, 1200, 600)).toEqual({ n: 0, p: 0 })
      expect(diversionSize(1200, 1500, 600)).toEqual({ n: 0, p: 0 })
      expect(diversionSize(0, 0, 600)).toEqual({ n: 0, p: 0 })
      // the controller uses it with A's demand and flow and B's slack
      const c = new DiversionController()
      const r = {
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      }
      expect(feed(c, r, 10_000, 5)).toMatchObject({ status: 'ativo', to: 'norte', n: 480, p: 0.4 })
    })

    it('stops only after 2 windows at 35 km/h or more and holds between 25 and 35', () => {
      const c = new DiversionController()
      const r = (estado: RouteStatus, v: number) => ({
        central: view(estado, v, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      })
      expect(feed(c, r('congestionado', 10), 10_000, 5).status).toBe('ativo') // on at 50 s
      for (let t = 60_000; t <= 150_000; t += 10_000) {
        // carregado at 25-35 km/h: hysteresis holds the diversion
        expect(c.evaluate(t, r('carregado', t % 20_000 === 0 ? 34.9 : 25), demand).status).toBe('ativo')
      }
      expect(c.evaluate(160_000, r('fluindo', 35), demand).status).toBe('ativo') // 1 window at exactly 35
      expect(c.evaluate(170_000, r('carregado', 34.9), demand).status).toBe('ativo') // reset
      expect(c.evaluate(180_000, r('fluindo', 35), demand).status).toBe('ativo')
      // exactly 35 km/h counts as recovered: two windows at 35 stop it
      expect(c.evaluate(190_000, r('fluindo', 35), demand).status).toBe('inativo')
    })

    it('never picks a congested route as B and stops when B becomes congested', () => {
      // the blocked central has almost no flow, so it shows the most slack - it must not be B
      const c = new DiversionController()
      const r = {
        sul: view('congestionado', 3, { fluxo: 200, capacidade: 900, folga: 700 }),
        central: view('congestionado', 0, { fluxo: 0, capacidade: 1300, folga: 1300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 400 }),
      }
      expect(feed(c, r, 10_000, 5)).toMatchObject({ status: 'ativo', to: 'norte' })

      // 'sem dados' is not an alternative either
      const blind = new DiversionController()
      const rb = {
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view('sem dados', null, { capacidade: 1000, folga: 900 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      }
      expect(feed(blind, rb, 10_000, 5)).toMatchObject({ status: 'ativo', to: 'sul' })

      // a route congested only for a red light (fewer than 5 windows) still counts as B
      const flicker = new DiversionController()
      const rf = (t: number) => ({
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view(t % 20_000 === 0 ? 'congestionado' : 'fluindo', 30, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      })
      let st = flicker.evaluate(10_000, rf(10_000), demand)
      for (let t = 20_000; t <= 50_000; t += 10_000) st = flicker.evaluate(t, rf(t), demand)
      expect(st).toMatchObject({ status: 'ativo', to: 'norte' })
      for (let t = 60_000; t <= 120_000; t += 10_000) expect(flicker.evaluate(t, rf(t), demand).status).toBe('ativo')

      // B jammed (5 windows) while active: the diversion stops in that window, 30 s rule or not
      const c2 = new DiversionController()
      const base = {
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      }
      expect(feed(c2, base, 10_000, 5)).toMatchObject({ status: 'ativo', to: 'norte' })
      const bJammed = { ...base, norte: view('congestionado', 10, { capacidade: 1000, folga: 800 }) }
      // 4 jammed windows: holds; the 5th, 40 s after activation... and also within 30 s of it below
      expect(feed(c2, bJammed, 60_000, 4).status).toBe('ativo')
      expect(c2.evaluate(100_000, bJammed, demand).status).not.toBe('ativo')
      const quick = new DiversionController()
      feed(quick, { ...base, norte: view('congestionado', 10, { capacidade: 1000, folga: 800 }) }, 10_000, 4)
      // norte was jammed 4 windows before activation, so it is not B: sul is
      expect(quick.evaluate(50_000, { ...base, norte: view('congestionado', 10, { capacidade: 1000, folga: 800 }) }, demand)).toMatchObject({ to: 'sul' })
    })

    it('does not divert without an alternative with slack', () => {
      const c = new DiversionController()
      const r = {
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: null, folga: null }),
        sul: view('fluindo', 45, { capacidade: 900, folga: -50 }),
      }
      expect(feed(c, r, 10_000, 5).status).toBe('sem-alternativa')
      expect(c.evaluate(60_000, r, demand).status).toBe('sem-alternativa')
    })
  })

  describe('scenario', () => {
    it('a blockage inside D2 turns the central route congested within 60 s', () => {
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 60, noisePct: 0 }), transport: new FakeTransport(true) })
      sim.start()
      sim.engine.addBlockage('central', 400)
      for (let t = 0; t < 60_000; t += TICK_MS) sim.tick()
      expect(sim.capacity.snapshot().central.estado).toBe('congestionado')
      sim.stop()
    })

    it('partial diversion lowers mean travel time after an accident', { timeout: 120_000 }, () => {
      // 15 cars/min: below the ~15-17 cars/min the arrival junction can take (AD-019)
      const run = (diversion: boolean) => {
        const sim = new Simulation({
          engine: new SimulationEngine({ ratePerMinute: 15, noisePct: 0 }),
          transport: new FakeTransport(true),
        })
        sim.setDiversionEnabled(diversion)
        sim.start()
        const times: number[] = []
        let divertedBefore = 0
        sim.engine.onArrival((a) => {
          if (a.atMs > 300_000 && a.atMs <= 600_000) times.push(a.travelS)
        })
        for (let t = 0; t < 600_000; t += TICK_MS) {
          if (sim.engine.getState().timeMs === 300_000) {
            divertedBefore = sim.engine.getState().divertedTotal
            sim.engine.addBlockage('central', 400)
          }
          sim.tick()
        }
        sim.stop()
        const s = sim.engine.getState()
        return { mean: times.reduce((a, b) => a + b, 0) / times.length, divertedAfter: s.divertedTotal - divertedBefore, divertedBefore }
      }
      const off = run(false)
      const on = run(true)
      expect(off.divertedAfter).toBe(0)
      // no diversion before the accident (no false alarm), cars diverted after it
      expect(on.divertedBefore).toBe(0)
      expect(on.divertedAfter).toBeGreaterThan(0)
      expect(on.mean).toBeLessThanOrEqual(off.mean * 0.95)
    })
  })
})
