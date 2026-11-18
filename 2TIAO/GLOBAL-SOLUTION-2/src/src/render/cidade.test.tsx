import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { notificationTopic, type DriverNotification } from '../apps/AppNotifier'
import { bearing } from '../sensors/camera'
import { COVERAGE_MIN } from '../sensors/coverage'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { FakeTransport } from '../telemetry/testing'
import { fitTransform, segmentStyle } from './draw'
import { RoadTable } from './RoadTable'
import { fusedStatus, sortRoads } from './roads'
import { coveringUnit } from './tooltip'

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
  it('accident mode click on a segment adds a blockage drawn on the map', () => {
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
    const marker = onLane(engine, 'I12>I13', b.distance)
    const frame = redraw()
    const square = frame.find((c) => c.op === 'fillRect' && c.fillStyle === '#dc2626')!
    expect(square).toBeDefined()
    const [x, y, w, h] = square.args as number[]
    expect(near(x + w / 2, marker.x) && near(y + h / 2, marker.y)).toBe(true)
    expect(frame.some((c) => c.op === 'fillText' && c.args[0] === '✕')).toBe(true)
  })

  it('changing a unit heading in the panel recomputes coverage', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const covers = (id: string) => engine.coverage.entries(id).some((e) => e.sensorId === 'U01' && e.cobertura >= COVERAGE_MIN)
    expect(covers('I11>I12')).toBe(true)
    const net = engine.getState().network.intersections
    const toJau = bearing(net.find((i) => i.id === 'I11')!.position, net.find((i) => i.id === 'I21')!.position)
    const row = screen.getByTestId('camera-U01')
    fireEvent.change(within(row).getByLabelText(/Direção/), { target: { value: String(toJau) } })
    expect(engine.getState().cameras.find((c) => c.id === 'U01')!.heading).toBe(toJau)
    expect(covers('I11>I12')).toBe(false)
    expect(covers('I11>I21')).toBe(true)
    expect(within(screen.getByTestId('camera-U01')).getByLabelText(/Direção/)).toHaveValue(toJau)
  })

  it('draws only roads street names lights units and blockages', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120, noisePct: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(engine.getState().cars.length).toBeGreaterThan(10)
    const frame = redraw()
    // every lane of every segment, each direction its own line
    for (const s of engine.getState().segments) expect(laneStrokes(engine, frame, s.id).length, s.id).toBeGreaterThanOrEqual(1)
    const texts = frame.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]))
    for (const name of STREETS) expect(texts).toContain(name)
    for (const u of engine.getState().cameras) expect(texts).toContain(u.id)
    expect(texts.some((t) => /origem|destino/i.test(t))).toBe(false)
    // lights: one dot per phase at each of the 16 corners
    expect(frame.filter((c) => c.op === 'arc')).toHaveLength(32)
    // units: a camera cone and a radar beam each
    expect(frame.filter((c) => c.op === 'closePath')).toHaveLength(2 * 12)
    // filled squares: the background and the 12 unit bodies; no car, no blockage yet
    expect(frame.filter((c) => c.op === 'fillRect')).toHaveLength(1 + 12)
    // no background map
    expect(frame.some((c) => c.op === 'drawImage')).toBe(false)
  })

  it('colours each segment by its fused state', () => {
    expect(segmentStyle('fluindo')).toEqual({ color: '#22c55e', dash: [] })
    expect(segmentStyle('carregado')).toEqual({ color: '#facc15', dash: [] })
    expect(segmentStyle('congestionado')).toEqual({ color: '#ef4444', dash: [] })
    expect(segmentStyle('sem dados').color).toBe('#94a3b8')
    expect(segmentStyle('sem dados').dash.length).toBeGreaterThan(0)
    // the state is the AD-006 rule on the newest fused reading; none for 20 s -> sem dados
    const f = (v: number | null, at: number | null) => ({ contagem: 1, densidade: 1, velocidadeMedia: v, alertas: [], demandaOD: null, fontes: [], confianca: 1, atualizadoEm: at, estimado: false })
    expect(fusedStatus(f(40, 50_000), 60_000)).toBe('fluindo')
    expect(fusedStatus(f(39.9, 50_000), 60_000)).toBe('carregado')
    expect(fusedStatus(f(25, 50_000), 60_000)).toBe('carregado')
    expect(fusedStatus(f(24.9, 50_000), 60_000)).toBe('congestionado')
    expect(fusedStatus(f(null, 50_000), 60_000)).toBe('fluindo')
    expect(fusedStatus(f(10, 40_000), 60_000)).toBe('congestionado')
    expect(fusedStatus(f(10, 39_999), 60_000)).toBe('sem dados')
    expect(fusedStatus(f(10, null), 60_000)).toBe('sem dados')
    expect(fusedStatus(undefined, 60_000)).toBe('sem dados')
    // on the map, before any reading: every lane grey and dashed
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const frame = redraw()
    for (const s of engine.getState().segments) {
      const lane = laneStrokes(engine, frame, s.id).at(-1)!
      expect(lane.style).toBe('#94a3b8')
      expect(lane.dashed).toBe(true)
    }
  })

  it('hovering a segment shows its tooltip with metrics and alerts', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120, noisePct: 0 })
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
    expect(within(tip).getByTestId('tooltip-unidade')).toHaveTextContent(coveringUnit(engine.coverage.entries('I14>I13')))
    expect(within(tip).getByTestId('tooltip-avisos')).toHaveTextContent('Acidente')

    // a covered segment with a fresh reading shows the measured numbers
    const covered = 'I12>I13'
    const q = onLane(engine, covered, 60)
    fireEvent.mouseMove(canvas, { clientX: q.x, clientY: q.y })
    const tip2 = screen.getByRole('tooltip')
    expect(within(tip2).getByTestId('tooltip-nome')).toHaveTextContent(segmentName(covered))
    expect(within(tip2).getByTestId('tooltip-unidade')).toHaveTextContent(/^U02 \(\d+%\)$/)
    expect(within(tip2).getByTestId('tooltip-contagem')).toHaveTextContent(/^\d+ veíc$/)
    expect(within(tip2).getByTestId('tooltip-idade')).toHaveTextContent('2 s')
    expect(within(tip2).getByTestId('tooltip-confianca')).not.toHaveTextContent('0,00')

    // a segment no unit reaches: "estimado"
    const blind = engine.getState().segments.find((s) => engine.coverage.entries(s.id).length === 0)!
    const r = onLane(engine, blind.id, blind.length / 2)
    fireEvent.mouseMove(canvas, { clientX: r.x, clientY: r.y })
    expect(within(screen.getByRole('tooltip')).getByTestId('tooltip-unidade')).toHaveTextContent('estimado')
    fireEvent.mouseLeave(canvas)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('clicking a segment shows its metrics in the segment panel', { timeout: 60_000 }, () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 120, noisePct: 0 })
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
    const panel = screen.getByRole('region', { name: 'Métricas do trecho' })
    expect(within(panel).getByTestId('capacity-via')).toHaveTextContent(segmentName(id))
    expect(within(panel).getByTestId('capacity-unidade')).toHaveTextContent(/^U03 \(\d+%\)$/)
    expect(within(panel).getByTestId('capacity-contagem')).toHaveTextContent(/^\d+ veíc$/)
    expect(within(panel).getByTestId('capacity-densidade')).toHaveTextContent(/veíc\/km$/)
    expect(within(panel).getByTestId('capacity-fluxo')).toHaveTextContent(/veíc\/h$/)
    for (const t of ['velocidade', 'capacidade', 'folga', 'estado']) expect(within(panel).getByTestId(`capacity-${t}`)).not.toBeEmptyDOMElement()
    expect(within(panel).getByText('Contagem (câmera)')).toBeInTheDocument()
    expect(within(panel).getByText('Velocidade (radar)')).toBeInTheDocument()
  })

  it('orders the road table from worst to best', () => {
    const rows = [
      { id: 'a', estado: 'fluindo' as const, velocidade: 45 },
      { id: 'b', estado: 'sem dados' as const, velocidade: null },
      { id: 'c', estado: 'congestionado' as const, velocidade: 20 },
      { id: 'd', estado: 'carregado' as const, velocidade: 30 },
      { id: 'e', estado: 'congestionado' as const, velocidade: 12 },
      { id: 'f', estado: 'fluindo' as const, velocidade: null },
    ]
    expect(sortRoads(rows).map((r) => r.id)).toEqual(['e', 'c', 'd', 'a', 'f', 'b'])
    // the table renders the 48 segments in that order
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    const ids = engine.getState().segments.map((s) => s.id)
    const fused = (v: number | null) => ({ contagem: null, densidade: null, velocidadeMedia: v, alertas: [], demandaOD: null, fontes: [], confianca: 0, atualizadoEm: null, estimado: false })
    const status: Record<string, 'fluindo' | 'carregado' | 'congestionado' | 'sem dados'> = Object.fromEntries(ids.map((id) => [id, 'sem dados' as const]))
    const fusedState = Object.fromEntries(ids.map((id) => [id, fused(null)]))
    Object.assign(status, { 'I11>I12': 'congestionado', 'I22>I23': 'congestionado', 'I33>I34': 'carregado' })
    Object.assign(fusedState, { 'I11>I12': fused(20), 'I22>I23': fused(12), 'I33>I34': fused(30) })
    render(<RoadTable segmentIds={ids} status={status} fused={fusedState} units={{}} selected="" onSelect={() => {}} />)
    const order = screen.getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'))
    expect(order).toHaveLength(48)
    expect(order.slice(0, 3)).toEqual(['road-I22>I23', 'road-I11>I12', 'road-I33>I34'])
  })

  it('clicking a table row selects and highlights the segment', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0 })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const id = 'I33>I34'
    fireEvent.click(screen.getByTestId(`road-${id}`))
    expect(screen.getByTestId(`road-${id}`)).toHaveAttribute('aria-selected', 'true')
    expect(within(screen.getByRole('region', { name: 'Métricas do trecho' })).getByTestId('capacity-via')).toHaveTextContent(segmentName(id))
    const halo = laneStrokes(engine, redraw(), id).filter((s) => s.style === '#f8fafc')
    expect(halo).toHaveLength(1)
  })

  it('shows sem dado before the first reading', () => {
    render(<App engine={new SimulationEngine({ ratePerMinute: 30 })} transport={new FakeTransport(true)} />)
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid')?.startsWith('road-'))
    expect(rows).toHaveLength(48)
    for (const r of rows) expect(r).toHaveTextContent('sem dado')
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
