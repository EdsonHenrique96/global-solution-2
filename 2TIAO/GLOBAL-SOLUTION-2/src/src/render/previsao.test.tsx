import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { centroidUnits } from '../capacity/StateClassifier'
import { kmeansFixture } from '../capacity/kmeansFixture'
import { FRACOES, type DiversionSimulation } from '../decision/simulateDiversion'
import type { Previsao, PrevisaoEntrada, PrevisaoSaida } from '../forecast/ForecastClient'
import type { MlClient } from '../forecast/mlClient'
import { anomalyTopic } from '../fusion/PlateMatcher'
import { pointOnSegment, segmentName } from '../sensors/segments'
import { SimulationEngine } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { DashboardHeader } from './Dashboard'
import { fitTransform } from './draw'
import { NIVEIS } from './levels'
import { MetricsPanel } from './MetricsPanel'

const W = 1000
const H = 600
/** Every lane stroke the map draws, with its colour and dash. */
let strokes: { from: number[]; to: number[]; style: unknown; dash: unknown }[] = []

beforeEach(() => {
  strokes = []
  vi.useFakeTimers()
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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => W)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => H)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const JAMMED = 'I12>I13'
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
/** Lets the service's answers (promises) arrive. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
/** Advances to `ms` of simulated time, letting each 60 s answer arrive. */
async function runTo(engine: SimulationEngine, ms: number) {
  while (engine.getState().timeMs < ms) {
    const next = Math.min(ms, (Math.floor(engine.getState().timeMs / 60_000) + 1) * 60_000)
    advance(next - engine.getState().timeMs)
    await settle()
  }
  // the page draws the answer on its next tick
  advance(100)
}
const tab = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Seções' })).getByRole('link', { name }))
const road = () => screen.getByRole('region', { name: 'Via selecionada' })
const screenOf = (engine: SimulationEngine, p: Point) => fitTransform(engine.getState().network, W, H).map(p)
const near = (a: number, b: number) => Math.abs(a - b) < 0.5
const answer = (body: PrevisaoEntrada, p: Previsao): PrevisaoSaida => ({ modelo: 'v2-teste', previsoes: Object.fromEntries(Object.keys(body.trechos).map((id) => [id, p])) })

/** The page with an ML service whose answers the test scripts. */
function setup({ prever, kmeans = async () => Promise.reject(new Error('503')), cameras = true }: { prever?: MlClient['prever']; kmeans?: MlClient['kmeans']; cameras?: boolean } = {}) {
  const engine = new SimulationEngine({ ratePerMinute: 0, ...(cameras ? {} : { cameras: [] }) })
  const transport = new FakeTransport(true)
  const ml: MlClient = { prever: prever ?? (async (b) => answer(b, { v15: 30, f15: 5, v30: 30, f30: 5 })), kmeans }
  render(<App engine={engine} transport={transport} ml={ml} />)
  return { engine, transport, ml }
}

const METRICS = { travelLastMinuteS: 84.25, travelAllS: 71.5, queueTotal: 17, pctDiverted: 12.5, samples: [] }
const table = (escolhida: number): DiversionSimulation => ({
  trecho: 'I12>I13',
  horizonteMin: 10,
  fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: fracao >= escolhida ? 85 : 120, ocupacaoMaxAlternativa: 60, tempoMedioS: 90, co2Kg: 2 })),
  escolhida,
  eficaz: true,
})

describe('previsao dashboard', () => {
  it('C22 the diversion panel shows the simulated fraction', () => {
    const { rerender } = render(
      <MetricsPanel metrics={METRICS} diversion={{ status: 'ativo', trecho: 'I12>I13', n: 60, p: 0.2, candidatos: 10, notificados: 2, semAlcance: 1, simulacao: table(0.2) }} />,
    )
    const state = within(screen.getByRole('region', { name: 'Métricas' })).getByTestId('diversion-state')
    expect(state).toHaveTextContent(`evitar ${segmentName('I12>I13')}`)
    expect(state).toHaveTextContent('fração 20% (simulada)')
    expect(state).toHaveTextContent('2 notificados na janela')
    // "notificar todos": everyone, no simulation behind it
    rerender(<MetricsPanel metrics={METRICS} diversion={{ status: 'ativo', trecho: 'I12>I13', n: 0, p: 1, candidatos: 10, notificados: 7, semAlcance: 1, simulacao: null }} />)
    expect(screen.getByTestId('diversion-state')).toHaveTextContent('fração 100% ·')
    expect(screen.getByTestId('diversion-state')).not.toHaveTextContent('simulada')
    // the fractions are still being computed (AD-103): no fraction yet, nobody told
    rerender(<MetricsPanel metrics={METRICS} diversion={{ status: 'ativo', trecho: 'I12>I13', n: 0, p: 0, candidatos: 10, notificados: 0, semAlcance: 1, simulacao: null, calculando: true }} />)
    expect(screen.getByTestId('diversion-state')).toHaveTextContent('calculando a fração…')
    expect(screen.getByTestId('diversion-state')).toHaveTextContent('0 notificados na janela')
    expect(screen.getByTestId('diversion-state')).not.toHaveTextContent('fração 0%')
  })

  it('C13 the selected road shows the 15 and 30 min forecast', async () => {
    const { engine } = setup({ prever: async (b) => answer(b, { v15: 32, f15: 6, v30: 28, f30: 7 }) })
    expect(within(road()).getByTestId('selected-name')).toHaveTextContent(segmentName(JAMMED))
    await runTo(engine, 300_000)
    expect(within(road()).getByTestId('selected-previsao')).toHaveTextContent('Previsão aguardando 10 min de histórico')
    await runTo(engine, 600_000)
    const f15 = within(road()).getByTestId('selected-previsao-15')
    expect(f15.previousElementSibling).toHaveTextContent('Previsão 15 min')
    expect(f15).toHaveTextContent('32 km/h · 6 carros/min')
    const f30 = within(road()).getByTestId('selected-previsao-30')
    expect(f30.previousElementSibling).toHaveTextContent('Previsão 30 min')
    expect(f30).toHaveTextContent('28 km/h · 7 carros/min')
  }, 60_000)

  it('C14 shows Previsão indisponível after 3 failed calls and the last forecast before', async () => {
    const script: (Previsao | null)[] = [{ v15: 32, f15: 6, v30: 28, f30: 7 }, null, null, null, { v15: 40, f15: 3, v30: 41, f30: 2 }]
    let call = 0
    const { engine } = setup({
      prever: async (b) => {
        const p = script[call++]
        if (!p) throw new Error('ECONNREFUSED')
        return answer(b, p)
      },
    })
    const shown = () => within(road()).getByTestId('selected-previsao').textContent
    await runTo(engine, 600_000)
    expect(shown()).toContain('32 km/h · 6 carros/min')
    // 1 and 2 failures: the last forecast stays
    await runTo(engine, 660_000)
    expect(shown()).toContain('32 km/h · 6 carros/min')
    await runTo(engine, 720_000)
    expect(shown()).toContain('32 km/h · 6 carros/min')
    // the 3rd: unavailable, no values
    await runTo(engine, 780_000)
    expect(shown()).toBe('Previsão indisponível')
    expect(within(road()).queryByTestId('selected-previsao-15')).toBeNull()
    // back
    await runTo(engine, 840_000)
    expect(shown()).toContain('40 km/h · 3 carros/min')
    expect(call).toBe(5)
  }, 60_000)

  it('C15 lists Congestionamento previsto with the forecast time until it falls below 80 percent', async () => {
    // 843 veh/h of capacity: 15 cars/min -> 107%, 12 -> 85%, 10 -> 71%
    const flows = [15, 12, 10]
    let call = 0
    const { engine } = setup({ prever: async (b) => answer(b, { v15: 20, f15: flows[Math.min(call++, flows.length - 1)], v30: 20, f30: 10 }) })
    const incidents = () => screen.getByRole('region', { name: 'Incidentes' })
    await runTo(engine, 600_000)
    const item = within(incidents()).getByTestId(`incident-previsto:${JAMMED}`)
    expect(item).toHaveTextContent('Congestionamento previsto')
    expect(item).toHaveTextContent(segmentName(JAMMED))
    // forecast at Seg 07:10 for 15 min ahead
    expect(item).toHaveTextContent('previsto para Seg 07:25')
    expect(item).toHaveTextContent('Ocupação prevista 107% da capacidade')
    // 85%: still listed, now for 07:26
    await runTo(engine, 660_000)
    expect(within(incidents()).getByTestId(`incident-previsto:${JAMMED}`)).toHaveTextContent('previsto para Seg 07:26')
    // 71%: below 80, gone
    await runTo(engine, 720_000)
    expect(within(incidents()).queryByTestId(`incident-previsto:${JAMMED}`)).toBeNull()
  }, 60_000)

  it('C16 the header clock starts on Seg 07:00 and follows simulated time', () => {
    setup()
    expect(screen.getByTestId('sim-clock')).toHaveTextContent('Seg 07:00')
    advance(59_900)
    expect(screen.getByTestId('sim-clock')).toHaveTextContent('Seg 07:00')
    advance(100)
    expect(screen.getByTestId('sim-clock')).toHaveTextContent('Seg 07:01')
    cleanup()
    render(<DashboardHeader connection="connected" simTimeMs={3_665_000} pending={0} active="mapa" onNavigate={() => {}} />)
    expect(screen.getByTestId('sim-clock').textContent).toBe('Seg 08:01')
    cleanup()
    render(<DashboardHeader connection="connected" simTimeMs={17 * 3_600_000} pending={0} active="mapa" onNavigate={() => {}} />)
    expect(screen.getByTestId('sim-clock').textContent).toBe('Ter 00:00')
  })

  it('C28 falls back to the rule and retries the K-means', async () => {
    let available = false
    const { transport } = setup({
      cameras: false,
      kmeans: async () => {
        if (!available) throw new Error('503')
        return kmeansFixture()
      },
    })
    await settle()
    const legend = () => screen.getByLabelText('Legenda da densidade')
    expect(within(legend()).getByTestId('classificacao')).toHaveTextContent('classificação por regra')
    // 20 km/h, 2 cars/min, 60 veh/km: Livre by the rule, Crítico by the K-means
    advance(2_000)
    act(() => deliverMetrics(transport, JAMMED, 2_000, { k: 60, v: 20, fluxoVeicMin: 2 }))
    advance(100)
    expect(within(road()).getByTestId('selected-level')).toHaveTextContent('Livre')
    // still down: stays on the rule
    fireEvent.click(within(legend()).getByRole('button', { name: 'Tentar de novo' }))
    await settle()
    expect(within(legend()).getByTestId('classificacao')).toHaveTextContent('classificação por regra')
    available = true
    fireEvent.click(within(legend()).getByRole('button', { name: 'Tentar de novo' }))
    await settle()
    expect(within(legend()).getByTestId('classificacao')).toHaveTextContent('classificação K-means')
    expect(within(legend()).queryByRole('button', { name: 'Tentar de novo' })).toBeNull()
    advance(100)
    expect(within(road()).getByTestId('selected-level')).toHaveTextContent('Crítico')
  })

  it('C29 map ranking tooltip and selected road show the K-means level', async () => {
    const { engine, transport } = setup({ cameras: false, kmeans: async () => kmeansFixture() })
    await settle()
    advance(2_000)
    const canvas = document.querySelector('canvas')!
    const levelOn = (id: string) => {
      const seg = engine.segment(id)!
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      const [a, b] = seg.points.map((p) => screenOf(engine, p))
      const lane = strokes.filter((x) => near(x.from[0], a.x) && near(x.from[1], a.y) && near(x.to[0], b.x) && near(x.to[1], b.y)).at(-1)!
      const mapLevel = Object.values(NIVEIS).find((n) => n.color === lane.style)!.label
      const bar = screen.getByTestId(`rank-${seg.rua}`).querySelector('.track span') as HTMLElement
      const rankLevel = Object.values(NIVEIS).find((n) => bar.style.background === hexToRgb(n.color))!.label
      const p = screenOf(engine, pointOnSegment(seg, seg.length / 2))
      fireEvent.mouseMove(canvas, { clientX: p.x, clientY: p.y })
      const tipLevel = within(screen.getByRole('tooltip')).getByTestId('tooltip-estado').textContent
      fireEvent.mouseDown(canvas, { clientX: p.x, clientY: p.y, button: 0 })
      fireEvent.mouseUp(window, { clientX: p.x, clientY: p.y })
      expect(within(road()).getByTestId('selected-name')).toHaveTextContent(segmentName(id))
      return [mapLevel, rankLevel, tipLevel, within(road()).getByTestId('selected-level').textContent]
    }
    const now = engine.getState().timeMs
    act(() => {
      // K-means Crítico, rule Livre
      deliverMetrics(transport, JAMMED, now, { k: 60, v: 20, fluxoVeicMin: 2 })
      // K-means Moderado, rule Crítico (below 15 km/h)
      deliverMetrics(transport, 'I22>I23', now, { k: 8, v: 10, fluxoVeicMin: 3 })
      // K-means Crítico too, but its warning is open: "Em verificação" prevails (AD-100)
      deliverMetrics(transport, 'I32>I33', now, { k: 60, v: 20, fluxoVeicMin: 2 })
      transport.deliver(anomalyTopic('I32>I33'), JSON.stringify({ trecho: 'I32>I33', ts: now, ativo: true, atrasados: 4, fracao: 1 }))
    })
    advance(100)
    expect(levelOn(JAMMED)).toEqual(['Crítico', 'Crítico', 'Crítico', 'Crítico'])
    expect(levelOn('I22>I23')).toEqual(['Moderado', 'Moderado', 'Moderado', 'Moderado'])
    expect(levelOn('I32>I33')).toEqual(['Em verificação', 'Em verificação', 'Em verificação', 'Em verificação'])
  })

  it('C30 reports show the centroids the speed density chart and the agreement', async () => {
    const model = kmeansFixture(87)
    const { engine } = setup({ kmeans: async () => model })
    await settle()
    // every paired segment has metrics after the first 10 s
    advance(10_000)
    tab('Relatórios')
    const panel = screen.getByRole('region', { name: 'Estados do tráfego' })
    const rows = within(panel).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(['Livre', 'Moderado', 'Intenso', 'Crítico'])
    const fmt = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
    for (const [i, c] of model.centroides.entries()) {
      const [v, f, d] = centroidUnits(model, c.centro)
      expect([...rows[i].querySelectorAll('td')].slice(1).map((td) => td.textContent)).toEqual([fmt(v), fmt(f), fmt(d)])
    }
    expect([...rows[3].querySelectorAll('td')].slice(1).map((td) => td.textContent)).toEqual(['12,0', '6,0', '70,0'])
    expect(within(panel).getByRole('columnheader', { name: 'Velocidade (km/h)' })).toBeInTheDocument()
    expect(within(panel).getByRole('columnheader', { name: 'Fluxo (carros/min)' })).toBeInTheDocument()
    expect(within(panel).getByRole('columnheader', { name: 'Densidade (veíc/km)' })).toBeInTheDocument()
    // one point per paired segment, in the colour of the level it shows
    const chart = within(panel).getByRole('img', { name: 'Velocidade × densidade por nível' })
    const points = chart.querySelectorAll('[data-testid^="ponto-"]')
    expect(points).toHaveLength(12)
    const paired = new Set(engine.getState().cameras.map((c) => c.trecho))
    for (const p of points) {
      const id = p.getAttribute('data-testid')!.slice('ponto-'.length)
      expect(paired.has(id)).toBe(true)
      const nivel = p.getAttribute('data-nivel') as keyof typeof NIVEIS
      expect(p.getAttribute('fill')).toBe(NIVEIS[nivel].color)
    }
    // an empty road (no pair speed, no flow) sits on the K-means level of 50 km/h, 0, 0
    expect(points[0].getAttribute('data-nivel')).toBe('livre')
    expect(chart.querySelectorAll('[data-testid^="grafico-centroide-"]')).toHaveLength(4)
    expect(within(panel).getByTestId('kmeans-concordancia')).toHaveTextContent('Concordância com a regra: 87%')

    // K-means and the rule disagree on the empty road: a model whose Moderado centroid sits on it
    // (50 km/h, 0, 0) and whose Livre is at 80 km/h; the rule says Livre - every point is Moderado
    cleanup()
    const std = (v: number, f: number, d: number) => [(v - 30) / 10, (f - 5) / 4, (d - 20) / 15]
    const shifted = kmeansFixture()
    shifted.centroides = shifted.centroides.map((c) =>
      c.nivel === 'livre' ? { ...c, centro: std(80, 0, 0) } : c.nivel === 'moderado' ? { ...c, centro: std(50, 0, 0) } : c,
    )
    setup({ kmeans: async () => shifted })
    await settle()
    advance(10_000)
    tab('Relatórios')
    const shiftedPoints = within(screen.getByRole('img', { name: 'Velocidade × densidade por nível' })).getAllByTestId(/^ponto-/)
    expect(shiftedPoints).toHaveLength(12)
    for (const p of shiftedPoints) {
      expect(p.getAttribute('data-nivel')).toBe('moderado')
      expect(p.getAttribute('fill')).toBe(NIVEIS.moderado.color)
    }
  })
})

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}
