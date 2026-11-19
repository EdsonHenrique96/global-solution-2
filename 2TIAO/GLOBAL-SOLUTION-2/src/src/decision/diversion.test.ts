import { describe, expect, it } from 'vitest'
import { ruleClassifier, type Nivel } from '../capacity/SegmentClassifier'
import { DiversionController, type RouteView } from './DiversionController'

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
