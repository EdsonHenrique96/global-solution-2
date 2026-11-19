import type { DiversionState } from '../decision/DiversionController'
import { diversionText } from './diversionText'

interface Props {
  diversion: DiversionState
  /** "Desvio parcial" on or off. */
  enabled: boolean
  onToggle: () => void
}

/** The Desvio page's head (AD-111): what the diversion is doing now and the switch that turns it on. */
export function DiversionPanel({ diversion, enabled, onToggle }: Props) {
  return (
    <section className="diversion" aria-label="Desvio parcial">
      <div className="card-head">
        <h2>Desvio parcial</h2>
        <button type="button" aria-pressed={enabled} onClick={onToggle}>
          Desvio parcial
        </button>
      </div>
      <p data-testid="diversion-state">{diversionText(diversion)}</p>
      <p className="muted">
        A fração vem da simulação de 10 min à frente; só recebe o aviso quem usa app e tem um caminho pelo menos 10% mais rápido.
      </p>
    </section>
  )
}
