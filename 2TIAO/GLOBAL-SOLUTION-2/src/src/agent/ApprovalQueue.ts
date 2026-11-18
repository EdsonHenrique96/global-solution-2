export const CARD_TTL_MS = 120_000

export type AgentAction =
  | { tipo: 'desvio'; de: string; para: string; n: number; p: number; justificativa: string }
  | { tipo: 'semaforo'; intersecao: string; verdeS: number; justificativa: string }

/** 'nao-aplicada': approved, but the system could not apply it (e.g. signal control off). */
export type CardState = 'aguardando' | 'aplicada' | 'nao-aplicada' | 'rejeitada' | 'expirada'

export interface ApprovalCard {
  id: number
  acao: AgentAction
  criadoEm: number
  estado: CardState
}

/** Actions above the autonomy limits, waiting for the operator. */
export class ApprovalQueue {
  private cards: ApprovalCard[] = []
  private nextId = 1

  add(acao: AgentAction, at: number): ApprovalCard {
    const card: ApprovalCard = { id: this.nextId++, acao, criadoEm: at, estado: 'aguardando' }
    this.cards.push(card)
    return card
  }

  get(id: number): ApprovalCard | undefined {
    return this.cards.find((c) => c.id === id)
  }

  pending(): ApprovalCard[] {
    return this.cards.filter((c) => c.estado === 'aguardando')
  }

  all(): ApprovalCard[] {
    return [...this.cards]
  }

  /** Marks a waiting card; returns false when it is no longer waiting. */
  settle(id: number, estado: Exclude<CardState, 'aguardando'>): boolean {
    const card = this.get(id)
    if (!card || card.estado !== 'aguardando') return false
    card.estado = estado
    return true
  }

  /** Cards waiting for 120 s or more expire; returns them. */
  expire(now: number): ApprovalCard[] {
    const out = this.cards.filter((c) => c.estado === 'aguardando' && now - c.criadoEm >= CARD_TTL_MS)
    for (const c of out) c.estado = 'expirada'
    return out
  }
}
