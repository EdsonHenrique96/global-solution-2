import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import type { Reading } from '../telemetry/DroneSensor'
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
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
      expect(engine.getState().cars.length).toBeGreaterThan(20)

      render(<SimulationCanvas engine={engine} />)
      const start = calls.map((c) => c.op).lastIndexOf('clearRect')
      const arcs = calls.slice(start).filter((c) => c.op === 'arc')
      // 4 traffic lights + 3 drone vision circles, nothing per car
      expect(arcs).toHaveLength(7)
      const centres = new Set(arcs.map((a) => `${a.args[0].toFixed(1)},${a.args[1].toFixed(1)}`))
      expect(centres.size).toBeLessThanOrEqual(7)
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
