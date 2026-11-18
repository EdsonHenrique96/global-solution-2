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
    it('shows the log the cards the mode and the notification channel', async () => {
      const onApprove = vi.fn()
      const onReject = vi.fn()
      const { rerender } = render(
        <AgentPanel
          mode="llm"
          notified={42}
          log={[
            { at: 95_000, origem: 'agente', texto: 'Central congestionada; desvio de 25% para a Norte.' },
            { at: 60_000, origem: 'regra', texto: 'Nada a mudar.' },
          ]}
          cards={[
            { id: 7, criadoEm: 90_000, estado: 'aguardando', acao: { tipo: 'desvio', de: 'central', para: 'sul', n: 120, p: 0.4, justificativa: 'acidente na central' } },
          ]}
          onApprove={onApprove}
          onReject={onReject}
        />,
      )
      const panel = screen.getByRole('region', { name: 'Agente' })
      expect(within(panel).getByTestId('agent-mode')).toHaveTextContent('modo LLM')
      expect(panel).toHaveTextContent('App de mapa do motorista (simulado)')
      expect(within(panel).getByTestId('agent-notified')).toHaveTextContent('42')
      const entries = within(panel).getAllByTestId('agent-log-entry')
      expect(entries[0]).toHaveTextContent('1:35 agente Central congestionada; desvio de 25% para a Norte.')
      expect(entries[1]).toHaveTextContent('1:00 regra Nada a mudar.')
      const card = within(panel).getByTestId('card-7')
      expect(card).toHaveTextContent('Desvio Central → Sul · N 120 veíc/h · p 40%')
      expect(card).toHaveTextContent('acidente na central')
      fireEvent.click(within(card).getByRole('button', { name: 'Aprovar' }))
      expect(onApprove).toHaveBeenCalledWith(7)
      fireEvent.click(within(card).getByRole('button', { name: 'Rejeitar' }))
      expect(onReject).toHaveBeenCalledWith(7)
      rerender(<AgentPanel mode="regra" notified={0} log={[]} cards={[]} onApprove={onApprove} onReject={onReject} />)
      expect(within(panel).getByTestId('agent-mode')).toHaveTextContent('modo sem LLM')
      expect(within(panel).queryByRole('list', { name: 'Aguardando aprovação' })).toBeNull()

      // in the page: with the model unreachable, the first turn (30 s) switches to "modo sem LLM"
      vi.useFakeTimers()
      const down: LlmTurn = async () => {
        throw new LlmUnavailable('503')
      }
      render(<App engine={new SimulationEngine({ ratePerMinute: 0 })} transport={new FakeTransport(true)} llm={down} />)
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
