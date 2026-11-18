import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MetricsRecorder } from '../decision/MetricsRecorder'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { lightAt } from '../sim/trafficLight'
import type { Point } from '../sim/types'
import { FakeTransport } from '../telemetry/testing'
import { fitTransform } from './draw'
import { MetricsPanel } from './MetricsPanel'

interface Call {
  op: string
  args: unknown[]
  strokeStyle: unknown
  fillStyle: unknown
  dash: unknown
}
let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const props: Record<string | symbol, unknown> = { dash: [] }
    return new Proxy(props, {
      get(target, key) {
        if (key === 'setLineDash') return (d: unknown) => {
          target.dash = d
        }
        if (key in target) return target[key]
        return (...args: unknown[]) => {
          calls.push({ op: String(key), args, strokeStyle: target.strokeStyle, fillStyle: target.fillStyle, dash: target.dash })
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

const screenOf = (engine: SimulationEngine, p: Point) => fitTransform(engine.getState().network, 1000, 600).map(p)
const press = (canvas: HTMLCanvasElement, from: Point, to: Point = from) => {
  fireEvent.mouseDown(canvas, { clientX: from.x, clientY: from.y, button: 0 })
  fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
  fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
}

describe('render', () => {
  describe('units', () => {
    it('adds the next unit at the centre and removes a unit with its coverage', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      fireEvent.click(screen.getByRole('link', { name: 'Câmeras' }))
      const panel = screen.getByRole('region', { name: 'Unidades câmera+radar' })
      fireEvent.click(within(panel).getByRole('button', { name: 'Adicionar unidade' }))
      const { minX, minY, maxX, maxY } = engine.getState().network.bounds
      expect(engine.getState().cameras.find((c) => c.id === 'U13')).toEqual({
        id: 'U13',
        position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        heading: 90,
        fov: 40,
        range: 130,
      })
      expect(within(panel).getByTestId('camera-U13')).toBeInTheDocument()

      fireEvent.click(within(within(panel).getByTestId('camera-U02')).getByRole('button', { name: 'Remover' }))
      expect(engine.getState().cameras.map((c) => c.id)).not.toContain('U02')
      expect(within(panel).queryByTestId('camera-U02')).toBeNull()
      for (const s of engine.getState().segments) expect(engine.coverage.entries(s.id).map((e) => e.sensorId)).not.toContain('U02')
      // ids are never reused
      fireEvent.click(within(within(panel).getByTestId('camera-U13')).getByRole('button', { name: 'Remover' }))
      fireEvent.click(within(panel).getByRole('button', { name: 'Adicionar unidade' }))
      expect(engine.getState().cameras.map((c) => c.id)).toContain('U14')
      expect(engine.getState().cameras.map((c) => c.id)).not.toContain('U13')
    })

    it('a press on a unit drags it without changing the selected segment and drops it inside the map', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const panel = screen.getByRole('region', { name: 'Via selecionada' })
      expect(within(panel).getByTestId('selected-name')).toHaveTextContent(segmentName('I12>I13'))
      const u1 = engine.getState().cameras.find((c) => c.id === 'U01')!.position
      const target = pointOnSegment(engine.segment('I22>I23')!, 60)
      const rebuilds = engine.coverage.rebuilds
      press(canvas, screenOf(engine, u1), screenOf(engine, target))
      const moved = engine.getState().cameras.find((c) => c.id === 'U01')!.position
      expect(moved.x).toBeCloseTo(target.x, 0)
      expect(moved.y).toBeCloseTo(target.y, 0)
      expect(engine.coverage.rebuilds).toBeGreaterThan(rebuilds)
      expect(within(panel).getByTestId('selected-name')).toHaveTextContent(segmentName('I12>I13'))
      // dropped outside the map, it stays on the nearest edge
      press(canvas, screenOf(engine, moved), { x: 2000, y: -500 })
      const { minX, minY, maxX, maxY } = engine.getState().network.bounds
      const outside = fitTransform(engine.getState().network, 1000, 600).unmap({ x: 2000, y: -500 })
      expect(outside.x > maxX || outside.x < minX || outside.y > maxY || outside.y < minY).toBe(true)
      expect(engine.getState().cameras.find((c) => c.id === 'U01')!.position).toEqual({
        x: Math.min(maxX, Math.max(minX, outside.x)),
        y: Math.min(maxY, Math.max(minY, outside.y)),
      })
    })
  })

  describe('accident', () => {
    it('clicking the marker in accident mode removes the blockage', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const b = engine.addBlockage('I23>I24', 60)
      act(() => {
        vi.advanceTimersByTime(TICK_MS)
      })
      const p = screenOf(engine, pointOnSegment(engine.segment('I23>I24')!, 60))
      const marker = () => screen.queryByTestId(`marker-colisao:${b.id}`)
      expect(marker()).not.toBeNull()
      // outside accident mode the click does not remove it
      press(canvas, p)
      expect(engine.getState().blockages).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Acidente' }))
      press(canvas, p)
      expect(engine.getState().blockages).toHaveLength(0)
      expect(marker()).toBeNull()
    })
  })

  describe('controls', () => {
    it('turning partial diversion off stops notifying at once and it starts on', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const transport = new FakeTransport(true)
      render(<App engine={engine} transport={transport} />)
      fireEvent.click(screen.getByRole('link', { name: 'Semáforos' }))
      const toggle = screen.getByRole('button', { name: /desvio parcial/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByTestId('diversion-state')).toHaveTextContent(/desligado/i)
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByTestId('diversion-state')).toHaveTextContent(/inativo/i)
    })

    it('signal control starts off and turning it off restores the fixed cycle', { timeout: 60_000 }, () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      fireEvent.click(screen.getByRole('link', { name: 'Semáforos' }))
      const toggle = screen.getByRole('button', { name: /controle de semáforos/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      const fixed = () => {
        const t = engine.getState().timeMs
        for (const l of engine.getState().lights) {
          const f = lightAt(l.intersectionId, t)
          expect([l.h, l.v]).toEqual([f.h, f.v])
          expect(l.remainingS).toBeCloseTo(f.remainingS, 6)
        }
      }
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      fixed()
      fireEvent.click(toggle)
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
    const snapshot = { travelLastMinuteS: 84.25, travelAllS: 71.5, queueTotal: 17, pctDiverted: 12.5, samples: [] }

    it('shows travel time, total queue, percent notified and the diversion state', () => {
      const { rerender } = render(
        <MetricsPanel
          metrics={snapshot}
          diversion={{ status: 'ativo', trecho: 'I12>I13', n: 480, p: 0.4, candidatos: 9, notificados: 3, semAlcance: 2 }}
        />,
      )
      const panel = screen.getByRole('region', { name: 'Métricas' })
      expect(within(panel).getByTestId('metric-travel-minute')).toHaveTextContent('84,3 s')
      expect(within(panel).getByTestId('metric-travel-total')).toHaveTextContent('71,5 s')
      expect(within(panel).getByTestId('metric-queue')).toHaveTextContent('17')
      expect(within(panel).getByTestId('metric-diverted')).toHaveTextContent('12,5%')
      const state = within(panel).getByTestId('diversion-state')
      expect(state).toHaveTextContent(`evitar ${segmentName('I12>I13')}`)
      expect(state).toHaveTextContent('9 motoristas com app à frente')
      expect(state).toHaveTextContent('p 40%')
      expect(state).toHaveTextContent('3 notificados na janela')

      rerender(<MetricsPanel metrics={{ ...snapshot, travelLastMinuteS: null }} diversion={{ status: 'inativo' }} />)
      expect(within(panel).getByTestId('metric-travel-minute')).toHaveTextContent('—')
      expect(within(panel).getByTestId('diversion-state')).toHaveTextContent(/inativo/i)

      // a chart whose last window had no arrival shows "—", not a zero travel time
      rerender(<MetricsPanel metrics={{ ...snapshot, samples: [{ t: 10_000, travelS: null, queue: 3, pctDiverted: 0 }] }} diversion={{ status: 'inativo' }} />)
      expect(screen.getByTestId('chart-travel').closest('figure')!).toHaveTextContent('—')

      // the percentage comes from the engine: rerouted over generated
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const cars = [0, 1, 2, 3].map(() => engine.addCar({ path: ['I11>I12', 'I12>I13', 'I13>I14'], app: 'waze', velocity: 0 }))
      engine.reroute(cars[0].id, ['I12>I22', 'I22>I23', 'I23>I24', 'I24>I14'])
      const real = new MetricsRecorder(engine).snapshot()
      expect(engine.getState().reroutedTotal).toBe(1)
      // placed cars are not generated ones: nothing generated -> 0 %
      expect(real.pctDiverted).toBe(0)
    })

    it('charts one sample every 10 simulated seconds and keeps the last 60', { timeout: 60_000 }, () => {
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

  describe('segment panel', () => {
    it('plots the last 200 samples and the fitted curve with the capacity point', () => {
      vi.useFakeTimers()
      const transport = new FakeTransport(true)
      render(<App engine={new SimulationEngine({ ratePerMinute: 0, cameras: [] })} transport={transport} />)
      fireEvent.click(screen.getByRole('link', { name: 'Relatórios' }))
      const panel = screen.getByRole('region', { name: 'Métricas do trecho' })
      let ts = 0
      const send = (k: number) =>
        transport.deliver(
          'transito/sensores/U02/telemetria',
          JSON.stringify({
            sensorId: 'U02',
            ts: (ts += 1),
            porTrecho: [{ trecho: 'I12>I13', contagem: k, velocidadeMediaKmh: 50 * (1 - k / 100), comprimentoCobertoM: 1000, cobertura: 1 }],
          }),
        )
      expect(within(panel).queryAllByTestId('sample-point')).toHaveLength(0)
      act(() => {
        ;[12, 22, 33].forEach(send)
        vi.advanceTimersByTime(11_000)
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
      const mark = within(panel).getByTestId('capacity-point')
      expect(within(panel).getByTestId('fitted-curve')).toBeInTheDocument()
      expect(Number(mark.getAttribute('data-k'))).toBeCloseTo(50, 0)
    })
  })

  describe('App', () => {
    it('titles the page for the traffic control centre and never says drone', () => {
      vi.useFakeTimers()
      render(<App engine={new SimulationEngine({ ratePerMinute: 30 })} transport={new FakeTransport(true)} />)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Centro de Operações de Tráfego')
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(document.body.textContent).not.toMatch(/drone/i)
      for (const el of document.querySelectorAll('[aria-label]')) expect(el.getAttribute('aria-label')).not.toMatch(/drone/i)
      const html = readFileSync(`${process.cwd()}/index.html`, 'utf8')
      expect(html).toMatch(/<title>Centro de Operações de Tráfego — Jardins<\/title>/)
      expect(html).not.toMatch(/drone/i)
      const pkg = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8'))
      expect(pkg.name).toBe('transito-inteligente')
    })
  })
})
