import type { MetricsSample, MetricsSnapshot } from '../decision/MetricsRecorder'


const fmt = (v: number, digits = 1) => v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const seconds = (v: number | null) => (v === null ? '—' : `${fmt(v)} s`)


interface Props {
  metrics: MetricsSnapshot
}

/**
 * Live metrics that show how the network reacts to accidents and decisions (AD-017), in Relatórios.
 * The diversion's state is on the Desvio page (AD-111); the last minute's travel time is the map's card.
 */
export function MetricsPanel({ metrics }: Props) {
  const { samples } = metrics
  return (
    <section className="metrics" aria-label="Métricas">
      <h2>Métricas</h2>
      <dl className="capacity-facts">
        <dt>Tempo médio de viagem (total)</dt>
        <dd data-testid="metric-travel-total">{seconds(metrics.travelAllS)}</dd>
        <dt>Fila total</dt>
        <dd data-testid="metric-queue">{metrics.queueTotal}</dd>
        <dt>Notificados</dt>
        <dd data-testid="metric-diverted">{fmt(metrics.pctDiverted)}%</dd>
      </dl>
      <Spark id="chart-travel" label="Tempo médio de viagem (s)" samples={samples} value={(s) => s.travelS} />
      <Spark id="chart-queue" label="Fila total" samples={samples} value={(s) => s.queue} />
      <Spark id="chart-diverted" label="Notificados (%)" samples={samples} value={(s) => s.pctDiverted} />
    </section>
  )
}

const W = 300
const H = 48

function Spark({
  id,
  label,
  samples,
  value,
}: {
  id: string
  label: string
  samples: MetricsSample[]
  value: (s: MetricsSample) => number | null
}) {
  const raw = samples.map(value)
  // a window with no arrival has no travel time: plotted on the baseline, shown as "—"
  const values = raw.map((v) => v ?? 0)
  const max = Math.max(1, ...values)
  const points = values
    .map((v, i) => {
      const x = samples.length > 1 ? (i / (samples.length - 1)) * W : 0
      const y = H - 4 - (v / max) * (H - 8)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = raw.length ? raw[raw.length - 1] : null
  return (
    <figure className="spark">
      <figcaption>
        {label}
        <span className="spark-last">{last === null ? '—' : fmt(last)}</span>
      </figcaption>
      <svg data-testid={id} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, últimos 10 minutos`}>
        <polyline points={points} />
      </svg>
    </figure>
  )
}
