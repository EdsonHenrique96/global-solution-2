import type { Simulation } from '../decision/Simulation'
import { segmentName } from '../sensors/segments'
import { AgentLog, type LogOrigin } from './AgentLog'
import { ApprovalQueue, type AgentAction } from './ApprovalQueue'
import { LlmRequestError, LlmUnavailable, type AgentMessage, type Block, type LlmTurn } from './llm'
import { decideDiversion, decideGreen } from './policy'
import { executeTool } from './tools'

export const TURN_EVERY_MS = 30_000
export const MAX_MODEL_CALLS = 6
const pct = (p: number) => `${Math.round(p * 100)}%`
const FASES = { H: 'alameda', V: 'rua' } as const

function describe(action: AgentAction): string {
  return action.tipo === 'desvio'
    ? `desvio de ${segmentName(action.trecho)} (fração ${pct(action.p)}, N ${Math.round(action.n)} veíc/h)`
    : `verde de ${action.verdeS} s na fase ${FASES[action.fase]} do semáforo ${action.intersecao}`
}

interface Options {
  sim: Simulation
  llm: LlmTurn
}

/**
 * The traffic agent: every 30 s and on each new alert it runs a turn - the model calls tools that
 * read the network and propose actions; the autonomy policy applies small ones and cards the rest.
 * When the model can't be reached, the same turn runs on the deterministic rules ("modo sem LLM").
 */
export class AgentRunner {
  readonly log = new AgentLog()
  readonly queue = new ApprovalQueue()
  mode: 'llm' | 'regra' = 'llm'
  turns = 0
  private readonly sim: Simulation
  private readonly llm: LlmTurn
  private busy: Promise<void> | null = null
  private alertsSeen = 0
  private lastSuggestion = 'inativo'

  constructor({ sim, llm }: Options) {
    this.sim = sim
    this.llm = llm
  }

  private now(): number {
    return this.sim.engine.getState().timeMs
  }

  private note(origem: LogOrigin, texto: string): void {
    this.log.add(this.now(), origem, texto)
  }

  /** Call after every simulation tick. */
  tick(): void {
    const now = this.now()
    for (const card of this.queue.expire(now)) this.note('regra', `Card ${card.id} expirou sem resposta: ${describe(card.acao)} não aplicado.`)

    // the rules end a diversion when the controller says the segment recovered
    const suggestion = this.sim.diversion.status
    if (this.lastSuggestion === 'ativo' && suggestion === 'inativo' && this.sim.active) {
      this.sim.setActiveDiversion(null)
      this.note('regra', 'Trecho recuperado (velocidade ≥ 35 km/h): desvio encerrado.')
    }
    this.lastSuggestion = suggestion

    const alerts = Object.values(this.sim.capacity.fusion.state()).reduce((n, s) => n + s.alertas.length, 0)
    const newAlert = alerts > this.alertsSeen
    this.alertsSeen = alerts
    if (this.busy) return
    if (newAlert) this.start('alerta novo')
    else if (now > 0 && now % TURN_EVERY_MS === 0) this.start('janela de 30 s')
  }

  /** Resolves when no turn is running. */
  async idle(): Promise<void> {
    while (this.busy) await this.busy
  }

  private start(trigger: string): void {
    this.turns += 1
    this.busy = this.runTurn(trigger).finally(() => {
      this.busy = null
    })
  }

  private async runTurn(trigger: string): Promise<void> {
    try {
      await this.llmTurn(trigger)
      this.mode = 'llm'
    } catch (error) {
      if (error instanceof LlmRequestError) {
        // not an outage: say so, then still decide this window by the rules
        this.note('regra', `Pedido ao agente recusado pelo proxy (${error.message}); esta janela segue pelas regras.`)
      } else if (!(error instanceof LlmUnavailable)) {
        throw error
      }
      this.mode = 'regra'
      this.ruleTurn()
    }
  }

  private async llmTurn(trigger: string): Promise<void> {
    const messages: AgentMessage[] = [
      { role: 'user', content: `Tempo ${this.now() / 1000} s. Gatilho: ${trigger}. Avalie a rede e decida.` },
    ]
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await this.llm(messages)
      messages.push({ role: 'assistant', content: response.content })
      if (response.stop_reason !== 'tool_use') return
      const results: Block[] = response.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => {
          const r = executeTool(b.name, b.input ?? {}, {
            sim: this.sim,
            propose: (a) => this.propose(a, 'agente'),
            explain: (t) => this.note('agente', t),
          })
          return { type: 'tool_result', tool_use_id: b.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) }
        })
      messages.push({ role: 'user', content: results })
    }
  }

  /** The same decision without the model: the controller's suggestion, explained from a template. */
  private ruleTurn(): void {
    const d = this.sim.diversion
    const current = this.sim.active
    if (d.status === 'ativo' && d.p > 0 && current?.trecho !== d.trecho) {
      const e = this.sim.capacity.snapshot()[d.trecho]
      const why = `${segmentName(d.trecho)} congestionado (${e?.velocidade ?? '—'} km/h); ${d.candidatos} motoristas com app ainda vão passar por ele`
      const outcome = this.propose({ tipo: 'desvio', trecho: d.trecho, n: d.n, p: d.p, justificativa: why }, 'regra')
      this.note('regra', `Desvio pelas regras: ${why}. ${outcome}.`)
      return
    }
    this.note('regra', 'Regras (modo sem LLM): nada a mudar nesta janela.')
  }

  /** Public for the operator panel and tests: runs an action through the autonomy policy. */
  applyProposal(action: AgentAction): string {
    return this.propose(action, 'agente')
  }

  private propose(action: AgentAction, origem: LogOrigin): string {
    if (action.tipo === 'desvio') {
      if (!this.sim.isDiversionEnabled()) {
        this.note('regra', `${describe(action)} recusado: o desvio parcial está desligado pelo operador.`)
        return 'recusado: desvio parcial desligado'
      }
      if (action.p <= 0) {
        this.note(origem, `Nada a desviar de ${segmentName(action.trecho)}: sem excesso ou sem folga.`)
        return 'nada a desviar: p 0'
      }
      if (decideDiversion(action.p) === 'aplicar') {
        this.apply(action)
        return `aplicado: ${describe(action)}`
      }
      const card = this.queue.add(action, this.now())
      this.note(origem, `Aguardando aprovação (card ${card.id}): ${describe(action)} - ${action.justificativa}`)
      return `aguardando aprovação do operador (card ${card.id})`
    }
    const verdict = decideGreen(action.verdeS)
    if (verdict === 'recusar') {
      this.note('regra', `Verde de ${action.verdeS} s no ${action.intersecao} (${action.fase}) recusado: fora de 10 a 60 s.`)
      return 'recusado: fora de 10 a 60 s'
    }
    if (verdict === 'aprovar') {
      const card = this.queue.add(action, this.now())
      this.note(origem, `Aguardando aprovação (card ${card.id}): ${describe(action)} - ${action.justificativa}`)
      return `aguardando aprovação do operador (card ${card.id})`
    }
    return this.apply(action) ? `aplicado no próximo verde: ${describe(action)}` : 'recusado: controle de semáforos desligado'
  }

  private apply(action: AgentAction): boolean {
    if (action.tipo === 'desvio') {
      this.sim.setActiveDiversion({ trecho: action.trecho, p: action.p, mode: 'parcial' })
      return true
    }
    const ok = this.sim.engine.setNextGreen(action.intersecao, action.fase, action.verdeS)
    if (!ok) this.note('regra', `Verde do ${action.intersecao} não aplicado: controle de semáforos desligado.`)
    return ok
  }

  approve(id: number): void {
    const card = this.queue.get(id)
    if (!card || card.estado !== 'aguardando') return
    if (card.acao.tipo === 'desvio' && !this.sim.isDiversionEnabled()) {
      this.queue.settle(id, 'nao-aplicada')
      this.note('operador', `Card ${id} aprovado, mas não aplicado: o desvio parcial está desligado.`)
      return
    }
    const applied = this.apply(card.acao)
    this.queue.settle(id, applied ? 'aplicada' : 'nao-aplicada')
    this.note(
      'operador',
      applied ? `Card ${id} aprovado: ${describe(card.acao)} aplicado.` : `Card ${id} aprovado, mas não aplicado: ${describe(card.acao)}.`,
    )
  }

  reject(id: number): void {
    const card = this.queue.get(id)
    if (!card || !this.queue.settle(id, 'rejeitada')) return
    this.note('operador', `Card ${id} rejeitado: ${describe(card.acao)} não aplicado.`)
  }
}
