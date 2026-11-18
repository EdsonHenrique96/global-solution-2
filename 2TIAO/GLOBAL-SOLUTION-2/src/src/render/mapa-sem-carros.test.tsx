import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import type { Reading } from '../sensors/reader'
import { FakeTransport } from '../telemetry/testing'
import { SimulationCanvas } from './SimulationCanvas'

interface Call {
  op: string
  args: number[]
}

let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const props: Record<string | symbol, unknown> = {}
    return new Proxy(props, {
      get(target, key) {
        if (key in target) return target[key]
        return (...args: number[]) => {
          calls.push({ op: String(key), args })
          return key === 'measureText' ? { width: 10 } : undefined
        }
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    }) as never
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 600)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('render', () => {
  describe('SimulationCanvas', () => {
    it('draws no car markers while cars are on the road', () => {
      // the same instant with an empty road and with a busy one: lights and drones are the same
      const frameOf = (ratePerMinute: number) => {
        const engine = new SimulationEngine({ ratePerMinute })
        for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
        calls = []
        const view = render(<SimulationCanvas engine={engine} />)
        const start = calls.map((c) => c.op).lastIndexOf('clearRect')
        const frame = calls.slice(start)
        view.unmount()
        return { frame, cars: engine.getState().cars.length }
      }
      const empty = frameOf(0)
      const busy = frameOf(120)
      expect(empty.cars).toBe(0)
      expect(busy.cars).toBeGreaterThan(20)

      // every drawing call, with its arguments, is identical: nothing on the map depends on the cars
      expect(busy.frame).toEqual(empty.frame)
      // and the frame is not trivially empty: 4 light circles and the 3 camera cones are there
      expect(busy.frame.filter((c) => c.op === 'arc')).toHaveLength(4)
      expect(busy.frame.filter((c) => c.op === 'closePath')).toHaveLength(3)
    })
  })

  describe('App', () => {
    it('keeps counting and sensing cars that are no longer drawn', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      const readings: Reading[] = []
      engine.onReading((r) => readings.push(r))
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(Number(screen.getByTestId('active-cars').textContent)).toBeGreaterThan(0)
      expect(readings.some((r) => r.contagem > 0)).toBe(true)
    })
  })
})
