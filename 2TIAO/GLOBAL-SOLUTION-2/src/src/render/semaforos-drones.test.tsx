import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { lightAt } from '../sim/trafficLight'
import { fitTransform } from './draw'
import type { PlateEvent } from '../sensors/PlateCamera'
import { FakeTransport } from '../telemetry/testing'
import { SimulationCanvas } from './SimulationCanvas'

interface Call {
  op: string
  args: unknown[]
  fillStyle: unknown
}

/** A 2D context that records each call together with the fill style in force at that moment. */
function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = {}
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: String(key), args, fillStyle: target.fillStyle })
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
const size = { width: 1000, height: 600 }

beforeEach(() => {
  calls = []
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

function lastFrame(): Call[] {
  const start = calls.map((c) => c.op).lastIndexOf('clearRect')
  return start === -1 ? [] : calls.slice(start)
}

/** Classifies a #rrggbb fill as the traffic-light colour a person would name. */
function hueOf(colour: unknown): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(colour))
  if (!m) return `not a hex colour: ${String(colour)}`
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  if (g > 120 && g > r * 1.3 && g > b * 1.3) return 'verde'
  if (r > 180 && g > 150 && b < 100 && Math.abs(r - g) < 80) return 'amarelo'
  if (r > 150 && r > g * 2 && r > b * 2) return 'vermelho'
  return `unclassified ${String(colour)}`
}

function advance(engine: SimulationEngine, ms: number) {
  for (let t = 0; t < ms; t += TICK_MS) engine.tick(TICK_MS)
}

describe('render', () => {
  describe('SimulationCanvas', () => {
    it('draws each traffic light phase in its colour at every corner', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const fit = fitTransform(engine.getState().network, size.width, size.height)
      const corners = engine.getState().network.intersections
      // along the alameda as drawn on the screen
      const h = (() => {
        const [a, b] = [fit.map(corners[0].position), fit.map(corners[1].position)]
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
      })()
      // the dot drawn nearest a point, and its fill
      const dotNear = (frame: Call[], x: number, y: number) => {
        let best = { d: Infinity, i: -1 }
        frame.forEach((k, i) => {
          if (k.op !== 'arc') return
          const d = Math.hypot((k.args[0] as number) - x, (k.args[1] as number) - y)
          if (d < best.d) best = { d, i }
        })
        return frame.slice(best.i).find((k) => k.op === 'fill')!.fillStyle
      }
      for (const t of [12_000, 30_000]) {
        advance(engine, t - engine.getState().timeMs)
        calls.length = 0
        const view = render(<SimulationCanvas engine={engine} />)
        const frame = lastFrame()
        for (const i of corners) {
          const c = fit.map(i.position)
          // the H dot sits on the alameda side of the corner, the V dot on the rua side
          const off = Math.max(8, 9 * fit.scale)
          const hFill = dotNear(frame, c.x - h.x * off, c.y - h.y * off)
          const l = lightAt(i.id, t)
          expect(hueOf(hFill), `${i.id} H at ${t}`).toBe(l.h)
          // the other dot of the corner shows the rua phase
          const both = frame.filter((k) => k.op === 'arc' && Math.hypot((k.args[0] as number) - c.x, (k.args[1] as number) - c.y) < off + 1)
          expect(both, i.id).toHaveLength(2)
          const fills = both.map((k) => frame.slice(frame.indexOf(k)).find((x) => x.op === 'fill')!.fillStyle)
          expect(fills.map(hueOf).sort()).toEqual([l.h, l.v].sort())
        }
        view.unmount()
      }
    })
  })

  describe('CameraEventsPanel', () => {
    it('shows MQTT desconectado and no new readings while disconnected and the simulation keeps running', { timeout: 60_000 }, () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(false)
      const engine = new SimulationEngine({ ratePerMinute: 60 })
      const produced: PlateEvent[] = []
      engine.onPlateEvent((e) => produced.push(e))
      render(<App engine={engine} transport={transport} />)
      fireEvent.click(screen.getByRole('link', { name: 'Câmeras' }))
      const panel = screen.getByRole('complementary', { name: 'Eventos das câmeras' })

      expect(within(panel).getByText('MQTT desconectado — tentando reconectar')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(25_000)
      })
      // simulation, lights and cameras keep going
      const state = engine.getState()
      expect(state.timeMs).toBe(25_000)
      expect(state.spawnedTotal).toBeGreaterThan(0)
      const i11 = state.lights.find((l) => l.intersectionId === 'I11')!
      expect([i11.h, i11.v]).toEqual([lightAt('I11', 25_000).h, lightAt('I11', 25_000).v])
      expect(produced.length).toBeGreaterThan(0)
      // but nothing reaches the panel
      expect(within(panel).queryAllByTestId('event-row')).toHaveLength(0)
      expect(within(panel).getByText('Nenhum evento recebido.')).toBeInTheDocument()

      // a connection that drops mid-run shows the warning again
      act(() => transport.setConnected(true))
      act(() => transport.setConnected(false))
      expect(within(panel).getByText('MQTT desconectado — tentando reconectar')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(within(panel).queryAllByTestId('event-row')).toHaveLength(0)
    })

    it('shows MQTT conectado and resumes readings when the connection returns', () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(false)
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      const produced: PlateEvent[] = []
      engine.onPlateEvent((e) => produced.push(e))
      render(<App engine={engine} transport={transport} />)
      fireEvent.click(screen.getByRole('link', { name: 'Câmeras' }))
      const panel = screen.getByRole('complementary', { name: 'Eventos das câmeras' })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(within(panel).queryAllByTestId('event-row')).toHaveLength(0)
      const before = produced.length

      act(() => transport.setConnected(true))
      expect(within(panel).getByText('MQTT conectado')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const resumed = produced.length - before
      expect(resumed).toBeGreaterThan(0)
      expect(within(panel).getAllByTestId('event-row')).toHaveLength(Math.min(20, resumed))
    })
  })
})
