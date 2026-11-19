import { PAPEL_LABEL, type PlateCamera } from '../sensors/PlateCamera'
import { segmentName } from '../sensors/segments'
import { unitOnline } from './levels'

interface Props {
  cameras: readonly PlateCamera[]
  /** Simulated time of each camera's last status that came through the broker. */
  lastStatus: Record<string, number>
  nowMs: number
  /** The camera "Ver câmera" opened this tab for. */
  selected?: string | null
}

/** The 24 plate cameras, fixed at the ends of their segments (AD-076): segment, role and status. */
export function CameraPanel({ cameras, lastStatus, nowMs, selected }: Props) {
  return (
    <section className="cameras card" aria-label="Câmeras de placa">
      <div className="card-head">
        <h2>Câmeras de placa</h2>
        <span className="muted">{cameras.length} câmeras · entrada e saída de cada trecho monitorado</span>
      </div>
      <ul>
        {cameras.map((c) => {
          const online = unitOnline(lastStatus[c.id], nowMs)
          return (
            <li key={c.id} data-testid={`camera-${c.id}`} aria-current={c.id === selected ? 'true' : undefined} className={c.id === selected ? 'selected' : undefined}>
              <strong>{c.id}</strong>
              <span data-testid="camera-trecho">{segmentName(c.trecho)}</span>
              <span data-testid="camera-papel">{PAPEL_LABEL[c.papel]}</span>
              <span data-testid="camera-status" className={`camera-status ${online ? 'on' : 'off'}`}>
                {online ? 'online' : 'offline'}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
