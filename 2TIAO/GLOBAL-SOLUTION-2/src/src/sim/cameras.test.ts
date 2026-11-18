import { describe, expect, it } from 'vitest'
import { SimulationEngine } from './SimulationEngine'

describe('sim', () => {
  describe('cameras', () => {
    it('clamps heading FOV and range to their limits', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      const u2 = () => engine.getState().cameras.find((c) => c.id === 'U02')!
      engine.updateCamera('U02', { heading: 360 })
      expect(u2().heading).toBe(0)
      engine.updateCamera('U02', { heading: -10 })
      expect(u2().heading).toBe(350)
      engine.updateCamera('U02', { heading: 725 })
      expect(u2().heading).toBe(5)
      engine.updateCamera('U02', { fov: 5 })
      expect(u2().fov).toBe(10)
      engine.updateCamera('U02', { fov: 200 })
      expect(u2().fov).toBe(170)
      engine.updateCamera('U02', { range: 1 })
      expect(u2().range).toBe(20)
      engine.updateCamera('U02', { range: 9000 })
      expect(u2().range).toBe(500)
      engine.updateCamera('U02', { range: Number.NaN })
      expect(u2().range).toBe(500) // not a number: keeps the last value
      // valid values pass through
      engine.updateCamera('U02', { heading: 45, fov: 60, range: 200 })
      expect(u2()).toMatchObject({ heading: 45, fov: 60, range: 200 })
    })
  })
})
