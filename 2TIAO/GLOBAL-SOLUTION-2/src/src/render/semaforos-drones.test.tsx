import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { buildRoadNetwork } from '../sim/roadNetwork'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import type { Reading } from '../telemetry/DroneSensor'
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

/**
 * Network metres -> canvas pixels, recovered from the drawn central route
 * (origin (60,300) and destination (940,300) of the fixed mesh).
 */
function mapperFrom(frame: Call[]) {
  const lines: [number, number][][] = []
  let current: [number, number][] = []
  for (const { op, args } of frame) {
    if (op === 'beginPath') current = []
    else if (op === 'moveTo' || op === 'lineTo') current.push([args[0] as number, args[1] as number])
    else if (op === 'stroke' && current.length >= 2) lines.push(current)
  }
  const central = lines.find((l) => l.length === 4)!
  const [x0, y0] = central[0]
  const [x1] = central[central.length - 1]
  const scale = (x1 - x0) / (940 - 60)
  const map = (x: number, y: number) => ({ x: x0 + (x - 60) * scale, y: y0 + (y - 300) * scale })
  return { scale, map }
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol

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
    it('draws each traffic light in its phase colour with seconds remaining', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, drones: [] })
      // at 12 s: I1 verde 8 s, I2 amarelo 1 s, I3 verde 3 s, I4 vermelho 16 s
      advance(engine, 12_000)
      render(<SimulationCanvas engine={engine} />)
      const frame = lastFrame()
      const { map } = mapperFrom(frame)
      const intersections = buildRoadNetwork().intersections

      const colourAt: Record<string, unknown> = {}
      for (const { id, position } of intersections) {
        const c = map(position.x, position.y)
        const arcIndex = frame.findIndex(
          (k) => k.op === 'arc' && near(k.args[0] as number, c.x) && near(k.args[1] as number, c.y),
        )
        expect(arcIndex, `light ${id} drawn`).toBeGreaterThan(-1)
        const fill = frame.slice(arcIndex).find((k) => k.op === 'fill')!
        colourAt[id] = fill.fillStyle
        const label = frame.find(
          (k) =>
            k.op === 'fillText' &&
            Math.hypot((k.args[1] as number) - c.x, (k.args[2] as number) - c.y) < 40,
        )
        expect(label, `seconds next to ${id}`).toBeDefined()
        colourAt[`${id}-text`] = label!.args[0]
      }
      expect(colourAt['I1-text']).toBe('8s')
      expect(colourAt['I2-text']).toBe('1s')
      expect(colourAt['I3-text']).toBe('3s')
      expect(colourAt['I4-text']).toBe('16s')
      // each phase reads as its colour: verde green, amarelo yellow, vermelho red
      expect(hueOf(colourAt.I1)).toBe('verde')
      expect(hueOf(colourAt.I3)).toBe('verde')
      expect(hueOf(colourAt.I2)).toBe('amarelo')
      expect(hueOf(colourAt.I4)).toBe('vermelho')
      // same phase, same colour; three phases, three colours
      expect(colourAt.I1).toBe(colourAt.I3)
      expect(new Set([colourAt.I1, colourAt.I2, colourAt.I4]).size).toBe(3)

      // the colours follow the phase: at 22 s I1 is amarelo and I2 vermelho, with I2's old colour gone
      calls.length = 0
      advance(engine, 10_000)
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      const later = lastFrame()
      const fillAt = (x: number, y: number) => {
        const c = map(x, y)
        const i = later.findIndex(
          (k) => k.op === 'arc' && near(k.args[0] as number, c.x) && near(k.args[1] as number, c.y),
        )
        return later.slice(i).find((k) => k.op === 'fill')!.fillStyle
      }
      expect(fillAt(300, 300)).toBe(colourAt.I2) // I1 now amarelo
      expect(fillAt(700, 300)).toBe(colourAt.I4) // I2 now vermelho
      expect(hueOf(fillAt(300, 300))).toBe('amarelo')
      expect(hueOf(fillAt(700, 300))).toBe('vermelho')
    })

    it('draws 3 drones with 110 m vision circles at their initial positions', () => {
      render(<SimulationCanvas engine={new SimulationEngine({ ratePerMinute: 0 })} />)
      const frame = lastFrame()
      const { map, scale } = mapperFrom(frame)
      for (const [id, x, y] of [
        ['D1', 500, 120],
        ['D2', 500, 300],
        ['D3', 500, 480],
      ] as const) {
        const c = map(x, y)
        const vision = frame.find(
          (k) =>
            k.op === 'arc' &&
            near(k.args[0] as number, c.x) &&
            near(k.args[1] as number, c.y) &&
            near(k.args[2] as number, 110 * scale),
        )
        expect(vision, `${id} vision circle`).toBeDefined()
        const label = frame.find(
          (k) =>
            k.op === 'fillText' &&
            k.args[0] === id &&
            Math.hypot((k.args[1] as number) - c.x, (k.args[2] as number) - c.y) < 40,
        )
        expect(label, `${id} label`).toBeDefined()
      }
    })

    it('dragging a drone moves it and the next reading counts around the new position', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, noisePct: 0, trafficLights: 'always-green' })
      const readings: Reading[] = []
      engine.onReading((r) => readings.push(r))
      const { container } = render(<SimulationCanvas engine={engine} />)
      const canvas = container.querySelector('canvas')!
      const { map } = mapperFrom(lastFrame())

      // drag D2 from (500,300) onto the north road at (400,120)
      const from = map(500, 300)
      const to = map(400, 120)
      fireEvent.mouseDown(canvas, { clientX: from.x, clientY: from.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 })
      fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
      fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })

      const d2 = engine.getState().drones.find((d) => d.id === 'D2')!
      expect(d2.position.x).toBeCloseTo(400, 6)
      expect(d2.position.y).toBeCloseTo(120, 6)

      // the circle is redrawn at the new position
      calls.length = 0
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      const moved = map(400, 120)
      expect(
        lastFrame().some(
          (k) => k.op === 'arc' && near(k.args[0] as number, moved.x) && near(k.args[1] as number, moved.y),
        ),
      ).toBe(true)

      // a car on the north road ends the window ~70 m from the new position; the central road is empty
      engine.addCar('norte', 366)
      advance(engine, 10_000)
      const reading = readings.find((r) => r.droneId === 'D2')!
      expect(reading.contagem).toBe(1)
      expect(reading.velocidadeMediaKmh).toBeCloseTo(50, 1)
    })

    it('clamps a drone dropped outside the map to the nearest edge', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      const { container } = render(<SimulationCanvas engine={engine} />)
      const canvas = container.querySelector('canvas')!
      const { map } = mapperFrom(lastFrame())

      const from = map(500, 300)
      const outside = map(1200, -100)
      fireEvent.mouseDown(canvas, { clientX: from.x, clientY: from.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: outside.x, clientY: outside.y })
      fireEvent.mouseUp(window, { clientX: outside.x, clientY: outside.y })

      const d2 = engine.getState().drones.find((d) => d.id === 'D2')!
      expect(d2.position).toEqual({ x: 1000, y: 0 })
      // the others did not move
      expect(engine.getState().drones.find((d) => d.id === 'D1')!.position).toEqual({ x: 500, y: 120 })
    })
  })

  describe('NoiseControl', () => {
    it('next reading uses the new noise and carries ruidoPct', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      const transport = new FakeTransport(true)
      render(<App engine={engine} transport={transport} />)

      const slider = screen.getByRole('slider', { name: /ruído da leitura/i })
      expect(slider).toHaveValue('10')
      expect(slider).toHaveAttribute('min', '0')
      expect(slider).toHaveAttribute('max', '30')

      // 40 s in, cars are already under the drones
      act(() => {
        vi.advanceTimersByTime(40_000)
      })
      const before = transport.published.map((m) => JSON.parse(m.payload))
      expect(before).toHaveLength(12)
      for (const p of before) expect(p.ruidoPct).toBe(10)

      fireEvent.change(slider, { target: { value: '25' } })
      expect(engine.getNoise()).toBe(25)
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const after = transport.published.slice(12).map((m) => JSON.parse(m.payload))
      expect(after).toHaveLength(3)
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
    it('shows the latest reading per drone and the last 20 messages newest first', () => {
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={transport} />)
      const panel = screen.getByRole('complementary', { name: /telemetria/i })
      expect(within(panel).getByText('MQTT conectado')).toBeInTheDocument()

      const send = (droneId: string, ts: number, contagem: number, velocidadeMediaKmh: number | null) =>
        act(() => {
          transport.deliver(
            `transito/drones/${droneId}/telemetria`,
            JSON.stringify({ droneId, ts, janelaS: 10, contagem, velocidadeMediaKmh, ruidoPct: 10 }),
          )
        })

      send('D1', 10_000, 3, 41.2)
      send('D2', 10_000, 0, null)
      send('D1', 20_000, 5, 22.5)
      expect(within(panel).getByTestId('drone-D1-contagem')).toHaveTextContent('5')
      expect(within(panel).getByTestId('drone-D1-velocidade')).toHaveTextContent('22.5')
      expect(within(panel).getByTestId('drone-D2-contagem')).toHaveTextContent('0')
      expect(within(panel).getByTestId('drone-D2-velocidade')).toHaveTextContent('—')

      for (let i = 0; i < 25; i++) send('D3', 30_000 + i, i, 50)
      const log = within(panel).getAllByTestId('telemetry-log-entry')
      expect(log).toHaveLength(20)
      expect(log[0]).toHaveTextContent('transito/drones/D3/telemetria')
      expect(log[0]).toHaveTextContent('"contagem":24')
      expect(log[19]).toHaveTextContent('"contagem":5')
      expect(within(panel).getByTestId('drone-D3-contagem')).toHaveTextContent('24')
    })

    it('shows MQTT desconectado and no new readings while disconnected and the simulation keeps running', () => {
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
      // simulation, lights and drones keep going
      const state = engine.getState()
      expect(state.timeMs).toBe(25_000)
      expect(state.spawnedTotal).toBeGreaterThan(0)
      expect(state.lights.find((l) => l.intersectionId === 'I1')!.phase).toBe('vermelho')
      expect(produced.length).toBe(6)
      // but nothing reaches the panel
      expect(within(panel).queryAllByTestId('telemetry-log-entry')).toHaveLength(0)
      expect(within(panel).getByTestId('drone-D1-contagem')).toHaveTextContent('—')

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
      expect(log).toHaveLength(3)
      expect(within(panel).getByTestId('drone-D1-contagem')).not.toHaveTextContent('—')
    })
  })
})
