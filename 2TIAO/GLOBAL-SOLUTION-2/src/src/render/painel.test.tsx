import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Reading } from '../sensors/reader'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'

interface Call {
  op: string
  args: unknown[]
  strokeStyle: unknown
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
          calls.push({ op: String(key), args, strokeStyle: target.strokeStyle, dash: target.dash })
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
  dashed: boolean
}
function strokes(frame: Call[]): Stroke[] {
  const out: Stroke[] = []
  let cur: [number, number][] = []
  for (const { op, args, strokeStyle, dash } of frame) {
    if (op === 'beginPath') cur = []
    else if (op === 'moveTo' || op === 'lineTo') cur.push([args[0] as number, args[1] as number])
    else if (op === 'stroke' && cur.length >= 2) out.push({ points: cur, style: strokeStyle, dashed: Array.isArray(dash) && dash.length > 0 })
  }
  return out
}
function mapper(frame: Call[]) {
  const central = strokes(frame).find((s) => s.points.length === 4)!.points
  const scale = (central[3][0] - central[0][0]) / 880
  return (x: number, y: number) => ({ x: central[0][0] + (x - 60) * scale, y: central[0][1] + (y - 300) * scale })
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.5
function strokesOf(frame: Call[], map: ReturnType<typeof mapper>, a: [number, number], b: [number, number]) {
  const pa = map(...a)
  const pb = map(...b)
  return strokes(frame).filter((s) => {
    const f = s.points[0]
    const l = s.points[s.points.length - 1]
    return near(f[0], pa.x) && near(f[1], pa.y) && near(l[0], pb.x) && near(l[1], pb.y)
  })
}
function hueOf(colour: unknown): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(colour))
  if (!m) return 'other'
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  if (r > 230 && g > 230 && b > 230) return 'branco'
  if (g > 120 && g > r * 1.3 && g > b * 1.3) return 'verde'
  if (r > 200 && g > 90 && g < 150 && b < 80) return 'laranja'
  if (r > 180 && g > 150 && b < 100 && Math.abs(r - g) < 80) return 'amarelo'
  if (r > 150 && r > g * 2 && r > b * 2) return 'vermelho'
  if (Math.max(r, g, b) - Math.min(r, g, b) < 60 && r > 110) return 'cinza'
  return 'other'
}
function cones(frame: Call[]): number {
  return frame.filter((c) => c.op === 'closePath').length
}

describe('render', () => {
  describe('coverage layer', () => {
    it('paints each segment by its best coverage band and switches back to state', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      // an extra camera on the road at (170,300) looking east, narrow: all of central F->I1 (120 m),
      // and only a sliver of the entrance lanes and of central I1->I2
      engine.addCamera()
      const c4 = engine.getState().cameras.at(-1)!.id
      engine.updateCamera(c4, { position: { x: 170, y: 300 }, heading: 90, fov: 20, range: 140 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const map = mapper(lastFrame())
      // on load the layer is "Estado": no data yet, so every segment line is grey and solid
      expect(screen.getByRole('button', { name: 'Estado' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'Cobertura' })).toHaveAttribute('aria-pressed', 'false')
      const first = strokesOf(lastFrame(), map, [700, 300], [820, 300]).filter((x) => hueOf(x.style) === 'cinza')
      expect(first).toHaveLength(1)
      expect(first[0].dashed).toBe(false)
      const best = (id: string) => Math.max(0, ...engine.coverage.entries(id).map((e) => e.cobertura))
      expect(best('central-I1-I2')).toBeGreaterThanOrEqual(0.3)
      expect(best('central-I1-I2')).toBeLessThan(0.8)
      expect(best('central-F-I1')).toBeGreaterThanOrEqual(0.8)
      expect(best('central-I2-M')).toBe(0)

      fireEvent.click(screen.getByRole('button', { name: 'Cobertura' }))
      let frame = redraw()
      const look = (a: [number, number], b: [number, number]) => strokesOf(frame, map, a, b).filter((s) => hueOf(s.style) !== 'other' && hueOf(s.style) !== 'branco')
      expect(look([300, 300], [700, 300]).map((s) => hueOf(s.style))).toEqual(['amarelo'])
      expect(look([180, 300], [300, 300]).map((s) => hueOf(s.style))).toEqual(['verde'])
      const uncovered = look([700, 300], [820, 300])
      expect(uncovered.map((s) => hueOf(s.style))).toEqual(['vermelho'])
      expect(uncovered[0].dashed).toBe(true)
      // a band below 0.3 is orange: find any segment with coverage in (0, 0.3)
      const weak = engine.getState().segments.find((s) => best(s.id) > 0 && best(s.id) < 0.3)
      expect(weak, 'a segment with weak coverage').toBeDefined()
      const pts = weak!.points
      expect(look([pts[0].x, pts[0].y], [pts[pts.length - 1].x, pts[pts.length - 1].y]).map((s) => hueOf(s.style))).toContain('laranja')

      fireEvent.click(screen.getByRole('button', { name: 'Estado' }))
      frame = redraw()
      // no data yet: the state layer is all grey, solid
      const back = look([700, 300], [820, 300])
      expect(back.map((s) => hueOf(s.style))).toEqual(['cinza'])
      expect(back[0].dashed).toBe(false)
      expect(screen.getByRole('button', { name: 'Estado' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('draws the camera cones in both layers', () => {
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={new FakeTransport(true)} />)
      expect(cones(redraw())).toBe(3)
      fireEvent.click(screen.getByRole('button', { name: 'Cobertura' }))
      expect(cones(redraw())).toBe(3)
    })
  })

  describe('tooltip', () => {
    it('shows sensors sources confidence age alerts and demand of the hovered segment', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 15, noisePct: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const map = mapper(lastFrame())
      act(() => {
        vi.advanceTimersByTime(62_000) // readings and one OD window
      })
      act(() => {
        engine.addBlockage('central', 500)
      })
      const p = map(560, 300)
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y + 4 })
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent('Central I1→I2')
      const cov = Math.round(engine.coverage.entries('central-I1-I2')[0].cobertura * 100)
      expect(within(tip).getByTestId('tooltip-sensores')).toHaveTextContent(`C2 ${cov}%`)
      expect(within(tip).getByTestId('tooltip-fontes')).toHaveTextContent('C2')
      // exact values from the fused state the tooltip reads
      const covC2 = engine.coverage.entries('central-I1-I2')[0].cobertura
      const conf = covC2 >= 0.8 ? 1 : covC2 / 0.8 // fresh reading: no ageing yet
      expect(within(tip).getByTestId('tooltip-confianca')).toHaveTextContent(conf.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
      // the last C2 window closed at 60 s; the page clock is at 62 s
      expect(within(tip).getByTestId('tooltip-idade')).toHaveTextContent('2 s')
      expect(within(tip).getByTestId('tooltip-alertas')).toHaveTextContent('1')
      expect(within(tip).getByTestId('tooltip-demanda')).toHaveTextContent('300 veíc/h')
      expect(tip).not.toHaveTextContent('estimado')

      // a segment no camera covers: no sensor, no data
      const q = map(240, 300)
      fireEvent.mouseMove(canvas, { clientX: q.x, clientY: q.y })
      const tip2 = screen.getByRole('tooltip')
      expect(tip2).toHaveTextContent('Central F→I1')
      expect(within(tip2).getByTestId('tooltip-sensores')).toHaveTextContent('nenhuma')
      expect(within(tip2).getByTestId('tooltip-idade')).toHaveTextContent('sem dado')
      expect(within(tip2).getByTestId('tooltip-confianca')).toHaveTextContent('0,00')

      // move C2 away: central I1->I2 keeps its last estimate, marked "estimado"
      act(() => {
        engine.moveCamera('C2', { x: 420, y: 560 })
        vi.advanceTimersByTime(25_000)
      })
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y + 4 })
      expect(screen.getByRole('tooltip')).toHaveTextContent('estimado')
    })

    it('hides when the mouse leaves every segment', () => {
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={new FakeTransport(true)} />)
      const canvas = document.querySelector('canvas')!
      const map = mapper(lastFrame())
      const p = map(560, 300)
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      expect(within(screen.getByRole('tooltip')).getByTestId('tooltip-demanda')).toHaveTextContent('—')
      // the limit is 14 px from the road: 13.5 px shows it, 14.5 px hides it
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y + 13.5 })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y + 14.5 })
      expect(screen.queryByRole('tooltip')).toBeNull()
      const away = map(500, 560)
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      fireEvent.mouseMove(canvas, { clientX: away.x, clientY: away.y })
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      fireEvent.mouseLeave(canvas)
      expect(screen.queryByRole('tooltip')).toBeNull()
    })
  })

  describe('CameraPanel', () => {
    it('editing a camera recomputes its cone coverage and next reading', () => {
      vi.useFakeTimers()
      const engine = new SimulationEngine({ ratePerMinute: 0, noisePct: 0, trafficLights: 'always-green' })
      const readings: Reading[] = []
      engine.onReading((r) => readings.push(r))
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const panel = screen.getByRole('region', { name: /câmeras/i })
      const row = within(panel).getByTestId('camera-C2')
      expect(within(row).getByLabelText(/direção/i)).toHaveValue(90)
      expect(within(row).getByLabelText(/ângulo/i)).toHaveValue(70)
      expect(within(row).getByLabelText(/alcance/i)).toHaveValue(260)
      expect(engine.coverage.entries('central-I1-I2').map((e) => e.sensorId)).toEqual(['C2'])

      // turn C2 to look up (0°): only the ~40 m of central road right above it stay in view
      const before = engine.coverage.entries('central-I1-I2')[0].cobertura
      const rebuilds = engine.coverage.rebuilds
      fireEvent.change(within(row).getByLabelText(/direção/i), { target: { value: '0' } })
      expect(engine.getState().cameras.find((c) => c.id === 'C2')!.heading).toBe(0)
      expect(engine.coverage.rebuilds).toBe(rebuilds + 1)
      const after = engine.coverage.entries('central-I1-I2')[0]?.cobertura ?? 0
      expect(before).toBeGreaterThanOrEqual(0.3)
      expect(after).toBeLessThan(0.3)
      // and the next C2 reading leaves central I1->I2 out
      engine.addCar('central', 450)
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const turned = readings.filter((r) => r.sensorId === 'C2').at(-1)!
      expect(turned.porTrecho.map((t) => t.trecho)).not.toContain('central-I1-I2')
      // range and FOV edits too
      fireEvent.change(within(row).getByLabelText(/alcance/i), { target: { value: '150' } })
      fireEvent.change(within(row).getByLabelText(/ângulo/i), { target: { value: '40' } })
      expect(engine.getState().cameras.find((c) => c.id === 'C2')).toMatchObject({ heading: 0, fov: 40, range: 150 })
      // back to the original cone, looking east: the next reading covers central I1->I2 again
      fireEvent.change(within(row).getByLabelText(/alcance/i), { target: { value: '260' } })
      fireEvent.change(within(row).getByLabelText(/ângulo/i), { target: { value: '70' } })
      fireEvent.change(within(row).getByLabelText(/direção/i), { target: { value: '90' } })
      engine.addCar('central', 450)
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const c2 = readings.filter((r) => r.sensorId === 'C2').at(-1)!
      expect(c2.porTrecho.map((t) => t.trecho)).toContain('central-I1-I2')
      // out-of-range input is shown clamped
      fireEvent.change(within(row).getByLabelText(/ângulo/i), { target: { value: '300' } })
      expect(within(row).getByLabelText(/ângulo/i)).toHaveValue(170)
    })

    it('adds the next camera at the centre and removes a camera with its coverage', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      render(<App engine={engine} transport={new FakeTransport(true)} />)
      const panel = screen.getByRole('region', { name: /câmeras/i })
      fireEvent.click(within(panel).getByRole('button', { name: 'Adicionar câmera' }))
      const c4 = engine.getState().cameras.find((c) => c.id === 'C4')!
      expect(c4).toEqual({ id: 'C4', position: { x: 500, y: 300 }, heading: 90, fov: 60, range: 200 })
      expect(within(panel).getByTestId('camera-C4')).toBeInTheDocument()
      expect(cones(redraw())).toBe(4)
      expect(engine.coverage.entries('central-I1-I2').map((e) => e.sensorId).sort()).toEqual(['C2', 'C4'])
      fireEvent.click(within(panel).getByRole('button', { name: 'Adicionar câmera' }))
      expect(engine.getState().cameras.map((c) => c.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])

      fireEvent.click(within(within(panel).getByTestId('camera-C2')).getByRole('button', { name: 'Remover' }))
      expect(engine.getState().cameras.map((c) => c.id)).toEqual(['C1', 'C3', 'C4', 'C5'])
      expect(within(panel).queryByTestId('camera-C2')).toBeNull()
      expect(cones(redraw())).toBe(4)
      for (const s of engine.getState().segments) {
        expect(engine.coverage.entries(s.id).map((e) => e.sensorId)).not.toContain('C2')
      }
      // after removing C5, the next one added is C6 (ids are never reused)
      fireEvent.click(within(within(panel).getByTestId('camera-C5')).getByRole('button', { name: 'Remover' }))
      fireEvent.click(within(panel).getByRole('button', { name: 'Adicionar câmera' }))
      expect(engine.getState().cameras.map((c) => c.id)).toContain('C6')
    })
  })

  describe('App', () => {
    it('titles the page for the traffic control centre and never says drone', () => {
      vi.useFakeTimers()
      render(<App engine={new SimulationEngine({ ratePerMinute: 30 })} transport={new FakeTransport(true)} />)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Central de trânsito — gestão de tráfego')
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(document.body.textContent).not.toMatch(/drone/i)
      // nor in labels a screen reader reads
      for (const el of document.querySelectorAll('[aria-label]')) expect(el.getAttribute('aria-label')).not.toMatch(/drone/i)
      // the page title lives in index.html, which jsdom does not load: read it
      const html = readFileSync(`${process.cwd()}/index.html`, 'utf8')
      expect(html).toMatch(/<title>Central de trânsito — gestão de tráfego<\/title>/)
      expect(html).not.toMatch(/drone/i)
    })
  })
})
