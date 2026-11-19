import { describe, expect, it } from 'vitest'
import { kmeansFixture } from '../capacity/kmeansFixture'
import { ruleClassifier, type SegmentClassifier } from '../capacity/SegmentClassifier'
import { StateClassifier } from '../capacity/StateClassifier'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { FRACOES, type DiversionSimulation } from './simulateDiversion'
import { Simulation } from './Simulation'

const stub = (_sim: Simulation, trecho: string): DiversionSimulation => ({
  trecho,
  horizonteMin: 10,
  fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: 80, ocupacaoMaxAlternativa: 40, tempoMedioS: 90, co2Kg: 1 })),
  escolhida: 0.2,
  eficaz: true,
})

/** The level and the diversion after one 10 s recompute with `id` at speed `v`, `fMin` cars/min and `k` veh/km. */
function recompute(classifier: SegmentClassifier, id: string, v: number, fMin: number, k: number) {
  const transport = new FakeTransport(true)
  const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0, cameras: [] }), transport, classifier, simulateDiversion: stub })
  sim.start()
  for (let t = 0; t < 9_900; t += TICK_MS) sim.tick()
  deliverMetrics(transport, id, sim.engine.getState().timeMs, { k, v, fluxoVeicMin: fMin })
  sim.tick()
  return { nivel: sim.readings()[id].nivel, diversion: sim.diversion }
}

describe('diversion', () => {
  it('C29 the diversion follows the K-means level', () => {
    const kmeans = new StateClassifier()
    expect(kmeans.use(kmeansFixture())).toBe(true)
    // 20 km/h, 2 cars/min, 60 veh/km: K-means Crítico, the rule Livre
    expect(recompute(ruleClassifier, 'I12>I13', 20, 2, 60)).toEqual({ nivel: 'livre', diversion: { status: 'inativo' } })
    const byKMeans = recompute(kmeans, 'I12>I13', 20, 2, 60)
    expect(byKMeans.nivel).toBe('critico')
    expect(byKMeans.diversion).toMatchObject({ status: 'ativo', trecho: 'I12>I13', p: 0.2 })
    // 10 km/h, 3 cars/min, 8 veh/km: the rule Crítico (below 15 km/h), K-means Moderado
    expect(recompute(ruleClassifier, 'I22>I23', 10, 3, 8).diversion).toMatchObject({ status: 'ativo', trecho: 'I22>I23' })
    expect(recompute(kmeans, 'I22>I23', 10, 3, 8)).toEqual({ nivel: 'moderado', diversion: { status: 'inativo' } })
  })
})
