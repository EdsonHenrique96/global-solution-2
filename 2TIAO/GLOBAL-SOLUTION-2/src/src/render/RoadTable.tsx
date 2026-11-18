import type { RouteStatus } from '../capacity/CapacityModel'
import type { FusedSegment } from '../fusion/FusionService'
import { segmentName } from '../sensors/segments'
import { sortRoads } from './roads'
import { SEM_DADO } from './tooltip'

interface Props {
  segmentIds: readonly string[]
  /** State of each segment as the operator sees it (fusedStatus). */
  status: Record<string, RouteStatus>
  fused: Record<string, FusedSegment>
  /** Unit covering each segment, or "estimado". */
  units: Record<string, string>
  selected: string
  onSelect: (segmentId: string) => void
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }))

/** Every road, worst first (AC 17); clicking a row selects it (AC 18). */
export function RoadTable({ segmentIds, status, fused, units, selected, onSelect }: Props) {
  const rows = sortRoads(
    segmentIds.map((id) => ({ id, estado: status[id] ?? ('sem dados' as const), velocidade: fused[id]?.velocidadeMedia ?? null })),
  )
  return (
    <section className="roads" aria-label="Vias">
      <h2>Vias ({rows.length})</h2>
      <div className="roads-scroll">
        <table>
          <thead>
            <tr>
              <th>Trecho</th>
              <th>Estado</th>
              <th>km/h</th>
              <th>veíc/km</th>
              <th>Unidade</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, estado }) => (
              <tr
                key={id}
                data-testid={`road-${id}`}
                aria-selected={id === selected}
                className={id === selected ? 'selected' : undefined}
                onClick={() => onSelect(id)}
              >
                <td>{segmentName(id)}</td>
                <td className={`estado ${estado.replace(' ', '-')}`}>{estado === 'sem dados' ? SEM_DADO : estado}</td>
                <td>{fmt(fused[id]?.velocidadeMedia)}</td>
                <td>{fmt(fused[id]?.densidade)}</td>
                <td>{units[id] ?? 'estimado'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
