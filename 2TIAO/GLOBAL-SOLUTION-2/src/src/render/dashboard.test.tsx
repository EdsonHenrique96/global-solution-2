import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { notificationTopic, type DriverNotification } from '../apps/AppNotifier'
import { pairOf } from '../sensors/PlateCamera'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { DashboardHeader } from './Dashboard'
import { clampView, fitTransform, gridCenter, gridOf, type MapView } from './draw'
import { NIVEIS } from './levels'

interface Call {
  op: string
  args: unknown[]
  strokeStyle: unknown
  dash: unknown
}
let calls: Call[] = []

const W = 1000
const H = 600

beforeEach(() => {
  calls = []
  vi.useFakeTimers()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const props: Record<string | symbol, unknown> = { dash: [] }
    return new Proxy(props, {
      get(target, key) {
        if (key === 'setLineDash') return (d: unknown) => {
          target.dash = d
        }
        if (key in target) return target[key]
        return (...args: unknown[]) => {
          // keep only the frame being drawn: the animation loop runs on every faked frame
          if (key === 'clearRect') calls = []
          calls.push({ op: String(key), args, strokeStyle: target.strokeStyle, dash: target.dash })
        }
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    }) as never
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => W)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => H)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const STREETS = ['Al. Santos', 'Al. Jaú', 'Al. Itu', 'Al. Franca', 'R. da Consolação', 'R. Bela Cintra', 'R. Haddock Lobo', 'R. Augusta']
const LEVEL = { livre: '#3DBE7A', moderado: '#F5D04E', intenso: '#F59544', critico: '#F0565B', aprendendo: '#8A96A8', semDado: '#5B6676' }

function setup({ cameras = false, connected = true, rate = 0 } = {}) {
  const engine = new SimulationEngine({ ratePerMinute: rate, ...(cameras ? {} : { cameras: [] }) })
  const transport = new FakeTransport(connected)
  render(<App engine={engine} transport={transport} />)
  return { engine, transport }
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

const tab = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Seções' })).getByRole('link', { name }))

/** Each segment's metrics with `contagem` veh/km at `v` km/h (flow k × v). */
const send = (transport: FakeTransport, ts: number, porTrecho: { trecho: string; contagem: number; v: number | null }[]) =>
  act(() => {
    for (const p of porTrecho) deliverMetrics(transport, p.trecho, ts, { k: p.contagem, v: p.v })
  })

/**
 * Teaches segments a capacity of 1 250 veh/h (Greenshields, vf 50 km/h, kj 100 veh/km = 21 cars/min),
 * then a last reading of `k` veh/km at `v` km/h for each; returns once the last window is in (11 s later).
 */
function learn(transport: FakeTransport, engine: SimulationEngine, last: Record<string, { k: number; v: number }>) {
  const now = engine.getState().timeMs
  const ids = Object.keys(last)
  for (let i = 0; i < 30; i++) {
    const k = 5 + (i % 19) * 5
    send(transport, now - 60 + i, ids.map((trecho) => ({ trecho, contagem: k, v: 50 * (1 - k / 100) })))
  }
  send(transport, now, ids.map((trecho) => ({ trecho, contagem: last[trecho].k, v: last[trecho].v })))
  advance(11_000)
}

function lastFrame(): Call[] {
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  return calls
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) < tol

/** The colour and dash of the lane stroke drawn along a segment, under the current view. */
function laneOf(engine: SimulationEngine, frame: Call[], id: string, view?: MapView) {
  const fit = fitTransform(engine.getState().network, W, H, view)
  const [a, b] = engine.segment(id)!.points.map((p) => fit.map(p))
  let cur: number[][] = []
  let found: { style: unknown; dashed: boolean } | undefined
  for (const c of frame) {
    if (c.op === 'beginPath') cur = []
    else if (c.op === 'moveTo' || c.op === 'lineTo') cur.push(c.args as number[])
    else if (c.op === 'stroke' && cur.length === 2 && near(cur[0][0], a.x) && near(cur[0][1], a.y) && near(cur[1][0], b.x) && near(cur[1][1], b.y)) {
      found = { style: c.strokeStyle, dashed: Array.isArray(c.dash) && c.dash.length > 0 }
    }
  }
  return found!
}

const screenOf = (engine: SimulationEngine, p: Point, view?: MapView) => fitTransform(engine.getState().network, W, H, view).map(p)
const onLane = (engine: SimulationEngine, id: string, d: number) => screenOf(engine, pointOnSegment(engine.segment(id)!, d))
const click = (p: Point) => {
  const canvas = document.querySelector('canvas')!
  fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
  fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
}
const corner = (engine: SimulationEngine, id: string) => engine.getState().network.intersections.find((i) => i.id === id)!
const mode = (name: string) => fireEvent.click(within(screen.getByRole('group', { name: 'Criar incidente' })).getByRole('button', { name }))
const layer = (name: string) => within(screen.getByRole('group', { name: 'Camadas do mapa' })).getByRole('button', { name })
const panel = () => screen.getByRole('region', { name: 'Incidentes' })
const selected = () => screen.getByRole('region', { name: 'Via selecionada' })

describe('operations dashboard', () => {
  it('C3 each tab shows its panels and is marked current', () => {
    setup()
    const links = within(screen.getByRole('navigation', { name: 'Seções' })).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual(['Mapa ao vivo', 'Câmeras', 'Semáforos', 'Desvio', 'Relatórios'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#mapa', '#cameras', '#semaforos', '#desvio', '#relatorios'])
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Mapa de tráfego' })).toBeInTheDocument()
    expect(document.title).toBe('Mapa ao vivo · Centro de Operações de Tráfego')

    tab('Câmeras')
    // each menu item is a page: its own address and title (AD-111)
    expect(window.location.hash).toBe('#cameras')
    expect(document.title).toBe('Câmeras · Centro de Operações de Tráfego')
    expect(links[1]).toHaveAttribute('aria-current', 'page')
    expect(links[0]).not.toHaveAttribute('aria-current')
    expect(screen.queryByRole('region', { name: 'Mapa de tráfego' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Câmeras de placa' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Eventos das câmeras' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Agente' })).toBeNull()

    // Semáforos shows the lights: the 16 corners and the adaptive control, nothing of the diversion
    tab('Semáforos')
    expect(links[2]).toHaveAttribute('aria-current', 'page')
    const signals = screen.getByRole('region', { name: 'Semáforos' })
    expect(within(signals).getAllByTestId(/^signal-I\d\d$/)).toHaveLength(16)
    expect(within(signals).getByRole('button', { name: 'Controle de semáforos' })).toBeInTheDocument()
    for (const name of ['Agente', 'Apps de mapa', 'Desvio parcial', 'Câmeras de placa']) expect(screen.queryByRole('region', { name })).toBeNull()
    expect(screen.queryByRole('slider', { name: /carros por minuto/i })).toBeNull()

    // Desvio: the diversion with its switch, the agent and the apps
    tab('Desvio')
    expect(links[3]).toHaveAttribute('aria-current', 'page')
    expect(within(screen.getByRole('region', { name: 'Desvio parcial' })).getByRole('button', { name: 'Desvio parcial' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Agente' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Apps de mapa' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Semáforos' })).toBeNull()

    // Relatórios: series, the capacity model, the states, the history, the simulation and the experiments
    tab('Relatórios')
    expect(links[4]).toHaveAttribute('aria-current', 'page')
    for (const name of ['Métricas', 'Experimentos', 'Curva de capacidade', 'Histórico de incidentes', 'Estados do tráfego']) expect(screen.getByRole('region', { name })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Controle da simulação' })).getByRole('slider', { name: /carros por minuto/i })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Agente' })).toBeNull()
    // the diversion's state is only on Desvio
    expect(within(screen.getByRole('region', { name: 'Página Relatórios' })).queryByTestId('diversion-state')).toBeNull()

    // back/forward (popstate) and an edited address (hashchange) open the page of the address
    act(() => {
      window.history.replaceState(null, '', '#desvio')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(links[3]).toHaveAttribute('aria-current', 'page')
    act(() => {
      window.history.replaceState(null, '', '#semaforos')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(links[2]).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Semáforos' })).toBeInTheDocument()
  })

  it('C3 an address opens its page and the map cards open the page of their detail (AD-111)', () => {
    window.history.replaceState(null, '', '#desvio')
    setup()
    const link = (name: string) => within(screen.getByRole('navigation', { name: 'Seções' })).getByRole('link', { name })
    expect(link('Desvio')).toHaveAttribute('aria-current', 'page')
    tab('Mapa ao vivo')
    for (const [card, page] of [
      ['card-cameras', 'Câmeras'],
      ['card-semaforos', 'Semáforos'],
      ['card-notificados', 'Desvio'],
      ['card-viagem', 'Relatórios'],
    ] as const) {
      fireEvent.click(screen.getByTestId(card))
      expect(link(page)).toHaveAttribute('aria-current', 'page')
      tab('Mapa ao vivo')
    }
    // the network's own numbers have no other page
    for (const card of ['card-fluxo', 'card-velocidade', 'card-incidentes', 'card-ocupacao']) expect(screen.getByTestId(card).tagName).toBe('DIV')
  })

  it('C4 returning to the map keeps the selected road and the layers', () => {
    setup()
    fireEvent.click(screen.getByTestId('street-Al. Itu'))
    const name = within(selected()).getByTestId('selected-name').textContent
    expect(name).toMatch(/^Al\. Itu, /)
    fireEvent.click(layer('Câmeras'))
    fireEvent.click(layer('Densidade'))
    tab('Relatórios')
    tab('Mapa ao vivo')
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(name!)
    expect(layer('Câmeras')).toHaveAttribute('aria-pressed', 'false')
    expect(layer('Densidade')).toHaveAttribute('aria-pressed', 'false')
    expect(layer('Incidentes')).toHaveAttribute('aria-pressed', 'true')
  })

  it('C5 shows the live badge from the broker state and the simulated clock', () => {
    const { transport } = setup({ connected: false })
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
    act(() => {
      transport.setConnected(true)
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByText('AO VIVO')).toBeInTheDocument()
    // the simulated clock starts on Monday 07:00 (AD-077)
    expect(screen.getByTestId('sim-clock')).toHaveTextContent('Seg 07:00')
    cleanup()
    render(<DashboardHeader connection="connected" simTimeMs={3_665_000} pending={0} active="mapa" onNavigate={() => {}} />)
    expect(screen.getByTestId('sim-clock')).toHaveTextContent('Seg 08:01')
  })

  it('C6 the bell shows the pending dot and opens Desvio', () => {
    const go = vi.fn()
    const { rerender } = render(<DashboardHeader connection="connected" simTimeMs={0} pending={0} active="mapa" onNavigate={go} />)
    expect(screen.queryByTestId('bell-dot')).toBeNull()
    rerender(<DashboardHeader connection="connected" simTimeMs={0} pending={2} active="mapa" onNavigate={go} />)
    expect(screen.getByTestId('bell-dot')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Notificações: 2 aguardando aprovação' }))
    expect(go).toHaveBeenCalledWith('desvio')
  })

  it('C6 the bell in the page opens Desvio', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))
    expect(screen.getByRole('link', { name: 'Desvio' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Agente' })).toBeInTheDocument()
  })

  it('C9 draws a segment with data by its configured capacity and no data dashed', () => {
    const { engine, transport } = setup()
    advance(1_000)
    // 10 veh/km at 45 km/h = 450 veh/h of the configured ~844 veh/h: 53 %, Moderado - never Aprendendo (AD-087)
    send(transport, engine.getState().timeMs, [{ trecho: 'I22>I23', contagem: 10, v: 45 }])
    const frame = lastFrame()
    expect(laneOf(engine, frame, 'I22>I23')).toEqual({ style: LEVEL.moderado, dashed: false })
    expect(laneOf(engine, frame, 'I23>I22')).toEqual({ style: LEVEL.semDado, dashed: true })
  })

  it('C10 paints each lane in its level colour and the legend lists the levels', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, {
      'I11>I12': { k: 10, v: 45 },
      'I12>I13': { k: 20, v: 40 },
      'I13>I14': { k: 30, v: 35 },
      'I21>I22': { k: 40, v: 30 },
    })
    const frame = lastFrame()
    expect(laneOf(engine, frame, 'I11>I12')).toEqual({ style: LEVEL.livre, dashed: false })
    expect(laneOf(engine, frame, 'I12>I13')).toEqual({ style: LEVEL.moderado, dashed: false })
    expect(laneOf(engine, frame, 'I13>I14')).toEqual({ style: LEVEL.intenso, dashed: false })
    expect(laneOf(engine, frame, 'I21>I22')).toEqual({ style: LEVEL.critico, dashed: false })
    const legend = screen.getByLabelText('Legenda da densidade')
    expect(legend).toHaveTextContent('Densidade (fluxo ÷ capacidade)')
    for (const t of ['Livre< 50%', 'Moderado50–74%', 'Intenso75–89%', 'Crítico≥ 90%', 'Aprendendo', 'Sem dado']) expect(legend).toHaveTextContent(t)
  })

  it('C11 density layer off paints every lane neutral and back', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I12>I13': { k: 20, v: 40 } })
    fireEvent.click(layer('Densidade'))
    expect(layer('Densidade')).toHaveAttribute('aria-pressed', 'false')
    const off = lastFrame()
    for (const s of engine.getState().segments) expect(laneOf(engine, off, s.id), s.id).toEqual({ style: '#3A4656', dashed: false })
    fireEvent.click(layer('Densidade'))
    const on = lastFrame()
    expect(laneOf(engine, on, 'I12>I13').style).toBe(LEVEL.moderado)
    expect(laneOf(engine, on, 'I13>I12')).toEqual({ style: LEVEL.semDado, dashed: true })
  })

  it('C12 every street label says Pista 50', () => {
    setup()
    for (const name of STREETS) expect(screen.getByTestId(`street-${name}`)).toHaveTextContent('Pista 50 · Média')
  })

  it('C13 shows one label per street with its worst segment', () => {
    const { engine, transport } = setup()
    advance(1_000)
    // Al. Santos: a moderate block and a free one; the moderate one is the label's
    learn(transport, engine, { 'I12>I13': { k: 20, v: 40 }, 'I11>I12': { k: 10, v: 45 } })
    const labels = screen.getAllByTestId(/^street-[A-Z]/)
    expect(labels.map((l) => l.getAttribute('data-testid'))).toEqual(STREETS.map((s) => `street-${s}`))
    const santos = screen.getByTestId('street-Al. Santos')
    // 20 veh/km x 40 km/h = 800 veh/h = 13 cars/min of 1 250 veh/h = 21 cars/min
    expect(santos).toHaveTextContent('Al. Santos13 / 21 carros/minPista 50 · Média 40 km/h')
    // no data on Al. Jaú: no flow, but its configured capacity (~844 veh/h = 14 cars/min, AD-087)
    expect(screen.getByTestId('street-Al. Jaú')).toHaveTextContent('Al. Jaú— / 14 carros/minPista 50 · Média — km/h')
    fireEvent.click(santos)
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(segmentName('I12>I13'))
  })

  it('C16 clicking a street label selects its segment', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I23>I22': { k: 30, v: 35 } })
    const jau = screen.getByTestId('street-Al. Jaú')
    expect(jau).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(jau)
    expect(jau).toHaveAttribute('aria-pressed', 'true')
    expect(jau).toHaveClass('on')
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(segmentName('I23>I22'))
    expect(screen.getByTestId('street-Al. Santos')).toHaveAttribute('aria-pressed', 'false')
    // and the map highlights it
    const halo = lastFrame().filter((c) => c.op === 'stroke' && c.strokeStyle === '#E6EAF0')
    expect(halo).toHaveLength(1)
  })

  it('C17 the label dot and current number take the level colour', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I12>I13': { k: 30, v: 35 }, 'I22>I23': { k: 40, v: 30 } })
    const santos = screen.getByTestId('street-Al. Santos')
    expect(within(santos).getByTestId('street-dot')).toHaveStyle({ background: LEVEL.intenso })
    expect(within(santos).getByTestId('street-atual')).toHaveStyle({ color: LEVEL.intenso })
    const jau = screen.getByTestId('street-Al. Jaú')
    expect(within(jau).getByTestId('street-dot')).toHaveStyle({ background: LEVEL.critico })
    expect(within(jau).getByTestId('street-atual')).toHaveStyle({ color: LEVEL.critico })
  })

  it('C19 unit icons show online after a reading and offline without broker', () => {
    setup({ cameras: true, connected: true })
    // the cameras publish their status every 10 s through the broker
    advance(10_000)
    expect(screen.getAllByRole('img', { name: / · online$/ })).toHaveLength(24)
    for (const icon of screen.getAllByRole('img', { name: / · online$/ })) expect(icon).toHaveStyle({ borderColor: '#7FB5FF' })
    expect(screen.getByTestId('card-cameras')).toHaveTextContent('24 / 24')
    expect(screen.getByTestId('card-cameras')).toHaveTextContent('todas enviando leitura')
    cleanupAndOffline()
  })

  it('C20 the cameras layer hides and shows the unit icons', () => {
    setup({ cameras: true })
    expect(screen.getAllByRole('img', { name: /^C\d{2}[ES] · / })).toHaveLength(24)
    fireEvent.click(layer('Câmeras'))
    expect(screen.queryAllByRole('img', { name: /^C\d{2}[ES] · / })).toHaveLength(0)
    fireEvent.click(layer('Câmeras'))
    expect(screen.getAllByRole('img', { name: /^C\d{2}[ES] · / })).toHaveLength(24)
  })

  it('C22 accident mode click creates a Colisão', () => {
    const { engine } = setup()
    advance(5_000)
    mode('Acidente')
    click(onLane(engine, 'I12>I13', 70))
    const [b] = engine.getState().blockages
    expect(b.segmentId).toBe('I12>I13')
    expect(b.endsAtMs - 5_000).toBe(120_000)
    const card = within(panel()).getByTestId(`incident-colisao:${b.id}`)
    expect(card).toHaveTextContent('Colisão')
    expect(card).toHaveTextContent('Crítico')
  })

  it('C42 a registered accident turns its lane Crítico at once, until it is cleared or expires (AD-110)', { timeout: 60_000 }, () => {
    const { engine } = setup()
    advance(5_000)
    const red = NIVEIS.critico.color
    // no camera reading: the lane is "sem dado" before the accident
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(NIVEIS['sem dado'].color)
    mode('Acidente')
    click(onLane(engine, 'I12>I13', 70))
    const [b] = engine.getState().blockages
    // red on the click, solid, with no measurement behind it
    expect(laneOf(engine, lastFrame(), 'I12>I13')).toEqual({ style: red, dashed: false })
    expect(within(selected()).getByTestId('selected-level')).toHaveTextContent('Crítico')
    advance(60_000)
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(red)
    // "Liberar via": back to what the cameras say
    fireEvent.click(within(within(panel()).getByTestId(`incident-colisao:${b.id}`)).getByRole('button', { name: 'Liberar via' }))
    expect(engine.getState().blockages).toHaveLength(0)
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(NIVEIS['sem dado'].color)
    // a second one (the mode stays on) expires after its 2 min
    click(onLane(engine, 'I12>I13', 70))
    expect(engine.getState().blockages).toHaveLength(1)
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(red)
    advance(119_000)
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(red)
    advance(2_000)
    expect(engine.getState().blockages).toHaveLength(0)
    expect(laneOf(engine, lastFrame(), 'I12>I13').style).toBe(NIVEIS['sem dado'].color)
  })

  it('C23 work mode click creates an Obra na pista', () => {
    const { engine } = setup()
    advance(5_000)
    mode('Obra')
    click(onLane(engine, 'I22>I23', 60))
    const [z] = engine.getState().workZones
    expect(z.segmentId).toBe('I22>I23')
    expect(z.endsAtMs - 5_000).toBe(600_000)
    expect(engine.getState().blockages).toHaveLength(0)
    const card = within(panel()).getByTestId(`incident-obra:${z.id}`)
    expect(card).toHaveTextContent('Obra na pista')
    expect(card).toHaveTextContent('Moderado')
  })

  it('C24 signal mode click on a corner makes it flashing', () => {
    const { engine } = setup()
    advance(5_000)
    mode('Semáforo')
    // a click on a lane away from any corner does nothing
    click(onLane(engine, 'I12>I13', engine.segment('I12>I13')!.length / 2))
    expect(engine.getState().flashing).toHaveLength(0)
    click(screenOf(engine, corner(engine, 'I23').position))
    const [f] = engine.getState().flashing
    expect(f.intersectionId).toBe('I23')
    expect(f.endsAtMs - 5_000).toBe(600_000)
    expect(engine.getState().lights.find((l) => l.intersectionId === 'I23')).toMatchObject({ h: 'piscante', v: 'piscante' })
    const card = within(panel()).getByTestId(`incident-semaforo:${f.id}`)
    expect(card).toHaveTextContent('Semáforo intermitente')
    expect(card).toHaveTextContent('Moderado')
    expect(card).toHaveTextContent(corner(engine, 'I23').nome)
  })

  it('C25 incident modes are exclusive', () => {
    setup()
    // the create modes carry a visible "Criar" label, as the layers carry "Camadas"; only "Acidente" is red
    const group = screen.getByRole('group', { name: 'Criar incidente' })
    expect(group.previousElementSibling).toHaveTextContent(/^Criar$/)
    expect(screen.getByRole('group', { name: 'Camadas do mapa' }).previousElementSibling).toHaveTextContent(/^Camadas$/)
    const dot = (b: HTMLElement) => (b.querySelector('.dot') as HTMLElement).style.background
    expect(dot(layer('Incidentes'))).toBe('rgb(201, 209, 220)')
    const btn = (name: string) => within(group).getByRole('button', { name })
    expect(dot(btn('Acidente'))).toBe('rgb(240, 86, 91)')
    const pressed = () => ['Acidente', 'Obra', 'Semáforo'].filter((n) => btn(n).getAttribute('aria-pressed') === 'true')
    expect(pressed()).toEqual([])
    mode('Acidente')
    expect(pressed()).toEqual(['Acidente'])
    mode('Obra')
    expect(pressed()).toEqual(['Obra'])
    mode('Semáforo')
    expect(pressed()).toEqual(['Semáforo'])
    mode('Semáforo')
    expect(pressed()).toEqual([])
  })

  it('C26 shows a map note for each incident type', { timeout: 60_000 }, () => {
    const { engine, transport } = setup()
    advance(1_000)
    // a jam that lasts: 5 windows under half the limit turns the diversion on
    for (let i = 0; i < 9; i++) {
      learn(transport, engine, { 'I12>I13': { k: 80, v: 10 } })
    }
    const b = engine.addBlockage('I33>I34', 40)
    const z = engine.addWorkZone('I22>I23')
    const f = engine.addFlashing('I32')
    advance(100)
    const now = engine.getState().timeMs
    const notes = screen.getAllByRole('note')
    const byTitle = (t: string) => notes.find((n) => n.textContent!.startsWith(t))!
    expect(notes).toHaveLength(4)
    const hhmm = (ms: number) => {
      const m = Math.floor(ms / 60_000)
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    }
    expect(byTitle('Colisão')).toHaveTextContent(`Colisãohá 0 min${segmentName('I33>I34')}Bloqueio a 40 m do cruzamento · libera em ${Math.round((b.endsAtMs - now) / 1000 / 60)} min`)
    expect(byTitle('Obra na pista')).toHaveTextContent(`Obra na pistahá 0 min${segmentName('I22>I23')}Velocidade reduzida a 20 km/h · até ${hhmm(z.endsAtMs)}`)
    expect(byTitle('Semáforo intermitente')).toHaveTextContent(`Semáforo intermitentehá 0 min${corner(engine, 'I32').nome}Amarelo piscante · normaliza às ${hhmm(f.endsAtMs)}`)
    expect(byTitle('Congestionamento persistente')).toHaveTextContent(/^Congestionamento persistentehá \d+ min/)
    expect(byTitle('Congestionamento persistente')).toHaveTextContent(`${segmentName('I12>I13')}Desvio ativo · `)
    // the jam's count is the diversion's notified drivers in this window, as Relatórios shows it
    const window = screen.getByTestId('diversion-state').textContent!.match(/(\d+) notificados na janela/)![1]
    expect(byTitle('Congestionamento persistente').textContent).toMatch(new RegExp(`Desvio ativo · ${window} motoristas notificados$`))
    // each marker, note and card in its type's colour, as in the prototype (AD-065)
    const colour = { colisao: '#F0565B', obra: '#F59544', semaforo: '#F5D04E', congestionamento: '#F59544' }
    const sev = (el: HTMLElement) => (el.closest('[style*="--sev"]') as HTMLElement).style.getPropertyValue('--sev')
    const jam = screen.getAllByTestId(/^marker-congestionamento:/)[0]
    expect(sev(screen.getByTestId(`marker-colisao:${b.id}`))).toBe(colour.colisao)
    expect(sev(screen.getByTestId(`marker-obra:${z.id}`))).toBe(colour.obra)
    expect(sev(screen.getByTestId(`marker-semaforo:${f.id}`))).toBe(colour.semaforo)
    expect(sev(jam)).toBe(colour.congestionamento)
    expect(sev(byTitle('Obra na pista'))).toBe(colour.obra)
    expect(sev(within(panel()).getByTestId(`incident-obra:${z.id}`))).toBe(colour.obra)
    expect(within(panel()).getByTestId(`incident-obra:${z.id}`)).toHaveTextContent('Moderado')
    // each with its marker at its place
    const at = screenOf(engine, pointOnSegment(engine.segment('I33>I34')!, 40))
    const marker = screen.getByTestId(`marker-colisao:${b.id}`)
    expect(near(parseFloat(marker.style.left), at.x) && near(parseFloat(marker.style.top), at.y)).toBe(true)
    const c = screenOf(engine, corner(engine, 'I32').position)
    const m2 = screen.getByTestId(`marker-semaforo:${f.id}`)
    expect(near(parseFloat(m2.style.left), c.x) && near(parseFloat(m2.style.top), c.y)).toBe(true)
    // minutes go by
    advance(3 * 60_000)
    expect(screen.getAllByRole('note').find((n) => n.textContent!.startsWith('Obra'))).toHaveTextContent('há 3 min')
  })

  it('C27 the incidents layer hides markers and notes but not the panel', () => {
    const { engine } = setup()
    const z = engine.addWorkZone('I22>I23')
    advance(100)
    expect(screen.getAllByRole('note')).toHaveLength(1)
    fireEvent.click(layer('Incidentes'))
    expect(screen.queryAllByRole('note')).toHaveLength(0)
    expect(screen.queryByTestId(`marker-obra:${z.id}`)).toBeNull()
    expect(within(panel()).getByTestId(`incident-obra:${z.id}`)).toBeInTheDocument()
    fireEvent.click(layer('Incidentes'))
    expect(screen.getAllByRole('note')).toHaveLength(1)
  })

  it('C28 the panel lists critical first then newest with the buttons of each type', () => {
    const { engine } = setup()
    const z = engine.addWorkZone('I22>I23')
    advance(1_000)
    const b = engine.addBlockage('I33>I34', 40)
    advance(1_000)
    const f = engine.addFlashing('I32')
    advance(1_000)
    const cards = within(panel()).getAllByRole('article')
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual([`incident-colisao:${b.id}`, `incident-semaforo:${f.id}`, `incident-obra:${z.id}`])
    const buttons = (c: HTMLElement) => within(c).getAllByRole('button').map((x) => x.textContent)
    expect(buttons(cards[0])).toEqual(['Ver trecho', 'Liberar via', 'Ver câmera'])
    expect(buttons(cards[1])).toEqual(['Ver trecho', 'Normalizar semáforo', 'Ver câmera'])
    expect(buttons(cards[2])).toEqual(['Ver trecho', 'Liberar via', 'Ver câmera'])
    expect(cards[0]).toHaveTextContent(`${segmentName('I33>I34')} · há 0 min`)
    expect(cards[0]).toHaveTextContent('Crítico')
    expect(cards[1]).toHaveTextContent('Moderado')
    // "Ver trecho": the segment, or the first one arriving at the corner
    fireEvent.click(within(cards[2]).getByRole('button', { name: 'Ver trecho' }))
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(segmentName('I22>I23'))
    fireEvent.click(within(cards[1]).getByRole('button', { name: 'Ver trecho' }))
    const into = engine.getState().segments.find((s) => s.to === 'I32')!.id
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(segmentName(into))
  })

  it('C29 Liberar via and Normalizar semáforo end the incident at once', () => {
    const { engine } = setup()
    const z = engine.addWorkZone('I22>I23')
    const f = engine.addFlashing('I32')
    const b = engine.addBlockage('I33>I34', 40)
    advance(100)
    expect(screen.getAllByRole('note')).toHaveLength(3)
    fireEvent.click(within(within(panel()).getByTestId(`incident-obra:${z.id}`)).getByRole('button', { name: 'Liberar via' }))
    expect(engine.getState().workZones).toHaveLength(0)
    expect(within(panel()).queryByTestId(`incident-obra:${z.id}`)).toBeNull()
    expect(screen.getAllByRole('note')).toHaveLength(2)
    fireEvent.click(within(within(panel()).getByTestId(`incident-semaforo:${f.id}`)).getByRole('button', { name: 'Normalizar semáforo' }))
    expect(engine.getState().flashing).toHaveLength(0)
    const l = engine.getState().lights.find((x) => x.intersectionId === 'I32')!
    expect([l.h, l.v]).not.toContain('piscante')
    expect(within(panel()).queryByTestId(`incident-semaforo:${f.id}`)).toBeNull()
    fireEvent.click(within(within(panel()).getByTestId(`incident-colisao:${b.id}`)).getByRole('button', { name: 'Liberar via' }))
    expect(engine.getState().blockages).toHaveLength(0)
    expect(screen.queryAllByRole('note')).toHaveLength(0)
    expect(within(panel()).getByText('Nenhum incidente ativo.')).toBeInTheDocument()
  })

  it('C30 Ver câmera opens Câmeras with the covering unit or is disabled', () => {
    const { engine } = setup({ cameras: true })
    const covered = 'I12>I13'
    // the camera pair of the segment: its entry camera
    const best = pairOf(engine.getState().cameras, covered)![0]
    const blind = engine.getState().segments.find((s) => pairOf(engine.getState().cameras, s.id) === null)!.id
    const zBlind = engine.addWorkZone(blind)
    const z = engine.addWorkZone(covered)
    advance(100)
    const off = within(within(panel()).getByTestId(`incident-obra:${zBlind.id}`)).getByRole('button', { name: 'Ver câmera' })
    expect(off).toBeDisabled()
    expect(off).toHaveAttribute('title', 'Nenhuma câmera cobre este local')
    fireEvent.click(within(within(panel()).getByTestId(`incident-obra:${z.id}`)).getByRole('button', { name: 'Ver câmera' }))
    expect(screen.getByRole('link', { name: 'Câmeras' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId(`camera-${best}`)).toHaveAttribute('aria-current', 'true')
    expect(document.querySelectorAll('[data-testid^="camera-"][aria-current]')).toHaveLength(1)
  })

  it('C31 Ver histórico opens the history in Relatórios', () => {
    const { engine } = setup()
    const z = engine.addWorkZone('I22>I23')
    advance(30_000)
    const b = engine.addBlockage('I33>I34', 40)
    advance(5_000)
    fireEvent.click(within(within(panel()).getByTestId(`incident-obra:${z.id}`)).getByRole('button', { name: 'Liberar via' }))
    advance(10_000)
    fireEvent.click(within(within(panel()).getByTestId(`incident-colisao:${b.id}`)).getByRole('button', { name: 'Liberar via' }))
    fireEvent.click(within(panel()).getByRole('link', { name: 'Ver histórico' }))
    expect(screen.getByRole('link', { name: 'Relatórios' })).toHaveAttribute('aria-current', 'page')
    const rows = within(screen.getByRole('region', { name: 'Histórico de incidentes' })).getAllByTestId('history-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent(`Colisão${segmentName('I33>I34')}00:00:3015 s`)
    expect(rows[1]).toHaveTextContent(`Obra na pista${segmentName('I22>I23')}00:00:0035 s`)
  })

  it('C32 says there is no active incident', () => {
    setup()
    expect(within(panel()).getByText('Nenhum incidente ativo.')).toBeInTheDocument()
    expect(within(panel()).queryAllByRole('article')).toHaveLength(0)
    expect(screen.getByTestId('card-incidentes')).toHaveTextContent('Incidentes ativos0nenhum crítico')
  })

  it('C35 the selected road shows its level occupancy and four blocks', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I12>I13': { k: 86, v: 14 } })
    let s = selected()
    expect(within(s).getByTestId('selected-name')).toHaveTextContent(segmentName('I12>I13'))
    // 86 x 14 = 1 204 veh/h of 1 250: 96%, and 14 km/h is under half the limit anyway
    expect(within(s).getByTestId('selected-level')).toHaveTextContent('Crítico')
    // the learned capacity is close to 1 250 veh/h; the pct is the flow over it
    tab('Relatórios')
    // (the learned capacity is the curve's peak in Relatórios' capacity model)
    const cap = Number(screen.getByTestId('capacity-point').getAttribute('data-q'))
    tab('Mapa ao vivo')
    expect(cap).toBeGreaterThan(1200)
    expect(cap).toBeLessThan(1300)
    const pct = Math.round((1204 / cap) * 100)
    expect(within(selected()).getByTestId('selected-pct')).toHaveTextContent(`${pct}%`)
    expect(within(selected()).getByTestId('selected-bar')).toHaveStyle({ width: `${pct}%`, background: LEVEL.critico })
    s = selected()
    expect(within(s).getByTestId('selected-fluxo')).toHaveTextContent('20 carros/min')
    expect(within(s).getByTestId('selected-capacidade')).toHaveTextContent('21 carros/min')
    expect(within(s).getByTestId('selected-pista')).toHaveTextContent('50 km/h')
    expect(within(s).getByTestId('selected-media')).toHaveTextContent('14 km/h · 28% do limite')
    for (const t of ['Fluxo atual', 'Capacidade', 'Velocidade da pista', 'Velocidade média', 'Ocupação da capacidade']) expect(s).toHaveTextContent(t)
  })

  it('C37 the flow chart draws flow capacity and four time marks', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I12>I13': { k: 20, v: 40 } })
    learn(transport, engine, { 'I12>I13': { k: 30, v: 35 } })
    // one more sample, taken with that last reading in
    advance(10_000)
    // now = 33 s: 2 h back is 22:00 of the day before
    const s = selected()
    expect(engine.getState().timeMs).toBe(33_000)
    const line = within(s).getByTestId('flow-line')
    expect(line.getAttribute('d')!.match(/[ML]/g)!.length).toBe(3)
    expect(within(s).getByTestId('capacity-line')).toBeInTheDocument()
    expect(s).toHaveTextContent('21/min')
    expect(within(s).getByTestId('time-marks')).toHaveTextContent('22:0022:4023:20agora')
    // in cars per minute on a 0..1.2 x capacity scale: 21/min at 150 - 21/25.2 x 150 = 25, and the
    // last point, sampled at 30 s from the reading of 30 veh/km at 35 km/h (17.5 -> 18/min), at 42.9
    const ys = [...line.getAttribute('d')!.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]))
    expect(Number(within(s).getByTestId('capacity-line').getAttribute('y1'))).toBeCloseTo(25, 0)
    expect(ys.at(-1)!).toBeCloseTo(150 - (18 / 25.2) * 150, 0)
  })

  it('C38 the speed chart draws the mean and the 50 km/h limit', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I12>I13': { k: 20, v: 40 } })
    learn(transport, engine, { 'I12>I13': { k: 60, v: 20 } })
    const s = selected()
    const line = within(s).getByTestId('speed-line')
    const ys = [...line.getAttribute('d')!.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]))
    expect(ys).toHaveLength(2)
    // slower is lower on the chart
    expect(ys[1]).toBeGreaterThan(ys[0])
    const limit = within(s).getByTestId('limit-line')
    expect(limit).toHaveAttribute('data-kmh', '50')
    expect(ys.every((y) => y > Number(limit.getAttribute('y1')))).toBe(true)
  })

  it('C39 charts say Sem histórico ainda without samples', () => {
    setup()
    advance(30_000)
    expect(within(selected()).getAllByText('Sem histórico ainda.')).toHaveLength(2)
    expect(within(selected()).queryByTestId('flow-line')).toBeNull()
  })

  it('C40 the road buttons open Câmeras and Semáforos', () => {
    setup()
    fireEvent.click(within(selected()).getByRole('button', { name: 'Ver câmeras da via' }))
    expect(screen.getByRole('link', { name: 'Câmeras' })).toHaveAttribute('aria-current', 'page')
    tab('Mapa ao vivo')
    fireEvent.click(within(selected()).getByRole('button', { name: 'Ajustar semáforos' }))
    expect(screen.getByRole('link', { name: 'Semáforos' })).toHaveAttribute('aria-current', 'page')
  })

  it('C44 the travel time card shows the network mean in minutes', { timeout: 60_000 }, () => {
    const { engine } = setup({ rate: 120 })
    expect(screen.getByTestId('card-viagem')).toHaveTextContent('Tempo médio de viagem—sem histórico de 1 h')
    let waited = 0
    while (engine.travelStats().lastMinuteAvgS === null && waited < 300_000) {
      advance(10_000)
      waited += 10_000
    }
    const s = engine.travelStats().lastMinuteAvgS!
    expect(s).not.toBeNull()
    const min = (s / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
    expect(screen.getByTestId('card-viagem')).toHaveTextContent(`Tempo médio de viagem${min} minsem histórico de 1 h`)
  })

  it('C45 the notified drivers card counts drivers with an active app', () => {
    const { transport } = setup({ rate: 120 })
    const card = () => screen.getByTestId('card-notificados')
    expect(card()).toHaveTextContent('Motoristas notificados0')
    act(() => {
      for (const app of ['waze', 'google-maps', 'outros'] as const) {
        const n: DriverNotification = { ts: 0, app, motorista: 'x', trechoEvitado: 'I12>I13', rotaSugerida: ['I12>I22'], ganhoS: 10, mensagem: 'x' }
        transport.deliver(notificationTopic(app), JSON.stringify(n))
      }
    })
    advance(10_000)
    const apps = JSON.parse(transport.published.filter((m) => m.topic === 'transito/apps/ativos').at(-1)!.payload)
    expect(apps.total).toBeGreaterThan(0)
    expect(card()).toHaveTextContent(`Motoristas notificados3${apps.total} com app de mapa ativo`)
  })

  it('C46 clicking a ranked street selects its worst segment', () => {
    const { engine, transport } = setup()
    advance(1_000)
    learn(transport, engine, { 'I32>I33': { k: 30, v: 35 }, 'I12>I13': { k: 10, v: 45 } })
    const rows = within(screen.getByRole('region', { name: 'Vias mais saturadas' })).getAllByRole('button')
    expect(rows).toHaveLength(8)
    expect(rows[0]).toHaveTextContent('Al. Itu84%')
    expect(rows[1]).toHaveTextContent('Al. Santos36%')
    expect(rows[7]).toHaveTextContent('—')
    fireEvent.click(rows[0])
    expect(within(selected()).getByTestId('selected-name')).toHaveTextContent(segmentName('I32>I33'))
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true')
    expect(rows[0]).toHaveClass('on')
    expect(rows[1]).toHaveAttribute('aria-pressed', 'false')
  })

  it('C47 zoom steps through 1 1.5 2 3 and disables the ends', () => {
    const { engine } = setup()
    const area = screen.getByTestId('map-area')
    const plus = screen.getByRole('button', { name: 'Aproximar' })
    const minus = screen.getByRole('button', { name: 'Afastar' })
    expect(area).toHaveAttribute('data-zoom', '1')
    expect(minus).toBeDisabled()
    const zooms: string[] = []
    for (let i = 0; i < 3; i++) {
      fireEvent.click(plus)
      zooms.push(area.getAttribute('data-zoom')!)
    }
    expect(zooms).toEqual(['1.5', '2', '3'])
    expect(plus).toBeDisabled()
    // centred on the selected segment: its midpoint is at the canvas centre
    const s = engine.segment('I12>I13')!
    const mid = pointOnSegment(s, s.length / 2)
    const view = clampView(engine.getState().network, { zoom: 3, center: mid })
    expect(view.center).toEqual(mid)
    const halo = (() => {
      const frame = lastFrame()
      let cur: number[][] = []
      for (const c of frame) {
        if (c.op === 'beginPath') cur = []
        else if (c.op === 'moveTo' || c.op === 'lineTo') cur.push(c.args as number[])
        else if (c.op === 'stroke' && c.strokeStyle === '#E6EAF0') return cur
      }
      return []
    })()
    expect(near((halo[0][0] + halo[1][0]) / 2, W / 2, 1) && near((halo[0][1] + halo[1][1]) / 2, H / 2, 1)).toBe(true)
    for (const z of ['2', '1.5', '1']) {
      fireEvent.click(minus)
      expect(area).toHaveAttribute('data-zoom', z)
    }
    expect(minus).toBeDisabled()
    expect(plus).not.toBeDisabled()
  })

  it('C49 labels follow zoom and pan', () => {
    const { engine } = setup({ cameras: true })
    const label = () => screen.getByTestId('street-Al. Santos')
    const icon = () => screen.getByRole('img', { name: /^C01E · / })
    const note = () => screen.getByRole('note')
    const pos = (el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })
    const z = engine.addWorkZone('I33>I34')
    advance(100)
    const net = engine.getState().network
    // the map point under each thing at 1x
    const base = fitTransform(net, W, H)
    const labelAt = base.unmap(pos(label()))
    const markerAt = base.unmap(pos(screen.getByTestId(`marker-obra:${z.id}`)))
    const noteBefore = pos(note())
    fireEvent.click(screen.getByRole('button', { name: 'Aproximar' }))
    const s = engine.segment('I12>I13')!
    const view = { zoom: 1.5, center: pointOnSegment(s, s.length / 2) }
    const zoomed = pos(label())
    const expected = screenOf(engine, labelAt, view)
    expect(near(zoomed.x, expected.x) && near(zoomed.y, expected.y)).toBe(true)
    const unit = screenOf(engine, engine.getState().cameras.find((c) => c.id === 'C01E')!.position, view)
    expect(near(pos(icon()).x, unit.x) && near(pos(icon()).y, unit.y)).toBe(true)
    const marker = screenOf(engine, markerAt, view)
    expect(near(pos(screen.getByTestId(`marker-obra:${z.id}`)).x, marker.x) && near(pos(screen.getByTestId(`marker-obra:${z.id}`)).y, marker.y)).toBe(true)
    expect(pos(note())).not.toEqual(noteBefore)
    // drag the map 100 px left and 50 px up: everything moves with it
    const canvas = document.querySelector('canvas')!
    const markerZoomed = pos(screen.getByTestId(`marker-obra:${z.id}`))
    // press in the middle of a block, away from any unit
    const start = screenOf(engine, pointOnSegment(engine.segment('I22>I23')!, engine.segment('I22>I23')!.length / 2), view)
    fireEvent.mouseDown(canvas, { clientX: start.x, clientY: start.y, button: 0 })
    fireEvent.mouseMove(window, { clientX: start.x - 100, clientY: start.y - 50 })
    fireEvent.mouseUp(window, { clientX: start.x - 100, clientY: start.y - 50 })
    const panned = pos(label())
    expect(near(panned.x, zoomed.x - 100, 1) && near(panned.y, zoomed.y - 50, 1)).toBe(true)
    expect(near(pos(icon()).x, unit.x - 100, 1) && near(pos(icon()).y, unit.y - 50, 1)).toBe(true)
    const m = pos(screen.getByTestId(`marker-obra:${z.id}`))
    expect(near(m.x, markerZoomed.x - 100, 1) && near(m.y, markerZoomed.y - 50, 1)).toBe(true)
  })

})

/** C19's second half: without a broker no reading arrives and every unit goes offline. */
function cleanupAndOffline() {
  // a fresh page with the broker down
  cleanup()
  setup({ cameras: true, connected: false })
  advance(30_000)
  expect(screen.getAllByRole('img', { name: / · offline$/ })).toHaveLength(24)
  for (const icon of screen.getAllByRole('img', { name: / · offline$/ })) expect(icon).toHaveStyle({ borderColor: '#5B6676' })
  expect(screen.getByTestId('card-cameras')).toHaveTextContent('0 / 24')
  expect(screen.getByTestId('card-cameras')).toHaveTextContent(/C\d{2}[ES] sem sinal há 0 min/)
}

describe('map view', () => {
  it('C48 pans only when zoomed and keeps the centre inside the grid', () => {
    const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    const net = engine.getState().network
    const at = (id: string) => net.intersections.find((i) => i.id === id)!.position
    // at 1x the view is the whole grid, whatever is asked
    expect(clampView(net, { zoom: 1, center: at('I44') })).toEqual({ zoom: 1, center: gridCenter(net) })
    expect(gridOf(net, gridCenter(net)).x).toBeCloseTo(2.5, 6)
    // zoomed in, a centre far outside stops on the grid's edge: columns and rows 1-4
    const far = { x: at('I11').x - 5000, y: at('I11').y - 5000 }
    const g = gridOf(net, clampView(net, { zoom: 2, center: far }).center)
    expect(g.x).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(g.y).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(Math.min(g.x, g.y)).toBeCloseTo(1, 6)
    for (const z of [1.5, 2, 3]) {
      const c = gridOf(net, clampView(net, { zoom: z, center: { x: at('I44').x + 3000, y: at('I44').y + 3000 } }).center)
      expect(Math.max(c.x, c.y)).toBeCloseTo(4, 6)
      expect(c.x).toBeLessThanOrEqual(4 + 1e-9)
      expect(c.y).toBeLessThanOrEqual(4 + 1e-9)
    }
    // a centre inside stays
    const inside = at('I22')
    expect(clampView(net, { zoom: 1.5, center: inside }).center).toEqual(inside)
    // each corner lands exactly on its column and row
    for (const i of net.intersections) {
      const p = gridOf(net, i.position)
      expect(p.x).toBeCloseTo(i.col, 6)
      expect(p.y).toBeCloseTo(i.row, 6)
    }
  })

  it('C48 dragging at 1x moves nothing and a zoomed drag stops at the grid edge', () => {
    vi.useFakeTimers()
    const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    render(<App engine={engine} transport={new FakeTransport(true)} />)
    const label = () => screen.getByTestId('street-Al. Santos')
    const pos = () => ({ x: parseFloat(label().style.left), y: parseFloat(label().style.top) })
    const canvas = document.querySelector('canvas')!
    const drag = (dx: number, dy: number) => {
      fireEvent.mouseDown(canvas, { clientX: 500, clientY: 300, button: 0 })
      fireEvent.mouseMove(window, { clientX: 500 + dx, clientY: 300 + dy })
      fireEvent.mouseUp(window, { clientX: 500 + dx, clientY: 300 + dy })
    }
    const before = pos()
    drag(-100, -50)
    expect(pos()).toEqual(before)
    // zoomed in, a drag far past the edge stops there: dragging further moves nothing more
    fireEvent.click(screen.getByRole('button', { name: 'Aproximar' }))
    drag(5000, 3000)
    const stopped = pos()
    drag(5000, 3000)
    expect(near(pos().x, stopped.x, 0.01) && near(pos().y, stopped.y, 0.01)).toBe(true)
    // dragged right and down, the view stops with the north-west corner of the grid at the centre
    const nw = screenOf(engine, corner(engine, 'I11').position, { zoom: 1.5, center: corner(engine, 'I11').position })
    expect(near(nw.x, W / 2) && near(nw.y, H / 2)).toBe(true)
  })
})
