import { useRef, useState } from 'react'
import { meanFraction, METRIC_KEYS, summarise, toCsv } from '../experiments/csv'
import { ACCIDENT_MINUTES, clampDemand, clampRepetitions, DEMAND_MAX, DEMAND_MIN, RATE_PER_MINUTE, runExperiment, SCENARIOS, type ExperimentParams, type RunMetrics, type RunResult } from '../experiments/ExperimentRunner'

const LABELS: Record<keyof RunMetrics, string> = {
  tempoMedioViagemS: 'Tempo médio de viagem (s)',
  co2TotalKg: 'CO₂ total (kg)',
  co2GKm: 'CO₂ (g/km)',
  tempoParadoMedioS: 'Tempo parado médio (s)',
  filaMaxima: 'Fila máxima',
  tempoNormalizarS: 'Tempo até normalizar (s)',
  saturacaoAlternativaPct: 'Saturação da alternativa (%)',
  desviadosPct: 'Desviados (%)',
  fracaoDesvio: 'Fração do desvio',
}
const SCENARIO_NAMES: Record<string, string> = {
  'sem-sistema': 'Sem sistema',
  'notificar-todos': 'Notificar todos',
  'desvio-parcial': 'Desvio parcial',
}
const fmt = (v: number | null, d = 1) => (v === null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d }))

type Runner = typeof runExperiment

interface Props {
  /** Injected in tests; the page runs the real experiment. */
  run?: Runner
  /** Injected in tests; the page saves the CSV through a download link. */
  save?: (csv: string, filename: string) => void
}

function download(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Three scenarios, the same accident, N repetitions: mean ± sample deviation, chart and CSV. */
export function ExperimentsPanel({ run = runExperiment, save = download }: Props) {
  const [reps, setReps] = useState(10)
  const [acidenteMin, setAcidenteMin] = useState<ExperimentParams['acidenteMin']>(2)
  /** Raw text while the operator types; clamped to DEMAND_MIN-DEMAND_MAX on blur and when the run starts. */
  const [demandaText, setDemandaText] = useState(String(RATE_PER_MINUTE))
  const demanda = clampDemand(Number(demandaText))
  /** Parameters of the run whose results are shown (the CSV carries these, not the form's). */
  const [ran, setRan] = useState<ExperimentParams>({ acidenteMin: 2, demanda: RATE_PER_MINUTE })
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [results, setResults] = useState<RunResult[]>([])
  const [status, setStatus] = useState<'parado' | 'rodando' | 'concluido' | 'cancelado'>('parado')
  const abort = useRef<AbortController | null>(null)

  const start = async () => {
    abort.current = new AbortController()
    setDemandaText(String(demanda))
    setRan({ acidenteMin, demanda })
    setStatus('rodando')
    setResults([])
    setProgress({ done: 0, total: clampRepetitions(reps) * SCENARIOS.length })
    const out = await run({
      repeticoes: reps,
      acidenteMin,
      demanda,
      signal: abort.current.signal,
      onProgress: (done, total) => setProgress({ done, total }),
    })
    setResults(out.results)
    setStatus(out.cancelado ? 'cancelado' : 'concluido')
  }

  const summary = summarise(results)
  const bar = (metric: 'tempoMedioViagemS' | 'co2TotalKg', title: string) => {
    const stats = SCENARIOS.map((c) => summary[c]?.[metric] ?? { media: null, desvio: null })
    const max = Math.max(1, ...stats.map((s) => (s.media ?? 0) + (s.desvio ?? 0)))
    return (
      <figure className="exp-bars">
        <figcaption>{title}</figcaption>
        <svg viewBox="0 0 300 120" role="img" aria-label={`${title} por cenário`}>
          {SCENARIOS.map((c, i) => {
            const s = stats[i]
            const h = ((s.media ?? 0) / max) * 90
            const x = 20 + i * 95
            const err = ((s.desvio ?? 0) / max) * 90
            return (
              <g key={c} data-testid={`bar-${metric}-${c}`} data-media={s.media ?? ''} data-desvio={s.desvio ?? ''}>
                <rect x={x} y={100 - h} width={60} height={h} className={`bar ${c}`} />
                {s.desvio !== null && <line x1={x + 30} x2={x + 30} y1={100 - h - err} y2={100 - h + err} className="err" />}
                <text x={x + 30} y={114} textAnchor="middle">
                  {SCENARIO_NAMES[c]}
                </text>
              </g>
            )
          })}
        </svg>
      </figure>
    )
  }

  return (
    <section className="experiments" aria-label="Experimentos">
      <h2>Experimentos</h2>
      <p className="hint">
        Três cenários com o mesmo acidente (central, 500 m, aos 5 min, por {status === 'parado' ? acidenteMin : ran.acidenteMin} min) e a mesma semente em cada repetição, em rodadas de 25 min.
      </p>
      <div className="exp-controls">
        <label>
          Repetições
          <input type="number" min={1} max={30} value={reps} onChange={(e) => setReps(clampRepetitions(Number(e.target.value)))} disabled={status === 'rodando'} />
        </label>
        <label>
          Acidente
          <select value={acidenteMin} onChange={(e) => setAcidenteMin(Number(e.target.value) as ExperimentParams['acidenteMin'])} disabled={status === 'rodando'}>
            {ACCIDENT_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <label>
          Demanda (carros/min)
          <input
            type="number"
            min={DEMAND_MIN}
            max={DEMAND_MAX}
            value={demandaText}
            onChange={(e) => setDemandaText(e.target.value)}
            onBlur={() => setDemandaText(String(demanda))}
            disabled={status === 'rodando'}
          />
        </label>
        <button type="button" onClick={start} disabled={status === 'rodando'}>
          Rodar
        </button>
        <button type="button" onClick={() => abort.current?.abort()} disabled={status !== 'rodando'}>
          Cancelar
        </button>
        <button type="button" onClick={() => save(toCsv(results, ran), 'experimentos-transito.csv')} disabled={results.length === 0 || status === 'rodando'}>
          Baixar CSV
        </button>
      </div>
      {progress && (
        <p data-testid="exp-progress">
          {status === 'cancelado' ? 'Cancelado: ' : ''}
          {progress.done} / {progress.total} rodadas
        </p>
      )}
      {results.length > 0 && (
        <>
          <table className="exp-table" data-testid="exp-summary">
            <thead>
              <tr>
                <th scope="col">Métrica</th>
                {SCENARIOS.map((c) => (
                  <th scope="col" key={c}>
                    {SCENARIO_NAMES[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRIC_KEYS.map((k) => (
                <tr key={k}>
                  <th scope="row">{LABELS[k]}</th>
                  {SCENARIOS.map((c) => {
                    const s = summary[c]?.[k]
                    // an empty "tempo até normalizar" is a result: the queue did not settle in the run (AD-085)
                    const unsettled = k === 'tempoNormalizarS' ? results.filter((r) => r.cenario === c && r.metrics.tempoNormalizarS === null).length : 0
                    const text = !s ? '—' : unsettled > 0 && s.media === null ? 'não normalizou' : `${fmt(s.media)} ± ${fmt(s.desvio)}`
                    return (
                      <td key={c} data-testid={`cell-${k}-${c}`}>
                        {text}
                        {unsettled > 0 && s?.media !== null && ` · ${unsettled} não normalizou`}
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr>
                <th scope="row">{LABELS.fracaoDesvio}</th>
                {SCENARIOS.map((c) => {
                  const f = meanFraction(results.filter((r) => r.cenario === c))
                  return (
                    <td key={c} data-testid={`cell-fracaoDesvio-${c}`}>
                      {f === null ? '—' : `${fmt(f * 100, 0)}%`}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
          {bar('tempoMedioViagemS', 'Tempo médio de viagem (s)')}
          {bar('co2TotalKg', 'CO₂ total (kg)')}
        </>
      )}
    </section>
  )
}
