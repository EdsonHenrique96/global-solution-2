import { describe, expect, it } from 'vitest'
import { kmeansFixture, REAL_CENTROIDS } from './kmeansFixture'
import { ruleClassifier } from './SegmentClassifier'
import { StateClassifier } from './StateClassifier'

/** A reading in the panel's units: speed km/h, flow cars/min (veh/h in the input), density veh/km. */
const reading = (v: number | null, fMin: number, d: number) => ({ velocidade: v, fluxo: fMin * 60, densidade: d, capacidade: 844 })

describe('StateClassifier', () => {
  it('C27 gives the level of the nearest centroid and the slower one on a tie', async () => {
    const c = new StateClassifier()
    // no model yet: the rule
    for (const r of [reading(10, 2, 30), reading(40, 14, 20), reading(40, 2, 10)]) expect(c.classify(r)).toBe(ruleClassifier.classify(r))
    expect(c.nome).toBe(ruleClassifier.nome)
    expect(await c.load(async () => kmeansFixture())).toBe(true)
    expect(c.nome).toMatch(/^K-means/)
    // a reading equal to a centroid gets its level
    for (const [nivel, [v, f, d]] of Object.entries(REAL_CENTROIDS)) expect(c.classify(reading(v, f, d))).toBe(nivel)
    // nearest in the standardized space, not in raw units: 20 km/h, 2 cars/min, 60 veh/km is critico
    expect(c.classify(reading(20, 2, 60))).toBe('critico')
    // the rule would call it Livre (20 km/h, 120 of 844 veh/h)
    expect(ruleClassifier.classify(reading(20, 2, 60))).toBe('livre')
    // halfway between moderado and intenso: the slower, intenso
    const [m, i] = [REAL_CENTROIDS.moderado, REAL_CENTROIDS.intenso]
    const mid = m.map((x, k) => (x + i[k]) / 2) as [number, number, number]
    expect(c.classify(reading(...mid))).toBe('intenso')
    // halfway between livre and moderado: moderado
    const [l] = [REAL_CENTROIDS.livre]
    expect(c.classify(reading(...(l.map((x, k) => (x + m[k]) / 2) as [number, number, number])))).toBe('moderado')
    // a segment without a pair speed is an empty road: 50 km/h
    expect(c.classify(reading(null, 3, 8))).toBe(c.classify(reading(50, 3, 8)))
    expect(c.classify(reading(null, 6, 70))).toBe(c.classify(reading(50, 6, 70)))
    // a model that is not door 7 is refused and the rule stays
    const other = new StateClassifier()
    expect(other.use({ ...kmeansFixture(), centroides: kmeansFixture().centroides.slice(0, 3) })).toBe(false)
    expect(await other.load(async () => Promise.reject(new Error('503')))).toBe(false)
    expect(other.model).toBeNull()
    expect(other.classify(reading(20, 2, 60))).toBe('livre')
  })
})
