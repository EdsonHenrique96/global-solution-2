import { evidence, ProposalAudit, type AgentEvent, type AuditEntry } from './ProposalAudit'
import type { Simulation } from '../decision/Simulation'
import { segmentName } from '../sensors/segments'
import { AgentLog, type LogOrigin } from './AgentLog'
import { ApprovalQueue, type AgentAction } from './ApprovalQueue'
import { LlmRequestError, type AgentMessage, type Block, type LlmTurn } from './llm'
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
  readonly audit = new ProposalAudit()
  readonly log = new AgentLog()
  readonly queue = new ApprovalQueue()
  mode: 'llm' | 'regra' = 'llm'
  turns = 0
  private readonly sim: Simulation
  private readonly llm: LlmTurn
  private running = new Set<Promise<void>>()
  private eventAt = new Map<string, number>()
  private deferred = new Map<string, AgentEvent>()
  private awaitingAssessment = new Map<string, AgentEvent>()
  private offForecast: (() => void) | null = null
  private alertsSeen = new Set<string>()
  private situationsSeen = new Set<string>()
  private pendingTrigger: string | null = null
  private lastWindow = 0
  private lastSuggestion = 'inativo'

  constructor({ sim, llm }: Options) {
    this.sim = sim
    this.llm = llm
  }

  connect() {
    this.offForecast ??= this.sim.onPrevisao(({ tipo, trecho, ts, ...dados }) => this.onEvent({ tipo, trecho, ts, dados }))
    return () => { this.offForecast?.(); this.offForecast = null }
  }

  onEvent(event: AgentEvent): void {
    const id = event.trecho
    if (!id) return
    const key = event.tipo === 'fila' ? 'fila:' + id : id
    if (this.now() - (this.eventAt.get(key) ?? -Infinity) < 120_000) return
    this.eventAt.set(key, this.now())
    if (event.dados.origem === 'apresentacao' && event.tipo === 'congestionamento' && !this.sim.fractionsFor(id)) {
      this.note('regra', `Calculando as frações de desvio para ${segmentName(id)}.`)
      this.awaitingAssessment.set(id, event)
      return
    }
    this.start(event)
  }

  private now(): number {
    return this.sim.engine.getState().timeMs
  }

  private note(origem: LogOrigin, texto: string): void {
    this.log.add(this.now(), origem, texto)
  }

  /** Call after every simulation tick. */
  tick(presentationOnly = false): void {
    const now = this.now()
    this.audit.tick(this.sim, now)
    for (const [id, event] of this.awaitingAssessment) {
      if (this.sim.readings()[id].exibido !== 'critico' && !this.sim.forecast?.predicted().some(p => p.trecho === id)) {
        this.awaitingAssessment.delete(id)
      } else if (!this.running.size && this.sim.fractionsFor(id)) {
        this.awaitingAssessment.delete(id)
        this.start(event)
      }
    }
    for (const [id, event] of this.deferred) {
      if (this.sim.readings()[id].exibido !== 'critico' && !this.sim.forecast?.predicted().some(p => p.trecho === id)) {
        this.deferred.delete(id)
      } else if (this.sim.fractionsFor(id)) {
        this.deferred.delete(id)
        this.ruleTurn(event)
      }
    }
    for (const card of this.queue.expire(now)) {
      this.audit.settle(card.id, 'expirada', now)
      this.note('regra', `Card ${card.id} expirou sem resposta: ${describe(card.acao)} não aplicado.`)
    }

    // the rules end a diversion when the controller says the segment recovered
    const suggestion = this.sim.diversion.status
    if (this.lastSuggestion === 'ativo' && suggestion === 'inativo' && this.sim.active) {
      this.sim.setActiveDiversion(null)
      this.note('regra', 'Trecho recuperado (velocidade ≥ 35 km/h): desvio encerrado.')
    }
    this.lastSuggestion = suggestion

    const alerts = new Set(Object.entries(this.sim.capacity.fusion.state())
      .flatMap(([id, s]) => s.alertas.flatMap((a) => a.ids.map((alertId) => `${id}:${alertId}`))))
    const situations = new Set(Object.values(this.sim.readings())
      .filter((r) => r.exibido === 'critico' || r.exibido === 'verificacao')
      .map((r) => `${r.id}:${r.exibido}`))
    // Scheduled presentation events already contain the observed incident/queue.
    // Keep card expiry, pending calculations and outcome measurement running, but
    // don't spend another model turn on the same broker echo or periodic review.
    if (presentationOnly) {
      this.alertsSeen = alerts
      this.situationsSeen = situations
      this.pendingTrigger = null
      this.lastWindow = Math.floor(now / TURN_EVERY_MS)
      return
    }
    let triggered = false
    for (const situation of situations) {
      if (this.situationsSeen.has(situation) || !situation.endsWith(':critico')) continue
      const trecho = situation.split(':')[0]
      this.onEvent({ tipo: 'congestionamento', trecho, ts: now, dados: { nivel: 'critico' } })
      triggered = true
    }
    if (triggered) this.pendingTrigger = null
    else if ([...alerts].some((id) => !this.alertsSeen.has(id))) this.pendingTrigger = 'alerta novo'
    else if ([...situations].some((id) => !this.situationsSeen.has(id))) this.pendingTrigger = 'trecho crítico ou incidente'
    this.alertsSeen = alerts
    this.situationsSeen = situations
    const window = Math.floor(now / TURN_EVERY_MS)
    if (this.running.size || triggered) return
    if (this.pendingTrigger || window > this.lastWindow) {
      const trigger = this.pendingTrigger ?? 'janela de 30 s'
      this.pendingTrigger = null
      this.lastWindow = window
      this.start({ tipo: trigger === 'janela de 30 s' ? 'janela' : 'alerta', ts: now, trecho: null, dados: { gatilho: trigger } })
    }
  }

  /** Resolves when no turn is running. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running)
  }

  private start(trigger: AgentEvent): void {
    this.turns += 1
    const task = this.runTurn(trigger).finally(() => this.running.delete(task))
    this.running.add(task)
  }

  private async runTurn(trigger: AgentEvent): Promise<void> {
    try {
      await this.llmTurn(trigger)
      this.mode = 'llm'
    } catch (error) {
      if (error instanceof LlmRequestError) {
        // not an outage: say so, then still decide this window by the rules
        this.note('regra', `Pedido ao agente recusado pelo proxy (${error.message}); esta janela segue pelas regras.`)
      } else {
        this.note('regra', `Agente indisponível (${error instanceof Error ? error.message : 'falha desconhecida'}); esta janela segue pelas regras.`)
      }
      this.mode = 'regra'
      if (trigger.trecho) this.awaitingAssessment.delete(trigger.trecho)
      this.ruleTurn(trigger)
    }
  }

  private async llmTurn(trigger: AgentEvent): Promise<void> {
    const messages: AgentMessage[] = [
      { role: 'user', content: JSON.stringify(trigger) },
    ]
    const simulations = new Map<string, { p: number; proof: ReturnType<typeof evidence> }>()
    let noDiversionEvidence: ReturnType<typeof evidence> | undefined
    if (trigger.tipo !== 'fila' && trigger.trecho && this.sim.engine.segment(trigger.trecho)) {
      const id = trigger.trecho
      const input = { trecho: id }
      const reads = ['consultar_trecho', 'prever_trecho', 'simular_desvio']
      // Batch the three deterministic reads before inference. The transcript preserves
      // exactly the values shown to the model without paying for three extra API calls.
      const readContext = { sim: this.sim, simulations, propose: () => { throw new Error('Ferramenta de leitura') }, explain: () => {} }
      messages.push({ role: 'assistant', content: reads.map(name => ({ type: 'tool_use', name, input, id: name })) })
      messages.push({ role: 'user', content: reads.map(name => ({
        type: 'tool_result', tool_use_id: name, content: executeTool(name, input, readContext).content,
      })) })
      const sizing = this.sim.sizing(id)
      if (!sizing) this.awaitingAssessment.set(id, trigger)
      else noDiversionEvidence = evidence(this.sim, id, { ...sizing, p: 0 })
      const corner = this.sim.engine.segment(id)!.to
      const queues = { intersecao: corner, H: this.sim.engine.queueAt(corner, 'H'), V: this.sim.engine.queueAt(corner, 'V') }
      messages.push({ role: 'user', content: JSON.stringify({ filasNaSaida: queues }) })
    }
    const startTurn = this.turns
    let explained = false
    let choseNoDiversion = false
    let diversionEvaluated = false
    let explanation = ''
    const recordNoDiversion = () => {
      if (!choseNoDiversion || diversionEvaluated || !noDiversionEvidence || !trigger.trecho || !explanation) return
      this.audit.add(trigger, 'agente', { tipo: 'desvio', trecho: trigger.trecho, p: 0, n: 0,
        justificativa: explanation, evidencia: noDiversionEvidence }, 'sem desvio', this.now())
      diversionEvaluated = true
    }
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await this.llm(messages)
      // An event overtakes a general network review. Its older snapshot must not apply a late action.
      if (!trigger.trecho && startTurn !== this.turns) return
      messages.push({ role: 'assistant', content: response.content })
      if (response.stop_reason !== 'tool_use') {
        if (!explained) {
          explanation = response.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ').trim()
          if (explanation) {
            this.note('agente', explanation)
            return
          }
          messages.push({ role: 'user', content: 'Registre a justificativa da decisão, inclusive por que não desviar e o que fazer com os semáforos nos trechos que exigem ação. Use registrar_explicacao.' })
          continue
        }
        return
      }
      let recorded = false
      const results: Block[] = response.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => {
          const r = executeTool(b.name, b.input ?? {}, {
            sim: this.sim, simulations,
            refuse: (id, p, reason) => {
              diversionEvaluated ||= id === trigger.trecho
              this.audit.add(trigger, 'agente', { tipo: 'desvio', trecho: id, p, n: 0, justificativa: reason }, 'recusada', this.now())
            },
            propose: (a) => {
              recorded = true
              diversionEvaluated ||= a.tipo === 'desvio' && a.trecho === trigger.trecho
              return this.propose(a, 'agente', trigger)
            },
            explain: (t) => { explanation = t; explained = true; this.note('agente', t) },
          })
          if (!r.is_error && b.name === 'registrar_explicacao' && b.input.decisao === 'manter_rota') choseNoDiversion = true
          return { type: 'tool_result', tool_use_id: b.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) }
        })
      // Proposals already carry their justification. A final acknowledgement would
      // spend another request and could turn a completed decision into a fallback.
      if (trigger.trecho && (trigger.tipo === 'fila' || diversionEvaluated || explained) && (recorded || explained) && !results.some(r => r.type === 'tool_result' && r.is_error)) {
        recordNoDiversion()
        if (noDiversionEvidence && !diversionEvaluated) this.note('regra', 'Avaliação em aberto: o agente explicou o cenário sem concluir a decisão de desvio.')
        return
      }
      messages.push({ role: 'user', content: results })
    }
    if (!explained) this.note('regra', 'O agente atingiu o limite de chamadas sem registrar justificativa; avaliação incompleta. Nova avaliação na próxima janela.')
  }

  /** The same decision without the model: the controller's suggestion, explained from a template. */
  private ruleTurn(event: AgentEvent): void {
    if (event.tipo === 'fila') {
      const corner = this.sim.engine.segment(event.trecho ?? '')?.to
      if (!corner) return
      const h = this.sim.engine.queueAt(corner, 'H'), v = this.sim.engine.queueAt(corner, 'V')
      if (!this.sim.engine.getState().adaptiveSignals || Math.abs(h - v) < 3) {
        this.note('regra', `Sem ajuste no ${corner}: filas H ${h} e V ${v}; controle e diferença mínima de 3 veículos necessários.`)
        return
      }
      const fase = h > v ? 'H' : 'V'
      const verdeS = Math.min(30, 20 + Math.abs(h - v))
      this.propose({ tipo:'semaforo', intersecao:corner, fase, verdeS,
        justificativa:`Fila na alameda: ${h}; na rua: ${v}. Priorizar a fase ${fase} no próximo verde.` }, 'regra', event)
      return
    }
    const d = this.sim.diversion
    const current = this.sim.active
    const id = event.trecho ?? (d.status === 'ativo' ? d.trecho : null)
    if (id && current?.trecho !== id && !this.queue.pending().some(c => c.acao.tipo === 'desvio' && c.acao.trecho === id)) {
      if (this.sim.readings()[id].exibido === 'verificacao') {
        const reason = 'Possível incidente aguarda confirmação.'
        this.audit.add(event, 'regra', { tipo: 'desvio', trecho: id, p: 0, n: 0, justificativa: reason }, 'recusada', this.now())
        this.note('regra', `Sem desvio de ${segmentName(id)}: ${reason}`)
        return
      }
      const sizing = this.sim.sizing(id)
      if (!sizing) {
        this.deferred.set(id, event)
        this.note('regra', `Sem novo desvio de ${segmentName(id)}: frações de desvio ainda em cálculo.`)
        return
      }
      const data = evidence(this.sim, id, sizing)
      const why = `${segmentName(id)}: ocupação prevista ${data.numeros.ocupacaoPrevistaPct ?? 'indisponível'}%, fração ${pct(sizing.p)}, ganho estimado ${data.numeros.ganhoTempoS ?? 'indisponível'} s e ${data.numeros.ganhoCo2Kg.toFixed(2)} kg de CO₂.`
      const reason = sizing.p > 0 ? why : why + (sizing.simulacao.eficaz ? ' O cenário sem desvio já atende aos limites.' : ' Nenhuma fração melhora a pior ocupação.')
      this.propose({ tipo: 'desvio', trecho: id, n: sizing.n, p: sizing.p, justificativa: reason, evidencia: data }, 'regra', event)
      return
    }
    if (d.status === 'ativo') {
      const reason = d.calculando ? 'frações de desvio ainda em cálculo' : current?.trecho === d.trecho ? 'já existe um desvio aplicado neste trecho' : d.simulacao?.eficaz ? 'o cenário sem desvio já atende aos limites da simulação (fração 0)' : 'nenhuma fração atende aos limites e desviar não melhora o resultado calculado (fração 0)'
      this.note('regra', `Sem novo desvio de ${segmentName(d.trecho)}: ${reason}.`)
      return
    }
    const incidents = Object.values(this.sim.readings()).filter((r) => r.exibido === 'verificacao' || r.exibido === 'critico')
    if (incidents.length) {
      this.note('regra', `Sem desvio nesta janela: ${incidents.map((r) => `${segmentName(r.id)} (${r.exibido}, ${r.velocidade ?? '—'} km/h)`).join('; ')}. O controlador ainda não liberou uma proposta de desvio; incidentes em verificação aguardam confirmação.`)
      return
    }
    this.note('regra', 'Regras (modo sem LLM): nada a mudar nesta janela.')
  }

  /** Public for the operator panel and tests: runs an action through the autonomy policy. */
  applyProposal(action: AgentAction): string {
    return this.propose(action, 'agente')
  }

  private propose(action: AgentAction, origem: 'agente' | 'regra', event?: AgentEvent): string {
    const now = this.now()
    const audit = (decision: AuditEntry['decisao'], cardId?: number) => this.audit.add(event ?? { tipo: 'janela', trecho: action.tipo === 'desvio' ? action.trecho : null, ts: now, dados: {} }, origem, action, decision, now, cardId)
    if (action.tipo === 'desvio') {
      if (!this.sim.isDiversionEnabled()) {
        this.note('regra', `${describe(action)} recusado: o desvio parcial está desligado pelo operador.`)
        audit('recusada')
        return 'recusado: desvio parcial desligado'
      }
      if (action.p <= 0) {
        this.note(origem, `Nada a desviar de ${segmentName(action.trecho)}: fração calculada igual a zero. ${action.justificativa}`)
        audit('sem desvio')
        return 'nada a desviar: p 0'
      }
      if (decideDiversion(action.p) === 'aplicar') {
        this.apply(action)
        audit('automatica')
        this.note(origem, `Aplicado: ${describe(action)} - ${action.justificativa}`)
        return `aplicado: ${describe(action)}`
      }
      const card = this.queue.add(action, this.now())
      audit('aguardando', card.id)
      this.note(origem, `Aguardando aprovação (card ${card.id}): ${describe(action)} - ${action.justificativa}`)
      return `aguardando aprovação do operador (card ${card.id})`
    }
    const verdict = decideGreen(action.verdeS)
    if (verdict === 'recusar') {
      this.note('regra', `Verde de ${action.verdeS} s no ${action.intersecao} (${action.fase}) recusado: fora de 10 a 60 s.`)
      audit('recusada')
      return 'recusado: fora de 10 a 60 s'
    }
    if (verdict === 'aprovar') {
      const card = this.queue.add(action, this.now())
      audit('aguardando', card.id)
      this.note(origem, `Aguardando aprovação (card ${card.id}): ${describe(action)} - ${action.justificativa}`)
      return `aguardando aprovação do operador (card ${card.id})`
    }
    if (!this.apply(action)) { audit('recusada'); return 'recusado: controle de semáforos desligado' }
    audit('automatica')
    this.note(origem, `Aplicado no próximo verde: ${describe(action)} - ${action.justificativa}`)
    return `aplicado no próximo verde: ${describe(action)}`
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
      this.audit.settle(id, 'recusada', this.now())
      this.queue.settle(id, 'nao-aplicada')
      this.note('operador', `Card ${id} aprovado, mas não aplicado: o desvio parcial está desligado.`)
      return
    }
    if (card.acao.tipo === 'desvio' && this.sim.readings()[card.acao.trecho]?.exibido === 'verificacao') {
      this.queue.settle(id, 'nao-aplicada')
      this.audit.settle(id, 'recusada', this.now())
      this.note('operador', `Card ${id} não aplicado: o incidente aguarda confirmação.`)
      return
    }
    const applied = this.apply(card.acao)
    this.audit.settle(id, applied ? 'aprovada' : 'recusada', this.now())
    this.queue.settle(id, applied ? 'aplicada' : 'nao-aplicada')
    this.note(
      'operador',
      applied ? `Card ${id} aprovado: ${describe(card.acao)} aplicado.` : `Card ${id} aprovado, mas não aplicado: ${describe(card.acao)}.`,
    )
  }

  reject(id: number): void {
    const card = this.queue.get(id)
    if (!card || !this.queue.settle(id, 'rejeitada')) return
    this.audit.settle(id, 'rejeitada', this.now())
    this.note('operador', `Card ${id} rejeitado: ${describe(card.acao)} não aplicado.`)
  }
}
