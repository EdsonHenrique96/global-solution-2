import type { FlashingLight } from '../sim/SimulationEngine'
import type { LightState, Phase } from '../sim/trafficLight'
import { NIVEIS } from './levels'

interface Props {
  lights: readonly LightState[]
  /** Each corner's name ("Al. Santos × R. Augusta"), by intersection id. */
  cornerName: (intersectionId: string) => string
  flashing: readonly FlashingLight[]
  nowMs: number
  /** The adaptive control (AD-031): on, each green follows its queue. */
  adaptive: boolean
  onToggleAdaptive: () => void
  /** "Normalizar": ends a flashing light. */
  onNormalize: (flashingId: number) => void
}

const PHASE: Record<Phase, { label: string; color: string }> = {
  verde: { label: 'Verde', color: NIVEIS.livre.color },
  amarelo: { label: 'Amarelo', color: NIVEIS.moderado.color },
  vermelho: { label: 'Vermelho', color: NIVEIS.critico.color },
  piscante: { label: 'Piscante', color: NIVEIS.moderado.color },
}

function PhaseCell({ phase }: { phase: Phase }) {
  const p = PHASE[phase]
  return (
    <td>
      <span className="phase" style={{ color: p.color }}>
        <i className="dot" style={{ background: p.color }} />
        {p.label}
      </span>
    </td>
  )
}

/** The Semáforos page (AD-111): every corner's light now, the flashing ones and the adaptive control. */
export function SignalsPanel({ lights, cornerName, flashing, nowMs, adaptive, onToggleAdaptive, onNormalize }: Props) {
  const flashingAt = new Map(flashing.map((f) => [f.intersectionId, f]))
  return (
    <section className="signals" aria-label="Semáforos">
      <div className="card-head">
        <h2>Esquinas</h2>
        <button type="button" aria-pressed={adaptive} onClick={onToggleAdaptive}>
          Controle de semáforos
        </button>
      </div>
      <p className="muted">
        {adaptive
          ? 'Adaptativo coordenado: o verde de cada fase segue a fila (15-30 s) e o ciclo continua alinhado entre as esquinas.'
          : 'Tempo fixo: 20 s de verde e 3 s de amarelo por fase, com onda verde de 10 s por quarteirão.'}
      </p>
      <table data-testid="signals-table">
        <thead>
          <tr>
            <th>Esquina</th>
            <th>Alamedas</th>
            <th>Ruas</th>
            <th>Muda em</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {lights.map((l) => {
            const f = flashingAt.get(l.intersectionId)
            return (
              <tr key={l.intersectionId} data-testid={`signal-${l.intersectionId}`}>
                <td>{cornerName(l.intersectionId)}</td>
                <PhaseCell phase={l.h} />
                <PhaseCell phase={l.v} />
                <td>{f || !Number.isFinite(l.remainingS) ? '—' : `${Math.max(0, Math.ceil(l.remainingS))} s`}</td>
                <td>
                  {f ? (
                    <span className="signal-state">
                      <span className="tone-warn">Intermitente · {Math.max(0, Math.ceil((f.endsAtMs - nowMs) / 60_000))} min</span>
                      <button type="button" className="btn sm" onClick={() => onNormalize(f.id)}>
                        Normalizar
                      </button>
                    </span>
                  ) : (
                    <span className="muted">Normal</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
