import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Reading } from '../sensors/reader'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { SimulationCanvas } from './SimulationCanvas'

interface Call {
  op: string
  args: unknown[]
  strokeStyle: unknown
}
let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const props: Record<string | symbol, unknown> = {}
    return new Proxy(props, {
      get(target, key) {
        if (key in target) return target[key]
        return (...args: unknown[]) => {
          calls.push({ op: String(key), args, strokeStyle: target.strokeStyle })
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
  let cur: [number, number][] = []
  for (const { op, args, strokeStyle } of frame) {
    if (op === 'beginPath') cur = []
    else if (op === 'moveTo' || op === 'lineTo') cur.push([args[0] as number, args[1] as number])
    else if (op === 'stroke' && cur.length >= 2) out.push({ points: cur, style: strokeStyle })
  }
  return out
}
/** Network metres -> px, from the drawn central route (60,300) -> (940,300), the 4-point stroke. */
function mapper(frame: Call[]) {
  const central = strokes(frame).find((s) => s.points.length === 4)!.points
  const scale = (central[3][0] - central[0][0]) / 880
  return (x: number, y: number) => ({ x: central[0][0] + (x - 60) * scale, y: central[0][1] + (y - 300) * scale })
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.5
/** Hues of the strokes that run exactly from a to b (map metres). */
function huesOf(frame: Call[], map: ReturnType<typeof mapper>, a: [number, number], b: [number, number]) {
  const pa = map(...a)
  const pb = map(...b)
  return strokes(frame)
    .filter((s) => {
      const first = s.points[0]
      const last = s.points[s.points.length - 1]
      return near(first[0], pa.x) && near(first[1], pa.y) && near(last[0], pb.x) && near(last[1], pb.y)
    })
    .map((s) => hueOf(s.style))
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
// each reading gets its own window timestamp: the fusion keeps one measurement per segment and window
let windowTs = 0
const message = (sensorId: string, porTrecho: unknown[]) => {
  windowTs += 1
  return JSON.stringify({ sensorId, tipo: 'fixo', ts: windowTs, janelaS: 10, contagem: 0, velocidadeMediaKmh: null, ruidoPct: 0, porTrecho })
}

describe('render', () => {
  describe('segments', () => {
    it('paints each segment by state and selects it on click', () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(true)
      // no cameras of its own: only the readings this test sends reach the fusion
      render(<App engine={new SimulationEngine({ ratePerMinute: 0, cameras: [] })} transport={transport} />)
      const canvas = document.querySelector('canvas')!
      const panel = screen.getByRole('region', { name: /capacidade do trecho/i })
      const map = mapper(lastFrame())

      // central I1->I2 is selected on load: halo on it, nothing else
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central I1→I2')
      let frame = redraw()
      expect(huesOf(frame, map, [300, 300], [700, 300])).toContain('branco')
      // a segment without readings is grey
      expect(huesOf(frame, map, [180, 300], [300, 300])).toEqual(['cinza'])

      // central I1->I2 congested, north I3->M learns a curve and is flowing
      act(() => {
        transport.deliver('transito/sensores/C2/telemetria', message('C2', [{ trecho: 'central-I1-I2', contagem: 30, velocidadeMediaKmh: 8, comprimentoCobertoM: 215, cobertura: 0.54 }]))
        // sul I4->M at 30 km/h: carregado
        transport.deliver('transito/sensores/C3/telemetria', message('C3', [{ trecho: 'sul-I4-M', contagem: 4, velocidadeMediaKmh: 30, comprimentoCobertoM: 215, cobertura: 0.54 }]))
        for (let i = 20; i >= 1; i--) {
          const k = 5 * i
          transport.deliver('transito/sensores/C1/telemetria', message('C1', [{ trecho: 'norte-I3-M', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoCobertoM: 1000, cobertura: 0.5 }]))
        }
        // the fusion hands a window to the capacity model once it closes (10 s)
        vi.advanceTimersByTime(11_000)
      })
      frame = redraw()
      expect(huesOf(frame, map, [300, 300], [700, 300])).toContain('vermelho')
      expect(huesOf(frame, map, [500, 120], [820, 300])).toContain('verde')
      expect(huesOf(frame, map, [500, 480], [820, 300])).toContain('amarelo')
      // each segment of a route has its own colour: central F->I1 is still grey
      expect(huesOf(frame, map, [180, 300], [300, 300])).toEqual(['cinza'])

      // click on the north segment after I3
      const p = map(600, 120)
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y + 3, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y + 3 })
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Norte I3→M')
      expect(within(panel).getByTestId('capacity-estado')).toHaveTextContent('fluindo')
      // 20 samples on v = 50 (1 - k/100): capacity 1250 +- 15; slack = capacity - 237.5
      const num = (id: string) =>
        Number(within(panel).getByTestId(id).textContent!.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'))
      expect(num('capacity-capacidade')).toBeGreaterThanOrEqual(1235)
      expect(num('capacity-capacidade')).toBeLessThanOrEqual(1265)
      expect(within(panel).getByTestId('capacity-capacidade')).toHaveTextContent('veíc/h')
      expect(within(panel).getByTestId('capacity-fluxo')).toHaveTextContent('237,5 veíc/h')
      expect(num('capacity-folga')).toBeCloseTo(num('capacity-capacidade') - 237.5, 0)
      expect(within(panel).getByTestId('fitted-curve')).toBeInTheDocument()
      frame = redraw()
      expect(huesOf(frame, map, [500, 120], [820, 300])).toContain('branco')
      expect(huesOf(frame, map, [300, 300], [700, 300])).not.toContain('branco')
    })
  })

  describe('cameras', () => {
    it('draws each camera cone and dragging one moves its coverage', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, noisePct: 0, trafficLights: 'always-green' })
      const readings: Reading[] = []
      engine.onReading((r) => readings.push(r))
      const { container } = render(<SimulationCanvas engine={engine} />)
      const canvas = container.querySelector('canvas')!
      const map = mapper(lastFrame())

      // one closed cone per camera, starting at the camera's position
      const cones = () => {
        const out: [number, number][] = []
        let first: [number, number] | null = null
        for (const { op, args } of lastFrame()) {
          if (op === 'beginPath') first = null
          else if (op === 'moveTo') first = [args[0] as number, args[1] as number]
          else if (op === 'closePath' && first) out.push(first)
        }
        return out
      }
      const at = (cs: [number, number][], x: number, y: number) => cs.some(([a, b]) => near(a, map(x, y).x) && near(b, map(x, y).y))
      expect(cones()).toHaveLength(3)
      for (const [x, y] of [[480, 150], [420, 330], [480, 450]]) expect(at(cones(), x, y)).toBe(true)
      expect(engine.coverage.entries('central-I1-I2').map((e) => e.sensorId)).toEqual(['C2'])

      // drag C2 up to look along the north road
      const from = map(420, 330)
      const to = map(420, 150)
      const rebuilds = engine.coverage.rebuilds
      fireEvent.mouseDown(canvas, { clientX: from.x, clientY: from.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
      fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
      const moved = engine.getState().cameras.find((c) => c.id === 'C2')!.position
      expect(moved.x).toBeCloseTo(420, 6)
      expect(moved.y).toBeCloseTo(150, 6)
      expect(engine.coverage.rebuilds).toBeGreaterThan(rebuilds)
      expect(engine.coverage.entries('central-I1-I2')).toEqual([])
      expect(engine.coverage.entries('norte-I3-M').map((e) => e.sensorId)).toContain('C2')
      calls.length = 0
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(at(cones(), 420, 150)).toBe(true)

      // the next reading uses the new coverage: a car on the north road in front of C2
      engine.addCar('norte', 600)
      for (let t = 0; t < 10_000; t += TICK_MS) engine.tick(TICK_MS)
      const c2 = readings.find((r) => r.sensorId === 'C2')!
      expect(c2.porTrecho.map((t) => t.trecho)).toContain('norte-I3-M')
      expect(c2.porTrecho.map((t) => t.trecho)).not.toContain('central-I1-I2')

      // dropped outside the map, a camera stays on the nearest edge
      const back = map(420, 150)
      const outside = map(1200, -100)
      fireEvent.mouseDown(canvas, { clientX: back.x, clientY: back.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: outside.x, clientY: outside.y })
      fireEvent.mouseUp(window, { clientX: outside.x, clientY: outside.y })
      expect(engine.getState().cameras.find((c) => c.id === 'C2')!.position).toEqual({ x: 1000, y: 0 })
    })
  })

  describe('CapacityPanel', () => {
    it('plots the last 200 samples and the fitted curve with the capacity point', () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0, cameras: [] })} transport={transport} />)
      const panel = screen.getByRole('region', { name: /capacidade do trecho/i })
      const send = (k: number) =>
        transport.deliver(
          'transito/sensores/C2/telemetria',
          message('C2', [{ trecho: 'central-I1-I2', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoCobertoM: 1000, cobertura: 1 }]),
        )
      expect(within(panel).queryAllByTestId('sample-point')).toHaveLength(0)
      // three early samples at densities that never come back
      act(() => {
        ;[12, 22, 33].forEach(send)
        vi.advanceTimersByTime(11_000) // windows close and reach the model
      })
      expect(within(panel).getAllByTestId('sample-point')).toHaveLength(3)
      expect(within(panel).queryByTestId('fitted-curve')).toBeNull()
      act(() => {
        for (let i = 0; i < 200; i++) send(5 + (i % 19) * 5)
        vi.advanceTimersByTime(11_000)
      })
      const points = within(panel).getAllByTestId('sample-point')
      expect(points).toHaveLength(200)
      const ks = points.map((p) => Number(p.getAttribute('data-k')))
      for (const k of [12, 22, 33]) expect(ks).not.toContain(k)
      const curve = within(panel).getByTestId('fitted-curve')
      const vertices = [...curve.getAttribute('d')!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
      const baseline = vertices[0][1]
      expect(vertices[vertices.length - 1][1]).toBeCloseTo(baseline, 0)
      const apex = vertices.reduce((a, b) => (b[1] < a[1] ? b : a))
      const mark = within(panel).getByTestId('capacity-point')
      expect(apex[0]).toBeCloseTo(Number(mark.getAttribute('cx')), 0)
      expect(apex[1]).toBeCloseTo(Number(mark.getAttribute('cy')), 0)
      expect(Number(mark.getAttribute('data-k'))).toBeCloseTo(50, 0)
    })
  })

  describe('SimulationCanvas', () => {
    it('a press on a camera drags it without changing the selected segment and a click away keeps the selection', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const panel = screen.getByRole('region', { name: /capacidade do trecho/i })
      const map = mapper(lastFrame())
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central I1→I2')

      // move C1 onto the north road (500,120), then press it there: the press grabs the camera
      engine.moveCamera('C1', { x: 500, y: 120 })
      const c1 = map(500, 120)
      const to = map(500, 200)
      fireEvent.mouseDown(canvas, { clientX: c1.x, clientY: c1.y, button: 0 })
      fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
      fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
      expect(engine.getState().cameras.find((c) => c.id === 'C1')!.position.y).toBeCloseTo(200, 6)
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central I1→I2')

      // far from every road (80 m below the south road)
      const away = map(500, 560)
      fireEvent.mouseDown(canvas, { clientX: away.x, clientY: away.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: away.x, clientY: away.y })
      expect(within(panel).getByTestId('capacity-via')).toHaveTextContent('Central I1→I2')
    })
  })
})
