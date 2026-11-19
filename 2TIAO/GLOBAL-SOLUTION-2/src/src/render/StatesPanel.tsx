import { centroidUnits, type KMeansModel } from '../capacity/StateClassifier'
import { segmentName } from '../sensors/segments'
import { NIVEIS, type SegmentReading } from './levels'

const W = 320
const H = 180
const PAD = 28
const fmt = (v: number, d = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d })

interface Props {
  /** The K-means in use; null while the map classifies by the rule. */
  model: KMeansModel | null
  /** The paired segments now, each with the level the map shows. */
  readings: readonly SegmentReading[]
}

/** Relatórios: the four K-means states, the paired segments on speed x density, and the agreement with the rule (AC 23). */
export function StatesPanel({ model, readings }: Props) {
  if (!model) {
    return (
      <section className="card states" aria-label="Estados do tráfego">
        <div className="card-head">
          <h2>Estados do tráfego (K-means)</h2>
        </div>
        <p className="empty">Modelo K-means não carregado · classificação por regra</p>
      </section>
    )
  }
  const centroids = model.centroides.map((c) => ({ nivel: c.nivel, real: centroidUnits(model, c.centro) }))
  const points = readings.filter((r) => r.densidade !== null && r.nivel !== 'sem dado')
  const maxK = Math.max(10, ...centroids.map((c) => c.real[2]), ...points.map((p) => p.densidade!)) * 1.1
  const maxV = Math.max(60, ...centroids.map((c) => c.real[0]), ...points.map((p) => p.velocidade ?? 50)) * 1.05
  const x = (k: number) => PAD + (k / maxK) * (W - PAD - 8)
  const y = (v: number) => H - PAD - (v / maxV) * (H - PAD - 8)
  return (
    <section className="card states" aria-label="Estados do tráfego">
      <div className="card-head">
        <h2>Estados do tráfego (K-means)</h2>
        <span className="muted">k = 4 · {model.versao}</span>
      </div>
      <table data-testid="kmeans-centroides">
        <thead>
          <tr>
            <th>Nível</th>
            <th>Velocidade (km/h)</th>
            <th>Fluxo (carros/min)</th>
            <th>Densidade (veíc/km)</th>
          </tr>
        </thead>
        <tbody>
          {centroids.map((c) => (
            <tr key={c.nivel} data-testid={`centroide-${c.nivel}`}>
              <td style={{ color: NIVEIS[c.nivel].color }}>{NIVEIS[c.nivel].label}</td>
              <td>{fmt(c.real[0])}</td>
              <td>{fmt(c.real[1])}</td>
              <td>{fmt(c.real[2])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <svg viewBox={`0 0 ${W} ${H}`} className="series" role="img" aria-label="Velocidade × densidade por nível" data-testid="kmeans-grafico">
        <line x1={PAD} y1={H - PAD} x2={W - 4} y2={H - PAD} className="axis" />
        <line x1={PAD} y1={4} x2={PAD} y2={H - PAD} className="axis" />
        <text x={W - 4} y={H - 8} textAnchor="end" className="tick">
          densidade (veíc/km)
        </text>
        <text x={4} y={12} className="tick">
          km/h
        </text>
        {centroids.map((c) => (
          <circle key={c.nivel} cx={x(c.real[2])} cy={y(c.real[0])} r={9} fill="none" stroke={NIVEIS[c.nivel].color} strokeWidth={2} data-testid={`grafico-centroide-${c.nivel}`} />
        ))}
        {points.map((p) => (
          <circle key={p.id} cx={x(p.densidade!)} cy={y(p.velocidade ?? 50)} r={4} fill={NIVEIS[p.exibido].color} data-testid={`ponto-${p.id}`} data-nivel={p.exibido}>
            <title>{`${segmentName(p.id)} · ${NIVEIS[p.exibido].label}`}</title>
          </circle>
        ))}
      </svg>
      <p data-testid="kmeans-concordancia">Concordância com a regra: {Math.round(model.concordanciaRegraPct)}%</p>
    </section>
  )
}
