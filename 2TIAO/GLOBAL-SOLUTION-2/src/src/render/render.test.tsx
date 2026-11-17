import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SimulationEngine } from '../sim/SimulationEngine'
import { SimulationCanvas } from './SimulationCanvas'

interface Call {
  op: string
  args: number[]
}

/** A 2D context that records every drawing call instead of painting. */
function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = {}
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args: number[]) => {
        calls.push({ op: String(key), args })
        if (key === 'measureText') return { width: 10 }
        return undefined
      }
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

let calls: Call[] = []
let size = { width: 800, height: 500 }

beforeEach(() => {
  calls = []
  size = { width: 800, height: 500 }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => recordingContext(calls) as never,
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Calls of the most recent full frame (each frame starts by clearing the canvas). */
function lastFrame(): Call[] {
  const start = calls.map((c) => c.op).lastIndexOf('clearRect')
  return start === -1 ? [] : calls.slice(start)
}

/** Polylines that were stroked, as lists of points. */
function strokedPolylines(frame: Call[]): [number, number][][] {
  const lines: [number, number][][] = []
  let current: [number, number][] = []
  for (const { op, args } of frame) {
    if (op === 'beginPath') current = []
    else if (op === 'moveTo' || op === 'lineTo') current.push([args[0], args[1]])
    else if (op === 'stroke' && current.length >= 2) lines.push(current)
  }
  return lines
}

function distinct<T>(items: T[]): T[] {
  const seen = new Map(items.map((i) => [JSON.stringify(i), i]))
  return [...seen.values()]
}

describe('render', () => {
  describe('SimulationCanvas', () => {
    it('draws the fixed mesh with 4 intersections', () => {
      render(<SimulationCanvas engine={new SimulationEngine({ ratePerMinute: 0 })} />)
      const frame = lastFrame()
      expect(frame.length).toBeGreaterThan(0)

      const routes = distinct(strokedPolylines(frame))
      expect(routes.length).toBeGreaterThanOrEqual(2)
      expect(routes.length).toBeLessThanOrEqual(3)
      // all routes share one origin and one destination, and they are different points
      const origins = distinct(routes.map((r) => r[0]))
      const destinations = distinct(routes.map((r) => r[r.length - 1]))
      expect(origins).toHaveLength(1)
      expect(destinations).toHaveLength(1)
      expect(origins[0]).not.toEqual(destinations[0])

      const intersections = distinct(
        frame.filter((c) => c.op === 'arc').map((c) => [c.args[0], c.args[1]]),
      )
      expect(intersections).toHaveLength(4)
    })

    it('resizes canvas to container on window resize', () => {
      const { container } = render(
        <SimulationCanvas engine={new SimulationEngine({ ratePerMinute: 0 })} />,
      )
      const canvas = container.querySelector('canvas')!
      expect(canvas.width).toBe(800)
      expect(canvas.height).toBe(500)

      for (const next of [
        { width: 1200, height: 300 },
        { width: 360, height: 640 },
      ]) {
        size = next
        calls.length = 0
        act(() => {
          window.dispatchEvent(new Event('resize'))
        })
        expect(canvas.width).toBe(next.width)
        expect(canvas.height).toBe(next.height)

        const frame = lastFrame()
        const routes = distinct(strokedPolylines(frame))
        expect(routes.length).toBeGreaterThanOrEqual(2)
        const points: [number, number, number][] = [
          ...routes.flat().map(([x, y]): [number, number, number] => [x, y, 0]),
          ...frame
            .filter((c) => c.op === 'arc')
            .map((c): [number, number, number] => [c.args[0], c.args[1], c.args[2]]),
        ]
        for (const [x, y, r] of points) {
          expect(x - r).toBeGreaterThanOrEqual(0)
          expect(x + r).toBeLessThanOrEqual(next.width)
          expect(y - r).toBeGreaterThanOrEqual(0)
          expect(y + r).toBeLessThanOrEqual(next.height)
        }
      }
    })
  })

  describe('VolumeControl', () => {
    it('applies new spawn rate within 1 second of input', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} />)
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(engine.getState().spawnedTotal).toBe(0)

      const slider = screen.getByRole('slider', { name: /carros por minuto/i })
      fireEvent.change(slider, { target: { value: '120' } })
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      expect(engine.getRate()).toBe(120)
      // 120 cars/min over 1 s = 2 cars
      expect(engine.getState().spawnedTotal).toBe(2)
      expect(slider).toHaveValue('120')
    })
  })

  describe('App', () => {
    it('starts with a default spawn rate greater than zero', () => {
      vi.useFakeTimers()
      render(<App />)
      const slider = screen.getByRole('slider', { name: /carros por minuto/i })
      expect(Number((slider as HTMLInputElement).value)).toBeGreaterThan(0)

      act(() => {
        vi.advanceTimersByTime(5000)
      })
      const spawned = Number(screen.getByTestId('spawned-total').textContent)
      expect(spawned).toBeGreaterThan(0)
    })
  })
})
