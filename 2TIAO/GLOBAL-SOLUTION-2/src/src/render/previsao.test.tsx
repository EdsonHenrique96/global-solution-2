import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FRACOES, type DiversionSimulation } from '../decision/simulateDiversion'
import { segmentName } from '../sensors/segments'
import { MetricsPanel } from './MetricsPanel'

afterEach(cleanup)

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
  })
})
