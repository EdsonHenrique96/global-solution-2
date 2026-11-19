import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { anomalyTopic, metricsTopic } from '../fusion/PlateMatcher'
import { EVENTS_FILTER, type PlateEvent } from '../sensors/PlateCamera'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { fitTransform } from './draw'
import { NIVEIS, readSegment } from './levels'
import { SelectedRoad } from './Dashboard'

const W = 1000
const H = 600

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, { get: () => () => ({ width: 10 }), set: () => true }) as never)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => W)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => H)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup({ connected = true, rate = 0 } = {}) {
  const engine = new SimulationEngine({ ratePerMinute: rate })
  const transport = new FakeTransport(connected)
  render(<App engine={engine} transport={transport} />)
  return { engine, transport }
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const tab = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Seções' })).getByRole('link', { name }))
const screenOf = (engine: SimulationEngine, p: Point) => fitTransform(engine.getState().network, W, H).map(p)
const near = (a: number, b: number) => Math.abs(a - b) < 0.5
const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => `${pad(Math.floor(ms / 3_600_000) % 24)}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}`
const PAPEL = { entrada: 'entrada', saida: 'saída' }
const cameraIcons = () => screen.getAllByRole('img', { name: /^C\d{2}[ES] · / })
const panel = () => screen.getByRole('complementary', { name: 'Eventos das câmeras' })
/** Every text and accessible name on the page. */
const pageText = () => [document.body.textContent ?? '', ...[...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '')].join(' ')

describe('pareamento dashboard', () => {
  it('C19 the cameras tab warns while the broker is down', () => {
    const { transport } = setup({ connected: false, rate: 120 })
    advance(30_000)
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
    tab('Câmeras')
    expect(within(panel()).getByRole('status')).toHaveTextContent('MQTT desconectado — tentando reconectar')
    expect(within(panel()).getByText('Nenhum evento recebido.')).toBeInTheDocument()
    expect(within(panel()).queryAllByTestId('event-row')).toHaveLength(0)
    act(() => transport.setConnected(true))
    expect(within(panel()).getByRole('status')).toHaveTextContent('MQTT conectado')
    expect(screen.getByText('AO VIVO')).toBeInTheDocument()
  })

  it('C21 the selected road shows the pairing metrics and its camera pair', () => {
    const { engine, transport } = setup()
    advance(15_000)
    act(() => {
      transport.deliver(
        metricsTopic('I12>I13'),
        JSON.stringify({ trecho: 'I12>I13', ts: 15_000, janelaS: 60, fluxoVeicMin: 6, velocidadeMediaKmh: 45, pares: 2, entraram: 8, sairam: 3, ocupacao: 5, densidadeVeicKm: 20, camerasPar: ['C02E', 'C02S'] }),
      )
    })
    advance(100)
    const road = screen.getByRole('region', { name: 'Via selecionada' })
    expect(within(road).getByTestId('selected-name')).toHaveTextContent(segmentName('I12>I13'))
    const fact = (label: string, testId: string, text: string | RegExp) => {
      const dd = within(road).getByTestId(testId)
      expect(dd.previousElementSibling).toHaveTextContent(label)
      expect(dd).toHaveTextContent(text)
    }
    fact('Velocidade média (pareamento)', 'selected-media', /^45 km\/h/)
    fact('Fluxo atual', 'selected-fluxo', '6 carros/min')
    fact('No trecho agora', 'selected-ocupacao', '5 veíc')
    fact('Densidade', 'selected-densidade', '20 veíc/km')
    fact('Pares no último minuto', 'selected-pares', '2')
    fact('Câmeras do par', 'selected-par', 'C02E · C02S')

    // a segment with no pair, selected on the map
    const canvas = document.querySelector('canvas')!
    const p = screenOf(engine, pointOnSegment(engine.segment('I13>I12')!, 60))
    fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
    fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
    expect(within(road).getByTestId('selected-name')).toHaveTextContent(segmentName('I13>I12'))
    expect(within(road).getByTestId('selected-par')).toHaveTextContent('nenhuma (estimado)')
    // the component itself
    act(() => {
      render(<SelectedRoad reading={readSegment('I13>I12', undefined, undefined, 0)} pair={null} history={[]} nowMs={0} onCameras={() => {}} onSignals={() => {}} />)
    })
    expect(screen.getAllByTestId('selected-par').at(-1)).toHaveTextContent('nenhuma (estimado)')
  })

  it('C22 no label mentions radar', () => {
    const { engine } = setup({ rate: 60 })
    advance(30_000)
    for (const name of ['Mapa ao vivo', 'Câmeras', 'Semáforos', 'Relatórios']) {
      tab(name)
      expect(pageText(), name).not.toMatch(/radar/i)
    }
    tab('Mapa ao vivo')
    const canvas = document.querySelector('canvas')!
    for (const id of ['I12>I13', 'I13>I12']) {
      const p = screenOf(engine, pointOnSegment(engine.segment(id)!, 60))
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      const tip = screen.getByRole('tooltip')
      expect(tip.textContent).not.toMatch(/radar/i)
      expect(tip.textContent).toMatch(/pareamento/)
    }
  })

  it('C23 the cameras tab lists the 24 cameras with segment role and status', () => {
    const { engine, transport } = setup()
    tab('Câmeras')
    const list = () => within(screen.getByRole('region', { name: 'Câmeras de placa' })).getAllByRole('listitem')
    expect(list()).toHaveLength(24)
    advance(10_000)
    const cameras = engine.getState().cameras
    for (const c of cameras) {
      const row = screen.getByTestId(`camera-${c.id}`)
      expect(row).toHaveTextContent(c.id)
      expect(within(row).getByTestId('camera-trecho')).toHaveTextContent(segmentName(c.trecho))
      expect(within(row).getByTestId('camera-papel')).toHaveTextContent(PAPEL[c.papel])
      expect(within(row).getByTestId('camera-status')).toHaveTextContent('online')
    }
    act(() => transport.setConnected(false))
    advance(21_000)
    for (const c of cameras) expect(within(screen.getByTestId(`camera-${c.id}`)).getByTestId('camera-status')).toHaveTextContent('offline')
  })

  it('C24 the cameras tab shows the last 20 events newest first with a 6 character hash', { timeout: 60_000 }, () => {
    const { transport } = setup({ rate: 120 })
    advance(60_000)
    tab('Câmeras')
    const events = transport.published.filter((m) => topicMatches(EVENTS_FILTER, m.topic)).map((m) => JSON.parse(m.payload) as PlateEvent)
    expect(events.length).toBeGreaterThan(20)
    const expected = events.slice(-20).reverse()
    const rows = within(panel()).getAllByTestId('event-row')
    expect(rows).toHaveLength(20)
    rows.forEach((row, i) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent)
      const e = expected[i]
      expect(cells).toEqual([clock(e.ts), e.cameraId, e.trecho, e.placaHash.slice(0, 6)])
      expect(cells[3]).toHaveLength(6)
    })
    expect(panel().textContent).not.toContain(expected[0].placaHash)
  })

  it('C25 the noise control is gone', () => {
    setup()
    for (const name of ['Mapa ao vivo', 'Câmeras', 'Semáforos', 'Relatórios']) {
      tab(name)
      expect(pageText(), name).not.toMatch(/ruído/i)
    }
    tab('Semáforos')
    const controls = screen.getByRole('group', { name: 'Controle da simulação' })
    expect(within(controls).getByRole('heading')).toHaveTextContent('Controle da operação')
    expect(within(controls).getAllByRole('slider').map((s) => s.getAttribute('aria-label') ?? s.closest('label')?.textContent)).toHaveLength(1)
    expect(within(controls).getByRole('slider', { name: /carros por minuto/i })).toBeInTheDocument()
    expect(within(controls).getAllByRole('button').map((b) => b.textContent)).toEqual(['Desvio parcial', 'Controle de semáforos'])
  })

  it('C26 draws 24 camera icons at the ends of their segments', () => {
    const { engine } = setup()
    const icons = cameraIcons()
    expect(icons).toHaveLength(24)
    for (const c of engine.getState().cameras) {
      const seg = engine.segment(c.trecho)!
      const icon = screen.getByRole('img', { name: new RegExp(`^${c.id} · `) })
      expect(icon.getAttribute('aria-label')).toMatch(new RegExp(`^${c.id} · ${PAPEL[c.papel]} · ${segmentName(c.trecho).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · (online|offline)$`))
      const at = screenOf(engine, pointOnSegment(seg, c.papel === 'entrada' ? 0 : seg.length - 72))
      expect(near(parseFloat(icon.style.left), at.x) && near(parseFloat(icon.style.top), at.y), c.id).toBe(true)
    }
  })

  it('C27 dragging a camera icon does not move the camera', () => {
    const { engine } = setup()
    const before = JSON.stringify(engine.getState().cameras)
    const canvas = document.querySelector('canvas')!
    const c = engine.getState().cameras.find((x) => x.id === 'C01E')!
    const from = screenOf(engine, c.position)
    const to = screenOf(engine, pointOnSegment(engine.segment('I22>I23')!, 60))
    // on the map under the icon, and on the icon itself
    fireEvent.mouseDown(canvas, { clientX: from.x, clientY: from.y, button: 0 })
    fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
    fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
    const icon = screen.getByRole('img', { name: /^C01E · / })
    fireEvent.mouseDown(icon, { clientX: from.x, clientY: from.y, button: 0 })
    fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y })
    fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y })
    advance(1_000)
    expect(JSON.stringify(engine.getState().cameras)).toBe(before)
    const after = screen.getByRole('img', { name: /^C01E · / })
    expect(near(parseFloat(after.style.left), from.x) && near(parseFloat(after.style.top), from.y)).toBe(true)
  })

  it('C28 the cameras card counts cameras with a status in the last 20 s', () => {
    const { transport } = setup()
    const card = () => screen.getByTestId('card-cameras')
    advance(10_000)
    expect(card()).toHaveTextContent('Câmeras online')
    expect(card()).toHaveTextContent('24 / 24')
    act(() => transport.setConnected(false))
    advance(20_000) // 20 s after the last status
    expect(card()).toHaveTextContent('24 / 24')
    advance(1_000) // 21 s
    expect(card()).toHaveTextContent('0 / 24')
  })

  it('C43 the anomaly shows as Possível incidente in the panel and on the map', () => {
    const { transport } = setup()
    advance(15_000)
    const warn = (ativo: boolean, ts: number) =>
      act(() => {
        transport.deliver(anomalyTopic('I12>I13'), JSON.stringify({ trecho: 'I12>I13', ts, ativo, atrasados: 4, fracao: 1 }))
      })
    warn(true, 15_000)
    advance(100)
    const incidents = screen.getByRole('region', { name: 'Incidentes' })
    const card = within(incidents).getByTestId('incident-possivel-incidente:I12>I13')
    expect(card).toHaveTextContent('Possível incidente')
    expect(card).toHaveTextContent('Moderado')
    expect(card).toHaveTextContent('Anomalia: carros que entraram não saíram no tempo esperado · aguarda confirmação')
    expect(screen.getByTestId('marker-possivel-incidente:I12>I13')).toHaveAttribute('aria-label', 'Possível incidente')
    expect(screen.getAllByRole('note').some((n) => /Possível incidente/.test(n.textContent ?? ''))).toBe(true)
    warn(false, 15_100)
    advance(100)
    expect(within(incidents).queryByTestId('incident-possivel-incidente:I12>I13')).toBeNull()
    expect(screen.queryByTestId('marker-possivel-incidente:I12>I13')).toBeNull()
  })

  it('C44 shows the held speed as último par há X s', () => {
    const { engine, transport } = setup()
    advance(15_000)
    // a pair at 10 km/h at 15 s; the matcher's next recomputations (20 s, 30 s) have no pair
    act(() => {
      transport.deliver(
        metricsTopic('I12>I13'),
        JSON.stringify({ trecho: 'I12>I13', ts: 15_000, janelaS: 60, fluxoVeicMin: 1, velocidadeMediaKmh: 10, pares: 1, entraram: 0, sairam: 0, ocupacao: 0, densidadeVeicKm: 0, camerasPar: ['C02E', 'C02S'] }),
      )
    })
    advance(15_000)
    const road = screen.getByRole('region', { name: 'Via selecionada' })
    expect(within(road).getByTestId('selected-media')).toHaveTextContent(/^10 km\/h/)
    expect(within(road).getByTestId('selected-ultimo-par')).toHaveTextContent('último par há 15 s')
    expect(within(road).getByTestId('selected-pares')).toHaveTextContent('0')
    const canvas = document.querySelector('canvas')!
    const p = screenOf(engine, pointOnSegment(engine.segment('I12>I13')!, 30))
    fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
    expect(within(screen.getByRole('tooltip')).getByTestId('tooltip-velocidade')).toHaveTextContent('10,0 km/h · último par há 15 s')
    // past 5 min: no speed any more
    advance(300_000)
    expect(within(road).getByTestId('selected-media')).toHaveTextContent(/^— km\/h/)
    expect(within(road).queryByTestId('selected-ultimo-par')).toBeNull()
  })

  it('C45 shows Em verificação while the warning is open and the level when it closes', () => {
    let strokes: { from: number[]; to: number[]; style: unknown; dash: unknown }[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const st: Record<string | symbol, unknown> = { dash: [] }
      let path: number[][] = []
      return new Proxy(st, {
        get(target, key) {
          if (key === 'setLineDash') return (d: unknown) => {
            target.dash = d
          }
          if (key in target) return target[key]
          return (...args: number[]) => {
            if (key === 'clearRect') strokes = []
            else if (key === 'beginPath') path = []
            else if (key === 'moveTo' || key === 'lineTo') path.push(args)
            else if (key === 'stroke' && path.length === 2) strokes.push({ from: path[0], to: path[1], style: target.strokeStyle, dash: target.dash })
            return key === 'measureText' ? { width: 10 } : undefined
          }
        },
        set(target, key, value) {
          target[key] = value
          return true
        },
      }) as never
    })
    const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    const transport = new FakeTransport(true)
    render(<App engine={engine} transport={transport} />)
    advance(2_000)
    const id = 'I12>I13'
    const seg = engine.segment(id)!
    // the rule level: 360 of ~844 veh/h at 40 km/h -> Livre
    const metrics = (ts: number) => act(() => deliverMetrics(transport, id, ts, { k: 10, v: 40, fluxoVeicMin: 6 }))
    const warn = (ativo: boolean, ts: number) =>
      act(() => {
        transport.deliver(anomalyTopic(id), JSON.stringify({ trecho: id, ts, ativo, atrasados: 4, fracao: 1 }))
      })
    const shown = () => {
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      const [a, b] = seg.points.map((p) => screenOf(engine, p))
      const lane = strokes.filter((x) => near(x.from[0], a.x) && near(x.from[1], a.y) && near(x.to[0], b.x) && near(x.to[1], b.y)).at(-1)!
      const bar = screen.getByTestId(`rank-${seg.rua}`).querySelector('.track span') as HTMLElement
      const p = screenOf(engine, pointOnSegment(seg, seg.length / 2))
      fireEvent.mouseMove(document.querySelector('canvas')!, { clientX: p.x, clientY: p.y })
      return {
        lane: [lane.style, Array.isArray(lane.dash) && lane.dash.length > 0],
        bar: bar.style.background,
        tip: within(screen.getByRole('tooltip')).getByTestId('tooltip-estado').textContent,
        selected: within(screen.getByRole('region', { name: 'Via selecionada' })).getByTestId('selected-level').textContent,
      }
    }
    metrics(2_000)
    advance(100)
    expect(shown()).toEqual({ lane: ['#3DBE7A', false], bar: 'rgb(61, 190, 122)', tip: 'Livre', selected: 'Livre' })
    warn(true, 2_100)
    advance(100)
    expect(shown()).toEqual({ lane: ['#FFB020', true], bar: 'rgb(255, 176, 32)', tip: 'Em verificação', selected: 'Em verificação' })
    expect(screen.getByTestId('card-incidentes')).toHaveTextContent('1')
    // not Crítico, no diversion
    expect(within(screen.getByRole('region', { name: 'Incidentes' })).queryByTestId(`incident-congestionamento:${id}`)).toBeNull()
    // the warning closes: the rule level is back in the same recomputation
    advance(10_000 - engine.getState().timeMs)
    expect(engine.getState().timeMs).toBe(10_000)
    metrics(10_000)
    warn(false, 10_000)
    advance(100)
    expect(shown()).toEqual({ lane: ['#3DBE7A', false], bar: 'rgb(61, 190, 122)', tip: 'Livre', selected: 'Livre' })
  })

  it('C34 map ranking tooltip and selected road show the same level', () => {
    // a canvas that records each lane stroke and its colour
    let strokes: { from: number[]; to: number[]; style: unknown }[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const st: Record<string | symbol, unknown> = {}
      let path: number[][] = []
      return new Proxy(st, {
        get(target, key) {
          if (key in target) return target[key]
          return (...args: number[]) => {
            if (key === 'clearRect') strokes = []
            else if (key === 'beginPath') path = []
            else if (key === 'moveTo' || key === 'lineTo') path.push(args)
            else if (key === 'stroke' && path.length === 2) strokes.push({ from: path[0], to: path[1], style: target.strokeStyle })
            return key === 'measureText' ? { width: 10 } : undefined
          }
        },
        set(target, key, value) {
          target[key] = value
          return true
        },
      }) as never
    })
    const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
    const transport = new FakeTransport(true)
    render(<App engine={engine} transport={transport} />)
    advance(2_000)
    const now = engine.getState().timeMs
    act(() => {
      // learn 1 250 veh/h on both (Greenshields vf 50, kj 100), then the last metrics
      for (let i = 0; i < 30; i++) {
        const k = 5 + (i % 19) * 5
        for (const id of ['I12>I13', 'I22>I23']) deliverMetrics(transport, id, now - 60 + i, { k, v: 50 * (1 - k / 100) })
      }
      deliverMetrics(transport, 'I12>I13', now, { k: 20, v: 14, fluxoVeicMin: 2 })
      deliverMetrics(transport, 'I22>I23', now, { k: 20, v: 40, fluxoVeicMin: 12.5 })
    })
    advance(100)
    const canvas = document.querySelector('canvas')!
    const levelOn = (id: string) => {
      const seg = engine.segment(id)!
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      const [a, b] = seg.points.map((p) => screenOf(engine, p))
      const lane = strokes.filter((x) => near(x.from[0], a.x) && near(x.from[1], a.y) && near(x.to[0], b.x) && near(x.to[1], b.y)).at(-1)!
      const mapLevel = Object.values(NIVEIS).find((n) => n.color === lane.style)!.label
      const rua = seg.rua
      const bar = screen.getByTestId(`rank-${rua}`).querySelector('.track span') as HTMLElement
      const rankLevel = Object.values(NIVEIS).find((n) => bar.style.background === hexToRgb(n.color) || bar.style.background === n.color)!.label
      const p = screenOf(engine, pointOnSegment(seg, seg.length / 2))
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      const tipLevel = within(screen.getByRole('tooltip')).getByTestId('tooltip-estado').textContent
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
      const road = screen.getByRole('region', { name: 'Via selecionada' })
      expect(within(road).getByTestId('selected-name')).toHaveTextContent(segmentName(id))
      const selectedLevel = within(road).getByTestId('selected-level').textContent
      return [mapLevel, rankLevel, tipLevel, selectedLevel]
    }
    expect(levelOn('I12>I13')).toEqual(['Crítico', 'Crítico', 'Crítico', 'Crítico'])
    expect(levelOn('I22>I23')).toEqual(['Moderado', 'Moderado', 'Moderado', 'Moderado'])
  })
})

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}
