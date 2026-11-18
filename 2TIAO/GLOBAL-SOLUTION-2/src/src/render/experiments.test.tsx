import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { clampRepetitions, runExperiment, type RunMetrics, type RunResult } from '../experiments/ExperimentRunner'
import { ExperimentsPanel } from './ExperimentsPanel'

const metrics = (over: Partial<RunMetrics>): RunMetrics => ({
  tempoMedioViagemS: 100,
  co2TotalKg: 10,
  co2GKm: 150,
  tempoParadoMedioS: 20,
  filaMaxima: 12,
  tempoNormalizarS: 60,
  saturacaoAlternativaPct: 80,
  desviadosPct: 0,
  ...over,
})

const results: RunResult[] = [
  { cenario: 'sem-sistema', repeticao: 1, semente: 1001, metrics: metrics({ tempoMedioViagemS: 120, co2TotalKg: 30 }) },
  { cenario: 'notificar-todos', repeticao: 1, semente: 1001, metrics: metrics({ tempoMedioViagemS: 110, co2TotalKg: 28, desviadosPct: 20 }) },
  { cenario: 'desvio-parcial', repeticao: 1, semente: 1001, metrics: metrics({ tempoMedioViagemS: 100, co2TotalKg: 25, desviadosPct: 6 }) },
  { cenario: 'sem-sistema', repeticao: 2, semente: 1002, metrics: metrics({ tempoMedioViagemS: 130, co2TotalKg: 34 }) },
  { cenario: 'notificar-todos', repeticao: 2, semente: 1002, metrics: metrics({ tempoMedioViagemS: 114, co2TotalKg: 29, desviadosPct: 22 }) },
  { cenario: 'desvio-parcial', repeticao: 2, semente: 1002, metrics: metrics({ tempoMedioViagemS: 104, co2TotalKg: 26, desviadosPct: 8 }) },
]

describe('render', () => {
  describe('ExperimentsPanel', () => {
    it('shows mean and sample deviation per scenario and the comparison bars', async () => {
      const run = vi.fn(async () => ({ results, cancelado: false }))
      const save = vi.fn()
      render(<ExperimentsPanel run={run} save={save} />)
      fireEvent.change(screen.getByLabelText('Repetições'), { target: { value: '2' } })
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rodar' })))
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ repeticoes: 2 }))

      // mean ± sample deviation (n - 1): 120 and 130 -> 125 ± 7,1
      expect(screen.getByTestId('cell-tempoMedioViagemS-sem-sistema')).toHaveTextContent('125,0 ± 7,1')
      expect(screen.getByTestId('cell-tempoMedioViagemS-notificar-todos')).toHaveTextContent('112,0 ± 2,8')
      expect(screen.getByTestId('cell-tempoMedioViagemS-desvio-parcial')).toHaveTextContent('102,0 ± 2,8')
      expect(screen.getByTestId('cell-co2TotalKg-sem-sistema')).toHaveTextContent('32,0 ± 2,8')
      expect(screen.getByTestId('cell-desviadosPct-notificar-todos')).toHaveTextContent('21,0 ± 1,4')
      // every metric has a row
      for (const label of ['Tempo médio de viagem (s)', 'CO₂ total (kg)', 'CO₂ (g/km)', 'Tempo parado médio (s)', 'Fila máxima', 'Tempo até normalizar (s)', 'Saturação da alternativa (%)', 'Desviados (%)']) {
        expect(screen.getByRole('rowheader', { name: label })).toBeInTheDocument()
      }
      // bars: travel time and CO2 per scenario, with the deviation as an error bar
      const bar = screen.getByTestId('bar-tempoMedioViagemS-sem-sistema')
      expect(Number(bar.getAttribute('data-media'))).toBeCloseTo(125, 9)
      expect(Number(bar.getAttribute('data-desvio'))).toBeCloseTo(Math.sqrt(50), 9)
      expect(bar.querySelector('line.err')).not.toBeNull()
      expect(Number(screen.getByTestId('bar-co2TotalKg-desvio-parcial').getAttribute('data-media'))).toBeCloseTo(25.5, 9)
      expect(screen.getByRole('img', { name: 'CO₂ total (kg) por cenário' })).toBeInTheDocument()

      // Baixar CSV hands over the door-1 file
      fireEvent.click(screen.getByRole('button', { name: 'Baixar CSV' }))
      const [csv, name] = save.mock.calls[0] as [string, string]
      expect(name).toBe('experimentos-transito.csv')
      expect(csv.startsWith('﻿cenario;repeticao;semente;')).toBe(true)
      expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + 6 + 3 * 2)
    })

    it('offers accident duration and demand and passes them to the run', async () => {
      const run = vi.fn(async () => ({ results, cancelado: false }))
      const save = vi.fn()
      render(<ExperimentsPanel run={run} save={save} />)
      const accident = screen.getByLabelText('Acidente') as HTMLSelectElement
      const demand = screen.getByLabelText('Demanda (carros/min)') as HTMLInputElement
      expect(accident.value).toBe('2')
      expect([...accident.options].map((o) => o.value)).toEqual(['2', '5'])
      expect(demand.value).toBe('15')
      // typing passes through intermediate values: "1" then "18" stays 18 (not clamped per key)
      fireEvent.change(demand, { target: { value: '1' } })
      expect(demand.value).toBe('1')
      fireEvent.change(demand, { target: { value: '18' } })
      expect(demand.value).toBe('18')
      // demand is kept within 10-20 when the box is left
      fireEvent.change(demand, { target: { value: '40' } })
      fireEvent.blur(demand)
      expect(demand.value).toBe('20')
      fireEvent.change(demand, { target: { value: '3' } })
      fireEvent.blur(demand)
      expect(demand.value).toBe('10')
      fireEvent.change(demand, { target: { value: '18' } })
      fireEvent.blur(demand)
      fireEvent.change(accident, { target: { value: '5' } })
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rodar' })))
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ acidenteMin: 5, demanda: 18 }))
      expect(screen.getByText(/central, 500 m, aos 5 min, por 5 min/)).toBeInTheDocument()
      // the form changes after the run: the CSV and the text keep the parameters of the run shown
      fireEvent.change(accident, { target: { value: '2' } })
      fireEvent.change(demand, { target: { value: '12' } })
      fireEvent.blur(demand)
      expect(screen.getByText(/central, 500 m, aos 5 min, por 5 min/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Baixar CSV' }))
      const lines = (save.mock.calls[0][0] as string).trim().split('\r\n')
      for (const line of lines.slice(1)) expect(line.endsWith(';5;18')).toBe(true)
      // a typed but unclamped value is clamped when the run starts
      run.mockClear()
      fireEvent.change(demand, { target: { value: '99' } })
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rodar' })))
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ acidenteMin: 2, demanda: 20 }))
      expect(demand.value).toBe('20')
    })

    it('runs in chunks shows progress and can be cancelled', async () => {
      // the real runner yields to the page between chunks and stops on abort
      const controller = new AbortController()
      let settled = false
      const pending = runExperiment({ repeticoes: 1, signal: controller.signal }).then((r) => {
        settled = true
        return r
      })
      await new Promise((r) => setTimeout(r, 0))
      expect(settled).toBe(false)
      controller.abort()
      await expect(pending).resolves.toEqual({ results: [], cancelado: true })
      // repetitions are kept within 1-30
      expect([clampRepetitions(0), clampRepetitions(99), clampRepetitions(Number.NaN), clampRepetitions(7)]).toEqual([1, 30, 1, 7])

      // the panel: progress while running, Rodar locked, Cancelar aborts and keeps the finished runs
      let release!: () => void
      let seen: AbortSignal | undefined
      const run = vi.fn(async ({ onProgress, signal }: Parameters<typeof runExperiment>[0]) => {
        seen = signal
        onProgress?.(1, 6)
        onProgress?.(2, 6)
        await new Promise<void>((r) => (release = r))
        return { results: results.slice(0, 2), cancelado: signal?.aborted ?? false }
      })
      const save = vi.fn()
      render(<ExperimentsPanel run={run} save={save} />)
      fireEvent.change(screen.getByLabelText('Repetições'), { target: { value: '2' } })
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rodar' })))
      expect(screen.getByTestId('exp-progress')).toHaveTextContent('2 / 6 rodadas')
      expect(screen.getByRole('button', { name: 'Rodar' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Baixar CSV' })).toBeDisabled()
      expect(screen.getByLabelText('Repetições')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
      expect(seen?.aborted).toBe(true)
      await act(async () => release())
      expect(screen.getByTestId('exp-progress')).toHaveTextContent('Cancelado: 2 / 6 rodadas')
      expect(screen.getByRole('button', { name: 'Rodar' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
      // the runs already finished stay, and the CSV holds only them
      expect(screen.getByTestId('cell-tempoMedioViagemS-sem-sistema')).toHaveTextContent('120,0 ± —')
      fireEvent.click(screen.getByRole('button', { name: 'Baixar CSV' }))
      expect((save.mock.calls[0][0] as string).split('\r\n').filter(Boolean)).toHaveLength(1 + 2 + 2 * 2)
    })
  })
})
