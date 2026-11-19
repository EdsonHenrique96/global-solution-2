import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmUnavailable, type LlmTurn } from '../agent/llm'
import App from '../App'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { AgentPanel } from './AgentPanel'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('render', () => {
  describe('AgentPanel', () => {
    it('shows the log the cards and the mode', async () => {
      const onApprove = vi.fn()
      const onReject = vi.fn()
      const { rerender } = render(
        <AgentPanel
          mode="llm"
          log={[
            { at: 95_000, origem: 'agente', texto: 'Al. Santos congestionada; desvio de 25% dos motoristas com app.' },
            { at: 60_000, origem: 'regra', texto: 'Nada a mudar.' },
          ]}
          cards={[
            { id: 7, criadoEm: 90_000, estado: 'aguardando', acao: { tipo: 'desvio', trecho: 'I12>I13', n: 120, p: 0.4, justificativa: 'acidente na Al. Santos' } },
          ]}
          onApprove={onApprove}
          onReject={onReject}
        />,
      )
      const panel = screen.getByRole('region', { name: 'Agente' })
      expect(within(panel).getByTestId('agent-mode')).toHaveTextContent('modo LLM')
      // the drivers' channel moved to the map apps panel
      expect(within(panel).queryByTestId('agent-notified')).toBeNull()
      const entries = within(panel).getAllByTestId('agent-log-entry')
      expect(entries[0]).toHaveTextContent('1:35 agente Al. Santos congestionada; desvio de 25% dos motoristas com app.')
      expect(entries[1]).toHaveTextContent('1:00 regra Nada a mudar.')
      const card = within(panel).getByTestId('card-7')
      expect(card).toHaveTextContent('Desvio de Al. Santos, R. Bela Cintra → R. Haddock Lobo · fração 40% · N 120 veíc/h')
      expect(card).toHaveTextContent('acidente na Al. Santos')
      fireEvent.click(within(card).getByRole('button', { name: 'Aprovar' }))
      expect(onApprove).toHaveBeenCalledWith(7)
      fireEvent.click(within(card).getByRole('button', { name: 'Rejeitar' }))
      expect(onReject).toHaveBeenCalledWith(7)
      rerender(<AgentPanel mode="regra" log={[]} cards={[]} onApprove={onApprove} onReject={onReject} />)
      expect(within(panel).getByTestId('agent-mode')).toHaveTextContent('modo sem LLM')
      expect(within(panel).queryByRole('list', { name: 'Aguardando aprovação' })).toBeNull()

      // in the page: with the model unreachable, the first turn (30 s) switches to "modo sem LLM"
      vi.useFakeTimers()
      const down: LlmTurn = async () => {
        throw new LlmUnavailable('503')
      }
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={new FakeTransport(true)} llm={down} />)
      fireEvent.click(screen.getByRole('link', { name: 'Desvio' }))
      const pagePanel = screen.getAllByRole('region', { name: 'Agente' }).at(-1)!
      expect(within(pagePanel).getByTestId('agent-mode')).toHaveTextContent('modo LLM')
      await act(async () => {
        vi.advanceTimersByTime(30_000)
        await Promise.resolve()
        await Promise.resolve()
        vi.advanceTimersByTime(100)
      })
      expect(within(pagePanel).getByTestId('agent-mode')).toHaveTextContent('modo sem LLM')
      expect(within(pagePanel).getAllByTestId('agent-log-entry')[0]).toHaveTextContent('regra')
    })
  })
})
