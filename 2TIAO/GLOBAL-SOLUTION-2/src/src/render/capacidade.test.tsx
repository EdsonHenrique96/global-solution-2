import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { RouteStatus } from '../capacity/CapacityModel'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { SimulationCanvas } from './SimulationCanvas'

interface Call {
  op: string
  args: unknown[]
  strokeStyle: unknown
}

function recordingContext(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = {}
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.push({ op: String(key), args, strokeStyle: target.strokeStyle })
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

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => recordingContext(calls) as never,
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 600)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function lastFrame(): Call[] {
  const start = calls.map((c) => c.op).lastIndexOf('clearRect')
  return start === -1 ? [] : calls.slice(start)
}

function redraw(): Call[] {
  calls.length = 0
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  return lastFrame()
}

interface Stroke {
  points: [number, number][]
  style: unknown
}

function strokes(frame: Call[]): Stroke[] {
  const out: Stroke[] = []
  let current: [number, number][] = []
  for (const { op, args, strokeStyle } of frame) {
    if (op === 'beginPath') current = []
    else if (op === 'moveTo' || op === 'lineTo') current.push([args[0] as number, args[1] as number])
    else if (op === 'stroke' && current.length >= 2) out.push({ points: current, style: strokeStyle })
  }
  return out
}

/** Network metres -> canvas px, from the drawn central route (60,300) -> (940,300). */
function mapperFrom(frame: Call[]) {
  const central = strokes(frame).find((s) => s.points.length === 4)!.points
  const [x0, y0] = central[0]
  const scale = (central[3][0] - x0) / 880
  return (x: number, y: number) => ({ x: x0 + (x - 60) * scale, y: y0 + (y - 300) * scale })
}

/** Which route a stroked polyline is: central has 4 points; norte bends up, sul bends down. */
function routeOf(points: [number, number][]): string {
  if (points.length === 4) return 'central'
  return points[2][1] < points[0][1] ? 'norte' : 'sul'
}

function hueOf(colour: unknown): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(colour))
  if (!m) return 'other'
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  if (r > 230 && g > 230 && b > 230) return 'branco'
  if (g > 120 && g > r * 1.3 && g > b * 1.3) return 'verde'
  if (r > 180 && g > 150 && b < 100 && Math.abs(r - g) < 80) return 'amarelo'
  if (r > 150 && r > g * 2 && r > b * 2) return 'vermelho'
  if (Math.max(r, g, b) - Math.min(r, g, b) < 60 && r > 110) return 'cinza'
  return 'other'
}

function huesByRoute(frame: Call[]): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = { central: new Set(), norte: new Set(), sul: new Set() }
  for (const s of strokes(frame)) out[routeOf(s.points)].add(hueOf(s.style))
  return out
}

/** Reads a pt-BR number ("1.250,5 veíc/h") from an element's text. */
function numberIn(el: HTMLElement): number {
  return Number(el.textContent!.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'))
}

function message(ts: number, porVia: unknown[]) {
  return JSON.stringify({ droneId: 'D1', ts, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porVia })
}

describe('render', () => {
  describe('SimulationCanvas', () => {
    it('paints each route in its state colour and grey without data', () => {
      let states: Record<string, RouteStatus> = { norte: 'fluindo', central: 'carregado', sul: 'congestionado' }
      render(<SimulationCanvas engine={new SimulationEngine({ ratePerMinute: 0 })} routeStatus={() => states} />)

      let hues = huesByRoute(redraw())
      const expected: Record<string, string> = { norte: 'verde', central: 'amarelo', sul: 'vermelho' }
      for (const [route, hue] of Object.entries(expected)) {
        expect(hues[route].has(hue), `${route} drawn ${hue}`).toBe(true)
        for (const other of ['verde', 'amarelo', 'vermelho'].filter((h) => h !== hue)) {
          expect(hues[route].has(other), `${route} not ${other}`).toBe(false)
        }
      }

      states = { norte: 'sem dados', central: 'sem dados', sul: 'fluindo' }
      hues = huesByRoute(redraw())
      for (const route of ['norte', 'central']) {
        expect(hues[route].has('cinza'), `${route} grey`).toBe(true)
        for (const h of ['verde', 'amarelo', 'vermelho']) expect(hues[route].has(h)).toBe(false)
      }
      expect(hues.sul.has('verde')).toBe(true)
    })

    it('a press on a drone drags it without changing the selected route and a click away keeps the selection', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const panel = screen.getByRole('region', { name: /capacidade da via/i })
      const map = mapperFrom(lastFrame())
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central')

      // D1 sits on the north road at (500,120): the press grabs the drone, not the road
      const d1 = map(500, 120)
      const to = map(500, 200)
      fireEvent.mouseDown(canvas, { clientX: d1.x, clientY: d1.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
      fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
      expect(engine.getState().drones.find((d) => d.id === 'D1')!.position.y).toBeCloseTo(200, 6)
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central')

      // far from every road (80 m below the south road)
      const away = map(500, 560)
      fireEvent.mouseDown(canvas, { clientX: away.x, clientY: away.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: away.x, clientY: away.y })
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central')
    })
  })

  describe('CapacityPanel', () => {
    it('clicking a route selects it and shows state capacity flow and slack', () => {
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={transport} />)
      const canvas = document.querySelector('canvas')!
      const panel = screen.getByRole('region', { name: /capacidade da via/i })
      const map = mapperFrom(lastFrame())

      // central is selected on load and highlighted
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central')
      let hues = huesByRoute(redraw())
      expect(hues.central.has('branco')).toBe(true)
      expect(hues.norte.has('branco')).toBe(false)
      expect(within(panel).getByTestId('capacity-estado')).toHaveTextContent('sem dados')

      // north learns 20 samples on v = 50 (1 - k/100), the last one k 5 at 47.5 km/h
      act(() => {
        for (let i = 20; i >= 1; i--) {
          const k = 5 * i
          transport.deliver(
            'transito/drones/D1/telemetria',
            message(0, [{ via: 'norte', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoM: 1000 }]),
          )
        }
      })

      const road = map(400, 120)
      fireEvent.mouseDown(canvas, { clientX: road.x, clientY: road.y + 3, button: 0 })
      fireEvent.mouseUp(window, { clientX: road.x, clientY: road.y + 3 })

      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Norte')
      expect(within(panel).getByTestId('capacity-estado')).toHaveTextContent('fluindo')
      const capacity = numberIn(within(panel).getByTestId('capacity-capacidade'))
      expect(capacity).toBeGreaterThanOrEqual(1235)
      expect(capacity).toBeLessThanOrEqual(1265)
      expect(within(panel).getByTestId('capacity-capacidade')).toHaveTextContent('veíc/h')
      const flow = numberIn(within(panel).getByTestId('capacity-fluxo'))
      expect(flow).toBeCloseTo(237.5, 0) // k 5 x 47.5 km/h
      const slack = numberIn(within(panel).getByTestId('capacity-folga'))
      expect(slack).toBeCloseTo(capacity - flow, 0)

      hues = huesByRoute(redraw())
      expect(hues.norte.has('branco')).toBe(true)
      expect(hues.central.has('branco')).toBe(false)

      // a route still learning shows "aprendendo"
      const south = map(400, 480)
      fireEvent.mouseDown(canvas, { clientX: south.x, clientY: south.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: south.x, clientY: south.y })
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Sul')
      expect(within(panel).getByTestId('capacity-capacidade')).toHaveTextContent('aprendendo')
      expect(within(panel).getByTestId('capacity-folga')).toHaveTextContent('aprendendo')
    })

    it('plots the last 200 samples and the fitted curve with the capacity point', () => {
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={transport} />)
      const panel = screen.getByRole('region', { name: /capacidade da via/i })
      const send = (k: number) =>
        transport.deliver(
          'transito/drones/D2/telemetria',
          message(0, [{ via: 'central', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoM: 1000 }]),
        )

      expect(within(panel).queryAllByTestId('sample-point')).toHaveLength(0)
      act(() => [10, 20, 30].forEach(send))
      expect(within(panel).getAllByTestId('sample-point')).toHaveLength(3)
      expect(within(panel).queryByTestId('fitted-curve')).toBeNull()
      expect(within(panel).queryByTestId('capacity-point')).toBeNull()

      act(() => {
        for (let i = 0; i < 247; i++) send(5 + (i % 19) * 5)
      })
      expect(within(panel).getAllByTestId('sample-point')).toHaveLength(200)
      const curve = within(panel).getByTestId('fitted-curve')
      expect(curve.getAttribute('d')).toMatch(/^M/)
      const capPoint = within(panel).getByTestId('capacity-point')
      // the capacity point sits at k_j / 2 = 50 veíc/km on the chart's density axis
      expect(Number(capPoint.getAttribute('data-k'))).toBeCloseTo(50, 0)
      expect(Number(capPoint.getAttribute('data-q'))).toBeGreaterThanOrEqual(1235)
      expect(Number(capPoint.getAttribute('data-q'))).toBeLessThanOrEqual(1265)
    })
  })
})
