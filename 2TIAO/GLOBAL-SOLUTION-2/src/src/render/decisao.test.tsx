import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MetricsRecorder } from '../decision/MetricsRecorder'
import { lightAt } from '../sim/trafficLight'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { MetricsPanel } from './MetricsPanel'

interface Call {
  op: string
  args: unknown[]
  fillStyle: unknown
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
          calls.push({ op: String(key), args, fillStyle: target.fillStyle })
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
/** Network metres -> px, from the drawn central route (60,300) -> (940,300). */
function mapper() {
  const frame = lastFrame()
  const lines: [number, number][][] = []
  let cur: [number, number][] = []
  for (const { op, args } of frame) {
    if (op === 'beginPath') cur = []
    else if (op === 'moveTo' || op === 'lineTo') cur.push([args[0] as number, args[1] as number])
    else if (op === 'stroke' && cur.length >= 2) lines.push(cur)
  }
  const central = lines.find((l) => l.length === 4)!
  const scale = (central[3][0] - central[0][0]) / 880
  return (x: number, y: number) => ({ x: central[0][0] + (x - 60) * scale, y: central[0][1] + (y - 300) * scale })
}
const isRed = (c: unknown) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c))
  if (!m) return false
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  return r > 150 && r > g * 2 && r > b * 2
}
function markerAt(frame: Call[], p: { x: number; y: number }) {
  return frame.find(
    (k) =>
      k.op === 'fillRect' &&
      isRed(k.fillStyle) &&
      Math.abs((k.args[0] as number) + (k.args[2] as number) / 2 - p.x) < 2 &&
      Math.abs((k.args[1] as number) + (k.args[3] as number) / 2 - p.y) < 2,
  )
}

describe('render', () => {
  describe('accident', () => {
    it('clicking a road in accident mode blocks it at the nearest point and draws a marker', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const map = mapper()
      const button = screen.getByRole('button', { name: /acidente/i })
      expect(button).toHaveAttribute('aria-pressed', 'false')

      // accident mode off: a click selects the road, no blockage
      const p = map(400, 300)
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y + 4, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y + 4 })
      expect(engine.getState().blockages).toHaveLength(0)

      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-pressed', 'true')
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y + 4, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y + 4 })
      const [block] = engine.getState().blockages
      expect(block.routeId).toBe('central')
      expect(block.distance).toBeCloseTo(340, 0) // (400,300) is 340 m along central
      expect(markerAt(redraw(), p)).toBeDefined()

      // far from every road: nothing new
      const away = map(500, 560)
      fireEvent.mouseDown(canvas, { clientX: away.x, clientY: away.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: away.x, clientY: away.y })
      expect(engine.getState().blockages).toHaveLength(1)
    })

    it('clicking the marker in accident mode removes the blockage', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const map = mapper()
      engine.addBlockage('central', 340)
      const p = map(400, 300)
      expect(markerAt(redraw(), p)).toBeDefined()

      // outside accident mode the marker click does not remove it
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
      expect(engine.getState().blockages).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: /acidente/i }))
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
      expect(engine.getState().blockages).toHaveLength(0)
      expect(markerAt(redraw(), p)).toBeUndefined()
    })
  })

  describe('controls', () => {
    it('turning partial diversion off stops diverting at once and it starts on', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 300, trafficLights: 'always-green' })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const toggle = screen.getByRole('button', { name: /desvio parcial/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'true')

      engine.setDiversion({ from: 'central', to: 'norte', fraction: 0.5 })
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      const before = engine.getState().divertedTotal
      expect(before).toBeGreaterThan(0)

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(engine.getState().diversion).toBeNull()
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(engine.getState().divertedTotal).toBe(before)
      expect(screen.getByTestId('diversion-state')).toHaveTextContent(/desligado/i)
    })

    it('signal control starts off and turning it off restores the fixed cycle', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const toggle = screen.getByRole('button', { name: /controle de semáforos/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')

      const fixed = () => {
        const t = engine.getState().timeMs
        for (const l of engine.getState().lights) {
          expect(l.phase).toBe(lightAt(l.intersectionId, t).phase)
          expect(l.remainingS).toBeCloseTo(lightAt(l.intersectionId, t).remainingS, 6)
        }
      }
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      fixed()

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(engine.getState().adaptiveSignals).toBe(true)
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      fireEvent.click(toggle)
      expect(engine.getState().adaptiveSignals).toBe(false)
      fixed()
      act(() => {
        vi.advanceTimersByTime(20_000)
      })
      fixed()
    })
  })

  describe('MetricsPanel', () => {
    const snapshot = {
      travelLastMinuteS: 84.25,
      travelAllS: 71.5,
      queueTotal: 17,
      pctDiverted: 12.5,
      samples: [],
    }

    it('shows travel time, total queue, percent diverted and the diversion state', () => {
      const { rerender } = render(
        <MetricsPanel metrics={snapshot} diversion={{ status: 'ativo', from: 'central', to: 'norte', n: 480, p: 0.4 }} />,
      )
      const panel = screen.getByRole('region', { name: /métricas/i })
      expect(within(panel).getByTestId('metric-travel-minute')).toHaveTextContent('84,3 s')
      expect(within(panel).getByTestId('metric-travel-total')).toHaveTextContent('71,5 s')
      expect(within(panel).getByTestId('metric-queue')).toHaveTextContent('17')
      expect(within(panel).getByTestId('metric-diverted')).toHaveTextContent('12,5%')
      const state = within(panel).getByTestId('diversion-state')
      expect(state).toHaveTextContent('Central → Norte')
      expect(state).toHaveTextContent('N 480 veíc/h')
      expect(state).toHaveTextContent('p 40%')

      rerender(<MetricsPanel metrics={{ ...snapshot, travelLastMinuteS: null }} diversion={{ status: 'inativo' }} />)
      expect(within(panel).getByTestId('metric-travel-minute')).toHaveTextContent('—')
      expect(within(panel).getByTestId('diversion-state')).toHaveTextContent(/inativo/i)

      // a chart whose last window had no arrival shows "—", not a zero travel time
      rerender(
        <MetricsPanel
          metrics={{ ...snapshot, samples: [{ t: 10_000, travelS: null, queue: 3, pctDiverted: 0 }] }}
          diversion={{ status: 'inativo' }}
        />,
      )
      expect(screen.getByTestId('chart-travel').closest('figure')!).toHaveTextContent('—')

      // the percentage comes from the engine: diverted over generated
      const engine = new SimulationEngine({ ratePerMinute: 300, trafficLights: 'always-green' })
      engine.setDiversion({ from: 'central', to: 'norte', fraction: 0.4 })
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
      const real = new MetricsRecorder(engine).snapshot()
      expect(engine.getState().spawnedTotal).toBe(300)
      expect(engine.getState().divertedTotal).toBe(40)
      expect(real.pctDiverted).toBeCloseTo((100 * 40) / 300, 9)
      rerender(<MetricsPanel metrics={real} diversion={{ status: 'inativo' }} />)
      expect(screen.getByTestId('metric-diverted')).toHaveTextContent('13,3%')
    })

    it('shows the diversion state including no alternative with slack', () => {
      render(<MetricsPanel metrics={snapshot} diversion={{ status: 'sem-alternativa', from: 'central' }} />)
      expect(screen.getByTestId('diversion-state')).toHaveTextContent('sem rota alternativa com folga')
    })

    it('charts one sample every 10 simulated seconds and keeps the last 60', () => {
      const engine = new SimulationEngine({ ratePerMinute: 30 })
      const recorder = new MetricsRecorder(engine)
      for (let t = 0; t < 660_000; t += TICK_MS) {
        engine.tick(TICK_MS)
        recorder.record()
      }
      const { samples } = recorder.snapshot()
      expect(samples).toHaveLength(60)
      expect(samples[0].t).toBe(70_000)
      expect(samples[59].t).toBe(660_000)
      for (let i = 1; i < samples.length; i++) expect(samples[i].t - samples[i - 1].t).toBe(10_000)
      expect(samples[59].queue).toBe(engine.queueTotal())

      render(<MetricsPanel metrics={recorder.snapshot()} diversion={{ status: 'inativo' }} />)
      for (const id of ['chart-travel', 'chart-queue', 'chart-diverted']) {
        const line = screen.getByTestId(id).querySelector('polyline')!
        expect(line.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(60)
      }
    })
  })
})
