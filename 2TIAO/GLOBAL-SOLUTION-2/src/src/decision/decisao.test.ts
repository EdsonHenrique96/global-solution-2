import { describe, expect, it, vi } from 'vitest'
import type { RouteStatus } from '../capacity/CapacityModel'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { DiversionController, diversionSize, type DiversionState, type RouteView } from './DiversionController'
import { coverageWarning, routeConfidence, routeDemand, Simulation } from './Simulation'

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
      // B jams 10 s after activation: the diversion stops in that window, without the 30 s wait
      const soon = new DiversionController()
      const rs = (t: number) => ({
        central: view('congestionado', 5, { fluxo: 300 }),
        // norte congested from 20 s on: 4 windows at 50 s (still a valid B), 5 at 60 s (jammed)
        norte: view(t >= 20_000 ? 'congestionado' : 'fluindo', 20, { capacidade: 1000, folga: 600 }),
        sul: view('fluindo', 48, { capacidade: 1000, folga: 100 }),
      })
      for (let t = 10_000; t <= 40_000; t += 10_000) soon.evaluate(t, rs(t), demand)
      expect(soon.evaluate(50_000, rs(50_000), demand)).toMatchObject({ status: 'ativo', to: 'norte' })
      expect(soon.evaluate(60_000, rs(60_000), demand).status).toBe('inativo')

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
    it('a blockage inside C2 turns central I1-I2 congested within 60 s', () => {
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 60, noisePct: 0 }), transport: new FakeTransport(true) })
      sim.start()
      // C2 sees roughly x 463-678 of the central road; 500 m along central is x = 560
      sim.engine.addBlockage('central', 500)
      for (let t = 0; t < 60_000; t += TICK_MS) sim.tick()
      expect(sim.capacity.snapshot()['central-I1-I2'].estado).toBe('congestionado')
      // and the route view the diversion reads shows it
      expect(sim.capacity.routes().central.estado).toBe('congestionado')
      sim.stop()
    })

    it('the accident scenario diverts only after the accident and records travel time with and without diversion', { timeout: 120_000 }, () => {
      // 15 cars/min: below the ~15-17 cars/min the arrival junction can take (AD-019, AD-020)
      const run = (diversion: boolean) => {
        const sim = new Simulation({
          engine: new SimulationEngine({ ratePerMinute: 15, noisePct: 0 }),
          transport: new FakeTransport(true),
        })
        sim.setDiversionEnabled(diversion)
        sim.start()
        const times: number[] = []
        let divertedBefore = 0
        let activeBefore = false
        let activeFromCentralAfter = false
        sim.engine.onArrival((a) => {
          if (a.atMs > 300_000 && a.atMs <= 600_000) times.push(a.travelS)
        })
        for (let t = 0; t < 600_000; t += TICK_MS) {
          const now = sim.engine.getState().timeMs
          if (now === 300_000) {
            divertedBefore = sim.engine.getState().divertedTotal
            // inside C2's view (x 560); a blockage in a blind spot is not seen without drones (AD-021)
            sim.engine.addBlockage('central', 500)
          }
          sim.tick()
          const d = sim.diversion
          if (d.status === 'ativo') {
            if (now < 300_000) activeBefore = true
            else if (d.from === 'central') activeFromCentralAfter = true
          }
        }
        sim.stop()
        return { mean: times.reduce((x, y) => x + y, 0) / times.length, divertedBefore, activeBefore, activeFromCentralAfter }
      }
      const off = run(false)
      const on = run(true)
      // the result the scenario records (AD-020)
      console.info(`scenario: mean travel ${off.mean.toFixed(1)} s without diversion, ${on.mean.toFixed(1)} s with`)
      expect(on.activeBefore).toBe(false)
      expect(on.divertedBefore).toBe(0)
      expect(on.activeFromCentralAfter).toBe(true)
      expect(on.mean).toBeLessThanOrEqual(off.mean * 1.01)
    })
  })

  describe('fusion', () => {
    it('uses OD demand for the diversion and N 0 without it', () => {
      const run = (rate: number, until: number) => {
        const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: rate, noisePct: 0 }), transport: new FakeTransport(true) })
        sim.start()
        for (let t = 0; t < until; t += TICK_MS) sim.tick()
        sim.stop()
        return sim
      }
      // before the first 60 s window there is no OD demand
      expect(run(15, 50_000).demand()).toEqual({ central: 0, norte: 0, sul: 0 })
      // 15 trips per minute -> 900 veh/h, a third per route
      const d = run(15, 60_000).demand()
      for (const id of ['central', 'norte', 'sul']) expect(d[id]).toBeCloseTo(300, 6)
      // 4 trips per minute: the OD cell is dropped (fewer than 5), demand unknown -> 0
      expect(run(4, 120_000).demand()).toEqual({ central: 0, norte: 0, sul: 0 })
      // the generator rate is not what the diversion reads: a pure function over the fused state
      const segs = run(15, 60_000).capacity.segments
      const fused = Object.fromEntries(segs.map((x) => [x.id, { demandaOD: x.id === 'norte-F-I3' ? 123 : null } as never]))
      expect(routeDemand(['central', 'norte'], fused, segs)).toEqual({ central: 0, norte: 123 })
      // with demand 0 the controller sizes N 0
      expect(diversionSize(0, 0, 900)).toEqual({ n: 0, p: 0 })

      // decide() hands the controller the OD demand, not the generator's share: the generator runs
      // at 15 cars/min (300 veh/h per route) while the OD matrix says 60 trips/min (1200 per route)
      const seenDemand: Record<string, number>[] = []
      const spy = vi.spyOn(DiversionController.prototype, 'evaluate').mockImplementation(function (this: DiversionController, _t, _r, d) {
        seenDemand.push({ ...d })
        return { status: 'inativo' }
      })
      const transport = new FakeTransport(true)
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 15, noisePct: 0 }), transport })
      sim.start()
      for (let t = 0; t < 70_000; t += TICK_MS) {
        sim.tick()
        if (sim.engine.getState().timeMs === 60_000) {
          // the operator's feed for this window (a stand-in for a different real demand)
          transport.deliver('transito/demanda/od', JSON.stringify({ ts: 60_000, janelaS: 60, celulas: [{ origem: 'oeste', destino: 'leste', viagens: 60 }] }))
        }
      }
      sim.stop()
      spy.mockRestore()
      expect(seenDemand[0]).toEqual({ central: 0, norte: 0, sul: 0 }) // 10 s: no OD window yet
      const last = seenDemand[seenDemand.length - 1]
      for (const id of ['central', 'norte', 'sul']) expect(last[id]).toBeCloseTo(1200, 6)

      // no valid OD cell: the controller, given that demand, sizes the active diversion with N 0
      const c = new DiversionController()
      const routes = {
        central: { estado: 'congestionado' as const, velocidade: 5, fluxo: 100, capacidade: null, folga: null },
        norte: { estado: 'fluindo' as const, velocidade: 48, fluxo: 100, capacidade: 1000, folga: 800 },
        sul: { estado: 'fluindo' as const, velocidade: 48, fluxo: 100, capacidade: 1000, folga: 200 },
      }
      let st = c.evaluate(10_000, routes, { central: 0, norte: 0, sul: 0 })
      for (let t = 20_000; t <= 50_000; t += 10_000) st = c.evaluate(t, routes, { central: 0, norte: 0, sul: 0 })
      expect(st).toMatchObject({ status: 'ativo', from: 'central', to: 'norte', n: 0, p: 0 })
    })

    it('reports the confidence of the alternative route and warns below 0.8', () => {
      const segs = new Simulation({ transport: new FakeTransport(true) }).capacity.segments
      const fusedWith = (c: number) => Object.fromEntries(segs.map((x) => [x.id, { confianca: c } as never]))
      expect(routeConfidence('norte', fusedWith(1), segs)).toBe(1)
      const partial = { ...fusedWith(1), 'norte-F-I3': { confianca: 0.5 } as never }
      expect(routeConfidence('norte', partial, segs)).toBe(0.5)
      expect(routeConfidence('central', partial, segs)).toBe(1)
      const missing = Object.fromEntries(Object.entries(fusedWith(1)).filter(([id]) => id !== 'norte-F-I3'))
      expect(routeConfidence('norte', missing, segs)).toBe(0)
      // the warning threshold is 0.8: 0.79 warns, 0.8 does not
      expect(coverageWarning(0.79)).toBe('rota alternativa com trechos sem cobertura')
      expect(coverageWarning(0.8)).toBeNull()
      expect(coverageWarning(1)).toBeNull()
      expect(coverageWarning(0)).toBe('rota alternativa com trechos sem cobertura')

      // in the accident scenario B has uncovered segments: confidence 0 and the warning
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 15, noisePct: 0 }), transport: new FakeTransport(true) })
      sim.start()
      let seen: Extract<DiversionState, { status: 'ativo' }> | null = null
      for (let t = 0; t < 600_000; t += TICK_MS) {
        if (sim.engine.getState().timeMs === 300_000) sim.engine.addBlockage('central', 500)
        sim.tick()
        if (sim.diversion.status === 'ativo' && !seen) seen = sim.diversion
      }
      sim.stop()
      expect(seen).not.toBeNull()
      expect(seen!.confianca).toBe(0)
      expect(seen!.aviso).toBe('rota alternativa com trechos sem cobertura')
    })
  })
})
