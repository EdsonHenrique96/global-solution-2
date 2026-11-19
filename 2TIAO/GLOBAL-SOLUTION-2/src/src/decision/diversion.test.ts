import { describe, expect, it } from 'vitest'
import { ruleClassifier, type Nivel } from '../capacity/SegmentClassifier'
import { eventsTopic } from '../sensors/PlateCamera'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { DiversionController, type RouteView } from './DiversionController'
import { Simulation } from './Simulation'

const view = (nivel: Nivel, velocidade: number | null = 40): RouteView => ({ nivel, velocidade, fluxo: 600, capacidade: 1800, folga: 1200 })

describe('diversion', () => {
  it('C33 diverts a segment in the recomputation it turns Crítico', () => {
    const c = new DiversionController()
    let t = 0
    const step = (segments: Record<string, RouteView>) => c.evaluate((t += 10_000), segments)
    expect(step({ A: view('intenso', 30), B: view('livre') })).toBeNull()
    // the first Crítico recomputation already diverts (AD-090)
    expect(step({ A: view('critico', 14), B: view('livre') })).toBe('A')

    // 20 km/h at pct 30 used to be "congestionado" (AD-006); by the one rule it is Livre and never diverts
    const slow = ruleClassifier.classify({ fluxo: 540, capacidade: 1800, velocidade: 20, densidade: 27 })
    expect(slow).toBe('livre')
    const other = new DiversionController()
    for (let i = 1; i <= 20; i++) expect(other.evaluate(i * 10_000, { S: view(slow, 20) })).toBeNull()

    // it ends after 2 recomputations in a row out of Crítico with data, at least 30 s after it started (AD-086)
    expect(step({ A: view('intenso', 40), B: view('livre') })).toBe('A')
    expect(step({ A: view('sem dado', null), B: view('livre') })).toBe('A')
    expect(step({ A: view('intenso', 40), B: view('livre') })).toBe('A')
    expect(step({ A: view('moderado', 40), B: view('livre') })).toBeNull()
  })
})

describe('diversion', () => {
  it('C33 the simulation diverts in the same recomputation the matcher turns a segment Crítico', () => {
    const transport = new FakeTransport(true)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0 }), transport })
    sim.start()
    const id = 'I12>I13'
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += TICK_MS) sim.tick()
    }
    run(30_000)
    // three cars crossed the segment in 20 s each (~10 km/h): the matcher sees them at its 40 s recomputation
    const event = (papel: 'entrada' | 'saida', hash: string, ts: number) =>
      transport.deliver(eventsTopic(id), JSON.stringify({ cameraId: papel === 'entrada' ? 'C02E' : 'C02S', trecho: id, papel, placaHash: hash, ts, faixa: 1, classe: 'carro' }))
    for (let i = 0; i < 3; i++) {
      event('entrada', `slow${i}`, 5_000 + i * 1_000)
      event('saida', `slow${i}`, 25_000 + i * 1_000)
    }
    run(9_900)
    expect(sim.engine.getState().timeMs).toBe(39_900)
    expect(sim.diversion.status).not.toBe('ativo')
    // one tick: the engine reaches 40 s, the matcher publishes, the fusion and the classifier read it,
    // and the decision of that same tick diverts (AD-090)
    sim.tick()
    expect(sim.engine.getState().timeMs).toBe(40_000)
    expect(sim.readings()[id]).toMatchObject({ nivel: 'critico' })
    expect(sim.readings()[id].velocidade!).toBeLessThan(15)
    expect(sim.diversion).toMatchObject({ status: 'ativo', trecho: id })
  })
})
