import type { RunMetrics } from './ExperimentRunner'

export const METRIC_KEYS: (keyof RunMetrics)[] = [
  'tempoMedioViagemS',
  'co2TotalKg',
  'co2GKm',
  'tempoParadoMedioS',
  'filaMaxima',
  'tempoNormalizarS',
  'saturacaoAlternativaPct',
  'desviadosPct',
]

export const CSV_HEADER =
  'cenario;repeticao;semente;tempo_medio_viagem_s;co2_total_kg;co2_g_km;tempo_parado_medio_s;fila_maxima;tempo_normalizar_s;saturacao_alternativa_pct;desviados_pct;acidente_min;demanda_carros_min;fracao_desvio'

export interface CsvRow {
  cenario: string
  repeticao: number
  semente: number
  metrics: RunMetrics
}

export interface Stat {
  media: number | null
  desvio: number | null
}

/** pt-BR number: decimal comma, up to 4 decimals, no thousands separator; null -> empty. */
const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(4))).replace('.', ','))

/** Mean and sample standard deviation (n - 1) per scenario and metric, leaving nulls out. */
export function summarise(rows: CsvRow[]): Record<string, Record<keyof RunMetrics, Stat>> {
  const out: Record<string, Record<keyof RunMetrics, Stat>> = {}
  for (const cenario of [...new Set(rows.map((r) => r.cenario))]) {
    const mine = rows.filter((r) => r.cenario === cenario)
    out[cenario] = Object.fromEntries(
      METRIC_KEYS.map((k) => {
        const xs = mine.map((r) => r.metrics[k]).filter((v): v is number => v !== null && Number.isFinite(v))
        if (xs.length === 0) return [k, { media: null, desvio: null }]
        const m = xs.reduce((a, b) => a + b, 0) / xs.length
        const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : null
        return [k, { media: m, desvio: sd }]
      }),
    ) as Record<keyof RunMetrics, Stat>
  }
  return out
}

/** Mean diverted fraction of a scenario's runs; null when none had one. */
export function meanFraction(rows: readonly CsvRow[]): number | null {
  const xs = rows.map((r) => r.metrics.fracaoDesvio).filter((v): v is number => v !== null && v !== undefined)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/** One row per run, then a mean and a deviation row per scenario; `;`, decimal comma, BOM. */
export function toCsv(rows: CsvRow[], params: { acidenteMin: number; demanda: number }): string {
  const tail = [num(params.acidenteMin), num(params.demanda)]
  const lines = [CSV_HEADER]
  // fracao_desvio closes each line (AC 18): empty without the system
  for (const r of rows) lines.push([r.cenario, r.repeticao, r.semente, ...METRIC_KEYS.map((k) => num(r.metrics[k])), ...tail, num(r.metrics.fracaoDesvio ?? null)].join(';'))
  const summary = summarise(rows)
  for (const [cenario, stats] of Object.entries(summary)) {
    const fracao = meanFraction(rows.filter((r) => r.cenario === cenario))
    lines.push([cenario, 'media', '', ...METRIC_KEYS.map((k) => num(stats[k].media)), ...tail, num(fracao)].join(';'))
    lines.push([cenario, 'desvio_padrao', '', ...METRIC_KEYS.map((k) => num(stats[k].desvio)), ...tail, ''].join(';'))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}
