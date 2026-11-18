import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { lightAt } from '../sim/trafficLight'
import { fitTransform } from './draw'
import type { Reading } from '../sensors/reader'
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
      const h = (() => {
        const [a, b] = [corners[0].position, corners[1].position]
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
          const off = Math.max(5, 7 * fit.scale)
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

  describe('NoiseControl', () => {
    it('next reading uses the new noise and carries ruidoPct', { timeout: 60_000 }, () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      const transport = new FakeTransport(true)
      render(<App engine={engine} transport={transport} />)

      const slider = screen.getByRole('slider', { name: /ruído da leitura/i })
      expect(slider).toHaveValue('10')
      expect(slider).toHaveAttribute('min', '0')
      expect(slider).toHaveAttribute('max', '30')

      // 40 s in, cars are already in front of the cameras
      act(() => {
        vi.advanceTimersByTime(40_000)
      })
      const readings = () => transport.published.filter((m) => m.topic.startsWith('transito/sensores/')).map((m) => JSON.parse(m.payload))
      const before = readings()
      expect(before).toHaveLength(4 * 12)
      for (const p of before) expect(p.ruidoPct).toBe(10)

      fireEvent.change(slider, { target: { value: '25' } })
      expect(engine.getNoise()).toBe(25)
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const after = readings().slice(4 * 12)
      expect(after).toHaveLength(12)
      for (const p of after) expect(p.ruidoPct).toBe(25)

      // The same deterministic run with the noise set to 25 at 40 s produces exactly these
      // readings; the run that stays at 10 does not.
      const replay = (noiseAfter: number) => {
        const twin = new SimulationEngine({ ratePerMinute: 120 })
        const out: unknown[] = []
        twin.onReading((r) => out.push(r))
        for (let t = 0; t < 40_000; t += TICK_MS) twin.tick(TICK_MS)
        twin.setNoise(noiseAfter)
        out.length = 0
        for (let t = 0; t < 10_000; t += TICK_MS) twin.tick(TICK_MS)
        return out
      }
      expect(after.some((p) => p.contagem > 0)).toBe(true)
      expect(after).toEqual(replay(25))
      expect(after).not.toEqual(replay(10).map((r) => ({ ...(r as object), ruidoPct: 25 })))
    })
  })

  describe('TelemetryPanel', () => {
    it('shows the latest reading per sensor and the last 20 messages newest first', () => {
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={transport} />)
      const panel = screen.getByRole('complementary', { name: /telemetria/i })
      expect(within(panel).getByText('MQTT conectado')).toBeInTheDocument()

      const send = (sensorId: string, ts: number, contagem: number, velocidadeMediaKmh: number | null) =>
        act(() => {
          transport.deliver(
            `transito/sensores/${sensorId}/telemetria`,
            JSON.stringify({ sensorId, tipo: 'camera+radar', ts, janelaS: 10, contagem, velocidadeMediaKmh, ruidoPct: 10, porTrecho: [] }),
          )
        })

      send('U01', 10_000, 3, 41.2)
      send('U02', 10_000, 0, null)
      send('U01', 20_000, 5, 22.5)
      expect(within(panel).getByTestId('sensor-U01-contagem')).toHaveTextContent('5')
      expect(within(panel).getByTestId('sensor-U01-velocidade')).toHaveTextContent('22.5')
      expect(within(panel).getByTestId('sensor-U02-contagem')).toHaveTextContent('0')
      expect(within(panel).getByTestId('sensor-U02-velocidade')).toHaveTextContent('—')

      for (let i = 0; i < 25; i++) send('U03', 30_000 + i, i, 50)
      const log = within(panel).getAllByTestId('telemetry-log-entry')
      expect(log).toHaveLength(20)
      expect(log[0]).toHaveTextContent('transito/sensores/U03/telemetria')
      expect(log[0]).toHaveTextContent('"contagem":24')
      expect(log[19]).toHaveTextContent('"contagem":5')
      expect(within(panel).getByTestId('sensor-U03-contagem')).toHaveTextContent('24')
    })

    it('shows MQTT desconectado and no new readings while disconnected and the simulation keeps running', { timeout: 60_000 }, () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(false)
      const engine = new SimulationEngine({ ratePerMinute: 60 })
      const produced: Reading[] = []
      engine.onReading((r) => produced.push(r))
      render(<App engine={engine} transport={transport} />)
      const panel = screen.getByRole('complementary', { name: /telemetria/i })

      expect(within(panel).getByText('MQTT desconectado — tentando reconectar')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(25_000)
      })
      // simulation, lights and sensors keep going
      const state = engine.getState()
      expect(state.timeMs).toBe(25_000)
      expect(state.spawnedTotal).toBeGreaterThan(0)
      const i11 = state.lights.find((l) => l.intersectionId === 'I11')!
      expect([i11.h, i11.v]).toEqual([lightAt('I11', 25_000).h, lightAt('I11', 25_000).v])
      expect(produced.length).toBe(2 * 12)
      // but nothing reaches the panel
      expect(within(panel).queryAllByTestId('telemetry-log-entry')).toHaveLength(0)
      expect(within(panel).getByTestId('sensor-U01-contagem')).toHaveTextContent('—')

      // a connection that drops mid-run shows the warning again
      act(() => transport.setConnected(true))
      act(() => transport.setConnected(false))
      expect(within(panel).getByText('MQTT desconectado — tentando reconectar')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(within(panel).queryAllByTestId('telemetry-log-entry')).toHaveLength(0)
    })

    it('shows MQTT conectado and resumes readings when the connection returns', () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(false)
      render(<App engine={new SimulationEngine({ ratePerMinute: 30 })} transport={transport} />)
      const panel = screen.getByRole('complementary', { name: /telemetria/i })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(within(panel).queryAllByTestId('telemetry-log-entry')).toHaveLength(0)

      act(() => transport.setConnected(true))
      expect(within(panel).getByText('MQTT conectado')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const log = within(panel).getAllByTestId('telemetry-log-entry')
      expect(log).toHaveLength(12)
      expect(within(panel).getByTestId('sensor-U01-contagem')).not.toHaveTextContent('—')
    })
  })
})
