import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { metricsTopic } from '../fusion/PlateMatcher'
import { EVENTS_FILTER, type PlateEvent } from '../sensors/PlateCamera'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { fitTransform } from './draw'
import { readSegment } from './levels'
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
      const at = screenOf(engine, pointOnSegment(seg, c.papel === 'entrada' ? 0 : seg.length - 12))
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
})
