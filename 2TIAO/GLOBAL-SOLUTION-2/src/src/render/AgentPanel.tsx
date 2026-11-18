import type { LogEntry } from '../agent/AgentLog'
import type { AgentAction, ApprovalCard } from '../agent/ApprovalQueue'

const NAMES: Record<string, string> = { central: 'Central', norte: 'Norte', sul: 'Sul' }
const ORIGIN: Record<LogEntry['origem'], string> = { agente: 'agente', regra: 'regra', operador: 'operador' }

function actionText(a: AgentAction): string {
  return a.tipo === 'desvio'
    ? `Desvio ${NAMES[a.de] ?? a.de} → ${NAMES[a.para] ?? a.para} · N ${Math.round(a.n)} veíc/h · p ${Math.round(a.p * 100)}%`
    : `Verde de ${a.verdeS} s no semáforo ${a.intersecao}`
}

const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

interface Props {
  mode: 'llm' | 'regra'
  log: LogEntry[]
  cards: ApprovalCard[]
  notified: number
  onApprove: (id: number) => void
  onReject: (id: number) => void
}

/** The agent's explanations, the actions waiting for the operator, and the drivers' channel. */
export function AgentPanel({ mode, log, cards, notified, onApprove, onReject }: Props) {
  return (
    <section className="agent" aria-label="Agente">
      <h2>
        Agente <span className={`mode ${mode}`} data-testid="agent-mode">{mode === 'llm' ? 'modo LLM' : 'modo sem LLM'}</span>
      </h2>
      <p className="channel">
        Canal de notificação: <strong>App de mapa do motorista (simulado)</strong> · notificados:{' '}
        <strong data-testid="agent-notified">{notified}</strong>
      </p>
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
