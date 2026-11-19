import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { notificationTopic, type DriverNotification } from '../apps/AppNotifier'
import { pairOf } from '../sensors/PlateCamera'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { fitTransform, laneStyle } from './draw'
import { segmentTooltip } from './tooltip'

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
const near = (a: number, b: number) => Math.abs(a - b) < 0.5

/** Screen position of a map point: the canvas fills the mocked 1000 x 600 container. */
const screenOf = (engine: SimulationEngine, p: Point) => fitTransform(engine.getState().network, 1000, 600).map(p)
const onLane = (engine: SimulationEngine, id: string, d: number) => screenOf(engine, pointOnSegment(engine.segment(id)!, d))
/** Strokes that run exactly along a segment's lane. */
function laneStrokes(engine: SimulationEngine, frame: Call[], id: string) {
  const [a, b] = engine.segment(id)!.points.map((p) => screenOf(engine, p))
  return strokes(frame).filter((s) => s.points.length === 2 && near(s.points[0][0], a.x) && near(s.points[0][1], a.y) && near(s.points[1][0], b.x) && near(s.points[1][1], b.y))
}

const STREETS = ['Al. Santos', 'Al. Jaú', 'Al. Itu', 'Al. Franca', 'R. da Consolação', 'R. Bela Cintra', 'R. Haddock Lobo', 'R. Augusta']

describe('render cidade', () => {
  it('accident mode click on a segment adds a blockage marked on the map', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const canvas = document.querySelector('canvas')!
    fireEvent.click(screen.getByRole('button', { name: 'Acidente' }))
    const p = onLane(engine, 'I12>I13', 70)
    fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
    fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
    const [b] = engine.getState().blockages
    expect(engine.getState().blockages).toHaveLength(1)
    expect(b.segmentId).toBe('I12>I13')
    expect(Math.abs(b.distance - 70)).toBeLessThan(2)
    const at = onLane(engine, 'I12>I13', b.distance)
    const marker = screen.getByTestId(`marker-colisao:${b.id}`)
    expect(near(parseFloat(marker.style.left), at.x) && near(parseFloat(marker.style.top), at.y)).toBe(true)
  })

  it('draws only roads lights street labels unit icons and incidents', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(engine.getState().cars.length).toBeGreaterThan(10)
    const frame = redraw()
    // every lane of every segment, each direction its own line
    for (const s of engine.getState().segments) expect(laneStrokes(engine, frame, s.id).length, s.id).toBeGreaterThanOrEqual(1)
    // street labels and unit icons sit on top of the canvas (AD-048, AD-062)
    for (const name of STREETS) expect(screen.getByTestId(`street-${name}`)).toHaveTextContent(name)
    for (const u of engine.getState().cameras) expect(screen.getByRole('img', { name: new RegExp(`^${u.id} · `) })).toBeInTheDocument()
    expect(frame.filter((c) => c.op === 'fillText')).toHaveLength(0)
    expect(document.querySelector('.map-overlay')!.textContent).not.toMatch(/origem|destino/i)
    // lights: one dot per phase at each of the 16 corners
    expect(frame.filter((c) => c.op === 'arc')).toHaveLength(32)
    // no camera cone nor radar beam (AD-062)
    expect(frame.filter((c) => c.op === 'closePath')).toHaveLength(0)
    // filled squares: only the background; no car
    expect(frame.filter((c) => c.op === 'fillRect')).toHaveLength(1)
    // no background map
    expect(frame.some((c) => c.op === 'drawImage')).toBe(false)
  })

  it('colours each segment by its density level', () => {
    expect(laneStyle('livre')).toEqual({ color: '#3DBE7A', dash: [] })
    expect(laneStyle('moderado')).toEqual({ color: '#F5D04E', dash: [] })
    expect(laneStyle('intenso')).toEqual({ color: '#F59544', dash: [] })
    expect(laneStyle('critico')).toEqual({ color: '#F0565B', dash: [] })
    expect(laneStyle('sem dado').color).toBe('#5B6676')
    expect(laneStyle('sem dado').dash.length).toBeGreaterThan(0)
    // on the map, before any reading: every lane grey and dashed
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const frame = redraw()
    for (const s of engine.getState().segments) {
      const lane = laneStrokes(engine, frame, s.id).at(-1)!
      expect(lane.style).toBe('#5B6676')
      expect(lane.dashed).toBe(true)
    }
  })

  it('paints each drawn lane by its own direction state', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    const transport = new FakeTransport(true)
    render(<App engine={engine} transport={transport} />)
    act(() => {
      // flows over the configured capacity (~844 veh/h, AD-087): 300 veh/h is Livre, 540 veh/h Moderado
      for (const [trecho, v, fluxo] of [['I12>I13', 3, 2], ['I13>I12', 45, 5], ['I22>I23', 30, 9]] as const) deliverMetrics(transport, trecho, 0, { k: 4 / 0.12, v, ocupacao: 4, fluxoVeicMin: fluxo })
    })
    const frame = redraw()
    const at = (id: string) => laneStrokes(engine, frame, id).at(-1)!
    // 3 km/h is below 15 km/h: critical; the other direction, at 36 % of its configured capacity, is free
    expect(at('I12>I13')).toEqual({ points: expect.anything(), style: '#F0565B', dashed: false })
    expect(at('I13>I12')).toEqual({ points: expect.anything(), style: '#3DBE7A', dashed: false })
    expect(at('I22>I23')).toEqual({ points: expect.anything(), style: '#F5D04E', dashed: false })
    expect(at('I23>I22')).toEqual({ points: expect.anything(), style: '#5B6676', dashed: true })
  })

  it('hovering a segment shows its tooltip with metrics and alerts', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const canvas = document.querySelector('canvas')!
    act(() => {
      vi.advanceTimersByTime(62_000)
    })
    act(() => {
      engine.addBlockage('I14>I13', 60)
    })
    const p = onLane(engine, 'I14>I13', 40)
    fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
    const tip = screen.getByRole('tooltip')
    expect(within(tip).getByTestId('tooltip-nome')).toHaveTextContent('Al. Santos, R. Augusta → R. Haddock Lobo')
    for (const id of ['estado', 'contagem', 'velocidade', 'densidade', 'unidade', 'confianca', 'idade']) expect(within(tip).getByTestId(`tooltip-${id}`)).toBeInTheDocument()
    // no camera pair on this block
    expect(within(tip).getByTestId('tooltip-unidade')).toHaveTextContent('estimado')
    expect(within(tip).getByTestId('tooltip-avisos')).toHaveTextContent('Acidente')
    // the segment the diversion steers app drivers away from carries the persistent-congestion warning; its opposite direction does not
    const jammed = segmentTooltip('I12>I13', null, undefined, 'critico', 0, 'I12>I13')
    expect(jammed.avisos.some((a) => /Congestionamento persistente/.test(a))).toBe(true)
    expect(segmentTooltip('I13>I12', null, undefined, 'livre', 0, 'I12>I13').avisos).toEqual([])
    expect(segmentTooltip('I12>I13', null, undefined, 'critico', 0, null).avisos).toEqual([])

    // a covered segment with a fresh reading shows the measured numbers
    const covered = 'I12>I13'
    const q = onLane(engine, covered, 60)
    fireEvent.mouseMove(canvas, { clientX: q.x, clientY: q.y })
    const tip2 = screen.getByRole('tooltip')
    expect(within(tip2).getByTestId('tooltip-nome')).toHaveTextContent(segmentName(covered))
    expect(within(tip2).getByTestId('tooltip-unidade')).toHaveTextContent('C02E · C02S')
    expect(within(tip2).getByTestId('tooltip-contagem')).toHaveTextContent(/^\d+ veíc$/)
    expect(within(tip2).getByTestId('tooltip-idade')).toHaveTextContent('2 s')
    expect(within(tip2).getByTestId('tooltip-confianca')).not.toHaveTextContent('0,00')

    // a segment with no camera pair: "estimado"
    const blind = engine.getState().segments.find((s) => pairOf(engine.getState().cameras, s.id) === null)!
    const r = onLane(engine, blind.id, blind.length / 2)
    fireEvent.mouseMove(canvas, { clientX: r.x, clientY: r.y })
    expect(within(screen.getByRole('tooltip')).getByTestId('tooltip-unidade')).toHaveTextContent('estimado')
    fireEvent.mouseLeave(canvas)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('clicking a segment shows its metrics in the segment panel', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120 })
    const transport = new FakeTransport(true)
    render(<App engine={engine} transport={transport} />)
    const canvas = document.querySelector('canvas')!
    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    const id = 'I22>I23'
    const p = onLane(engine, id, 60)
    fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
    fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
    expect(within(screen.getByRole('region', { name: 'Via selecionada' })).getByTestId('selected-name')).toHaveTextContent(segmentName(id))
    fireEvent.click(screen.getByRole('link', { name: 'Relatórios' }))
    const panel = screen.getByRole('region', { name: 'Métricas do trecho' })
    expect(within(panel).getByTestId('capacity-via')).toHaveTextContent(segmentName(id))
    expect(within(panel).getByTestId('capacity-unidade')).toHaveTextContent('C03E · C03S')
    expect(within(panel).getByTestId('capacity-contagem')).toHaveTextContent(/^\d+ veíc$/)
    expect(within(panel).getByTestId('capacity-densidade')).toHaveTextContent(/veíc\/km$/)
    expect(within(panel).getByTestId('capacity-fluxo')).toHaveTextContent(/veíc\/h$/)
    for (const t of ['velocidade', 'capacidade', 'folga', 'estado']) expect(within(panel).getByTestId(`capacity-${t}`)).not.toBeEmptyDOMElement()
    expect(within(panel).getByText('No trecho agora')).toBeInTheDocument()
    expect(within(panel).getByText('Velocidade (pareamento)')).toBeInTheDocument()
  })

  it('shows sem dado before the first reading', () => {
    render(<App engine={new SimulationEngine({ ratePerMinute: 30 })} transport={new FakeTransport(true)} />)
    for (const name of STREETS) expect(screen.getByTestId(`rank-${name}`)).toHaveTextContent('—')
    expect(screen.getByTestId('selected-level')).toHaveTextContent('Sem dado')
    fireEvent.click(screen.getByRole('link', { name: 'Relatórios' }))
    const panel = screen.getByRole('region', { name: 'Métricas do trecho' })
    expect(within(panel).getByTestId('capacity-estado')).toHaveTextContent('sem dado')
    expect(within(panel).getByTestId('capacity-contagem')).toHaveTextContent('sem dado')
    expect(within(panel).getByTestId('capacity-velocidade')).toHaveTextContent('sem dado')
  })

  it('app panel shows active drivers per app', () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120 })
    const transport = new FakeTransport(true)
    render(<App engine={engine} transport={transport} />)
    expect(screen.getByTestId('apps-ativos-total')).toHaveTextContent('—')
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    const last = transport.published.filter((m) => m.topic === 'transito/apps/ativos').at(-1)!
    const msg = JSON.parse(last.payload)
    expect(msg.total).toBeGreaterThan(0)
    expect(screen.getByTestId('apps-ativos-total')).toHaveTextContent(String(msg.total))
    for (const a of ['waze', 'google-maps', 'outros']) expect(screen.getByTestId(`apps-ativos-${a}`)).toHaveTextContent(String(msg.porApp[a]))
  })

  it('app panel lists notifications per app and the last 10', () => {
    const transport = new FakeTransport(true)
    render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={transport} />)
    const apps = [...Array(5).fill('waze'), ...Array(6).fill('google-maps'), 'outros'] as DriverNotification['app'][]
    act(() => {
      apps.forEach((app, i) => {
        const n: DriverNotification = {
          ts: i * 1000,
          app,
          motorista: `sessao-${i}`,
          trechoEvitado: 'I12>I13',
          rotaSugerida: ['I12>I22', 'I22>I23', 'I23>I13'],
          ganhoS: 30,
          mensagem: 'x',
        }
        transport.deliver(notificationTopic(app), JSON.stringify(n))
      })
    })
    expect(screen.getByTestId('apps-enviadas-waze')).toHaveTextContent('5')
    expect(screen.getByTestId('apps-enviadas-google-maps')).toHaveTextContent('6')
    expect(screen.getByTestId('apps-enviadas-outros')).toHaveTextContent('1')
    expect(screen.getByTestId('apps-enviadas-total')).toHaveTextContent('12')
    const items = screen.getAllByTestId('apps-notificacao')
    expect(items).toHaveLength(10)
    // newest first: the last one sent went to "Outros"
    expect(items[0]).toHaveTextContent('Outros')
    expect(items[0]).toHaveTextContent(`evitar ${segmentName('I12>I13')}`)
    expect(items[0]).toHaveTextContent('R. Bela Cintra → Al. Jaú → R. Haddock Lobo')
  })
})
