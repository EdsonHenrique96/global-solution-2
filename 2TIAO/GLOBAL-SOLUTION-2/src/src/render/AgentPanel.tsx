import type { LogEntry } from '../agent/AgentLog'
import type { AgentAction, ApprovalCard } from '../agent/ApprovalQueue'
import { segmentName } from '../sensors/segments'

const FASES = { H: 'alameda', V: 'rua' } as const
const ORIGIN: Record<LogEntry['origem'], string> = { agente: 'agente', regra: 'regra', operador: 'operador' }

function actionText(a: AgentAction): string {
  return a.tipo === 'desvio'
    ? `Desvio de ${segmentName(a.trecho)} · N ${Math.round(a.n)} veíc/h · p ${Math.round(a.p * 100)}%`
    : `Verde de ${a.verdeS} s na fase ${FASES[a.fase]} do semáforo ${a.intersecao}`
}

const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

interface Props {
  mode: 'llm' | 'regra'
  log: LogEntry[]
  cards: ApprovalCard[]
  onApprove: (id: number) => void
  onReject: (id: number) => void
}

/** The agent's explanations and the actions waiting for the operator. */
export function AgentPanel({ mode, log, cards, onApprove, onReject }: Props) {
  return (
    <section className="agent" aria-label="Agente">
      <h2>
        Agente <span className={`mode ${mode}`} data-testid="agent-mode">{mode === 'llm' ? 'modo LLM' : 'modo sem LLM'}</span>
      </h2>
      {cards.length > 0 && (
        <ul className="cards" aria-label="Aguardando aprovação">
          {cards.map((c) => (
            <li key={c.id} data-testid={`card-${c.id}`}>
              <strong>{actionText(c.acao)}</strong>
              <span className="why">{c.acao.justificativa}</span>
              <div className="actions">
                <button type="button" onClick={() => onApprove(c.id)}>
                  Aprovar
                </button>
                <button type="button" onClick={() => onReject(c.id)}>
                  Rejeitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ol className="agent-log">
        {log.map((e, i) => (
          <li key={`${e.at}-${i}`} data-testid="agent-log-entry">
            <span className="when">{time(e.at)}</span> <span className={`origin ${e.origem}`}>{ORIGIN[e.origem]}</span> {e.texto}
          </li>
        ))}
      </ol>
    </section>
  )
}
