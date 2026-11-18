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
    it('starts after 2 congested windows towards the route with the most slack and waits 30 s between changes', () => {
      const c = new DiversionController()
      const routes = (centralEstado: RouteStatus, v: number | null) => ({
        central: view(centralEstado, v, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 400 }),
        sul: view('fluindo', 47, { capacidade: 1100, folga: 700 }),
      })
      expect(c.evaluate(10_000, routes('congestionado', 10), demand).status).toBe('inativo')
      const on = c.evaluate(20_000, routes('congestionado', 10), demand)
      expect(on).toMatchObject({ status: 'ativo', from: 'central', to: 'sul' })
      // recovered right away, but the 30 s since the last change are not over yet
      expect(c.evaluate(30_000, routes('fluindo', 45), demand).status).toBe('ativo')
      expect(c.evaluate(40_000, routes('fluindo', 45), demand).status).toBe('ativo')
      expect(c.evaluate(50_000, routes('fluindo', 45), demand).status).toBe('inativo')
      // and it cannot come back within 30 s of stopping
      c.evaluate(60_000, routes('congestionado', 10), demand)
      expect(c.evaluate(70_000, routes('congestionado', 10), demand).status).toBe('inativo')
      expect(c.evaluate(80_000, routes('congestionado', 10), demand).status).toBe('ativo')
      // a single congested window is not enough
      const once = new DiversionController()
      once.evaluate(10_000, routes('congestionado', 10), demand)
      expect(once.evaluate(20_000, routes('carregado', 30), demand).status).toBe('inativo')
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
      c.evaluate(10_000, r, demand)
      expect(c.evaluate(20_000, r, demand)).toMatchObject({ status: 'ativo', to: 'norte', n: 480, p: 0.4 })
    })

    it('stops only after 2 windows at 35 km/h or more and holds between 25 and 35', () => {
      const c = new DiversionController()
      const r = (estado: RouteStatus, v: number) => ({
        central: view(estado, v, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      })
      c.evaluate(10_000, r('congestionado', 10), demand)
      c.evaluate(20_000, r('congestionado', 10), demand) // on at 20 s
      for (let t = 30_000; t <= 120_000; t += 10_000) {
        // carregado at 25-35 km/h: hysteresis holds the diversion
        expect(c.evaluate(t, r('carregado', t % 20_000 === 0 ? 34.9 : 25), demand).status).toBe('ativo')
      }
      expect(c.evaluate(130_000, r('fluindo', 35), demand).status).toBe('ativo') // 1 window
      expect(c.evaluate(140_000, r('carregado', 34), demand).status).toBe('ativo') // reset
      expect(c.evaluate(150_000, r('fluindo', 40), demand).status).toBe('ativo')
      expect(c.evaluate(160_000, r('fluindo', 36), demand).status).toBe('inativo')
    })

    it('does not divert without an alternative with slack', () => {
      const c = new DiversionController()
      const r = {
        central: view('congestionado', 5, { fluxo: 300 }),
        norte: view('fluindo', 48, { capacidade: null, folga: null }),
        sul: view('congestionado', 5, { capacidade: 900, folga: -50 }),
      }
      c.evaluate(10_000, r, demand)
      expect(c.evaluate(20_000, r, demand).status).toBe('sem-alternativa')
      expect(c.evaluate(30_000, r, demand).status).toBe('sem-alternativa')
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
      const run = (diversion: boolean) => {
        const sim = new Simulation({
          engine: new SimulationEngine({ ratePerMinute: 60, noisePct: 0 }),
          transport: new FakeTransport(true),
        })
        sim.setDiversionEnabled(diversion)
        sim.start()
        const times: number[] = []
        sim.engine.onArrival((a) => {
          if (a.atMs > 300_000 && a.atMs <= 600_000) times.push(a.travelS)
        })
        for (let t = 0; t < 600_000; t += TICK_MS) {
          if (sim.engine.getState().timeMs === 300_000) sim.engine.addBlockage('central', 400)
          sim.tick()
        }
        sim.stop()
        return { mean: times.reduce((a, b) => a + b, 0) / times.length, n: times.length, diverted: sim.engine.getState().divertedTotal }
      }
      const off = run(false)
      const on = run(true)
      expect(off.diverted).toBe(0)
      expect(on.diverted).toBeGreaterThan(0)
      expect(on.mean).toBeLessThan(off.mean)
    })
  })
})
