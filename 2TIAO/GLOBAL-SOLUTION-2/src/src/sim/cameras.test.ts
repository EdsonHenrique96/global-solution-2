import { describe, expect, it } from 'vitest'
import { SimulationEngine } from './SimulationEngine'

describe('sim', () => {
  describe('cameras', () => {
    it('clamps heading FOV and range to their limits', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      const c2 = () => engine.getState().cameras.find((c) => c.id === 'C2')!
      engine.updateCamera('C2', { heading: 360 })
      expect(c2().heading).toBe(0)
      engine.updateCamera('C2', { heading: -10 })
      expect(c2().heading).toBe(350)
      engine.updateCamera('C2', { heading: 725 })
      expect(c2().heading).toBe(5)
      engine.updateCamera('C2', { fov: 5 })
      expect(c2().fov).toBe(10)
      engine.updateCamera('C2', { fov: 200 })
      expect(c2().fov).toBe(170)
      engine.updateCamera('C2', { range: 1 })
      expect(c2().range).toBe(20)
      engine.updateCamera('C2', { range: 9000 })
      expect(c2().range).toBe(500)
      engine.updateCamera('C2', { range: Number.NaN })
      expect(c2().range).toBe(500) // not a number: keeps the last value
      // valid values pass through
      engine.updateCamera('C2', { heading: 45, fov: 60, range: 200 })
      expect(c2()).toMatchObject({ heading: 45, fov: 60, range: 200 })
    })
  })
})
