import type { Estimate } from '../capacity/CapacityModel'
import { segmentName } from '../sensors/segments'

const W = 300
const H = 180
const PAD = { left: 40, right: 10, top: 10, bottom: 30 }

interface Props {
  segmentId: string
  estimate: Estimate
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })

/** Capacity of the selected road segment and its flow x density curve forming live. */
export function CapacityPanel({ segmentId, estimate }: Props) {
  const { estado, capacidade, fluxo, folga, vf, kj, amostras } = estimate
  return (
    <section className="capacity" aria-label="Capacidade do trecho">
      <h2>
        Trecho <span data-testid="capacity-via">{segmentName(segmentId)}</span>
      </h2>
      <dl className="capacity-facts">
        <dt>Estado</dt>
        <dd data-testid="capacity-estado" className={`estado ${estado.replace(' ', '-')}`}>
          {estado}
        </dd>
        <dt>Capacidade</dt>
        <dd data-testid="capacity-capacidade">{capacidade === null ? 'aprendendo' : `${fmt(capacidade)} veíc/h`}</dd>
        <dt>Fluxo atual</dt>
        <dd data-testid="capacity-fluxo">{fmt(fluxo)} veíc/h</dd>
        <dt>Folga</dt>
        <dd data-testid="capacity-folga">{folga === null ? 'aprendendo' : `${fmt(folga)} veíc/h`}</dd>
      </dl>
      <Chart samples={amostras} vf={vf} kj={kj} capacidade={capacidade} />
    </section>
  )
}

function Chart({
  samples,
  vf,
  kj,
  capacidade,
}: {
  samples: Estimate['amostras']
  vf: number | null
  kj: number | null
  capacidade: number | null
}) {
  if (samples.length === 0) {
    return <p className="empty">Sem amostras ainda.</p>
  }
  const curve = vf !== null && kj !== null && capacidade !== null
  const kMax = Math.max(10, ...samples.map((s) => s.k), curve ? kj : 0) * 1.05
  const qMax = Math.max(100, ...samples.map((s) => s.q), curve ? capacidade : 0) * 1.1
  const x = (k: number) => PAD.left + (k / kMax) * (W - PAD.left - PAD.right)
  const y = (q: number) => H - PAD.bottom - (q / qMax) * (H - PAD.top - PAD.bottom)

  let path = ''
  if (curve) {
    const steps = 60
    for (let i = 0; i <= steps; i++) {
      const k = (kj * i) / steps
      const q = vf * k * (1 - k / kj)
      path += `${i === 0 ? 'M' : 'L'}${x(k).toFixed(1)},${y(q).toFixed(1)}`
    }
  }

  return (
    <svg
      className="capacity-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Fluxo (veíc/h) por densidade (veíc/km)"
    >
      <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} className="axis" />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} className="axis" />
      <text x={(W + PAD.left) / 2} y={H - 6} textAnchor="middle" className="axis-label">
        densidade (veíc/km)
      </text>
      <text x={12} y={(H - PAD.bottom) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 12 ${(H - PAD.bottom) / 2})`}>
        fluxo (veíc/h)
      </text>
      <text x={PAD.left - 4} y={PAD.top + 8} textAnchor="end" className="tick">
        {Math.round(qMax)}
      </text>
      <text x={W - PAD.right} y={H - PAD.bottom + 12} textAnchor="end" className="tick">
        {Math.round(kMax)}
      </text>
      {samples.map((s, i) => (
        <circle key={i} data-testid="sample-point" data-k={s.k} data-q={s.q} cx={x(s.k)} cy={y(s.q)} r={2.5} className="sample" />
      ))}
      {curve && (
        <>
          <path data-testid="fitted-curve" d={path} className="fit" />
          <circle
            data-testid="capacity-point"
            data-k={kj / 2}
            data-q={capacidade}
            cx={x(kj / 2)}
            cy={y(capacidade)}
            r={5}
            className="capacity-mark"
          />
        </>
      )}
    </svg>
  )
}
