import type { Simulation } from '../decision/Simulation'
import type { TelemetryTransport } from '../telemetry/transport'
import { AgentLog, type LogOrigin } from './AgentLog'
import { ApprovalQueue, type AgentAction } from './ApprovalQueue'
import { LlmRequestError, LlmUnavailable, type AgentMessage, type Block, type LlmTurn } from './llm'
import { decideDiversion, decideGreen } from './policy'
import { executeTool } from './tools'

export const TURN_EVERY_MS = 30_000
export const MAX_MODEL_CALLS = 6
export const NOTIFICATIONS_TOPIC = 'transito/notificacoes'
export const NOTIFICATION_CHANNEL = 'app-de-mapa-simulado'
const WINDOW_MS = 10_000
const NAMES: Record<string, string> = { central: 'Central', norte: 'Norte', sul: 'Sul' }
const name = (id: string) => NAMES[id] ?? id
const pct = (p: number) => `${Math.round(p * 100)}%`

function describe(action: AgentAction): string {
  return action.tipo === 'desvio'
    ? `desvio ${name(action.de)} → ${name(action.para)} (N ${Math.round(action.n)} veíc/h, p ${pct(action.p)})`
    : `verde de ${action.verdeS} s no semáforo ${action.intersecao}`
}

interface Options {
  sim: Simulation
  llm: LlmTurn
  transport: TelemetryTransport
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
  notified = 0
  private readonly sim: Simulation
  private readonly llm: LlmTurn
  private readonly transport: TelemetryTransport
  private busy: Promise<void> | null = null
  private alertsSeen = 0
  private lastDiverted = 0
  private lastSuggestion = 'inativo'

  constructor({ sim, llm, transport }: Options) {
    this.sim = sim
    this.llm = llm
    this.transport = transport
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
    if (now % WINDOW_MS === 0) this.notify(now)

    // the rules end a diversion when the controller says the route recovered
    const suggestion = this.sim.diversion.status
    if (this.lastSuggestion === 'ativo' && suggestion === 'inativo' && this.sim.engine.getState().diversion) {
      this.sim.engine.setDiversion(null)
      this.note('regra', 'Rota recuperada (velocidade ≥ 35 km/h): desvio encerrado.')
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
    const current = this.sim.engine.getState().diversion
    if (d.status === 'ativo' && d.p > 0 && !(current && current.from === d.from && current.to === d.to)) {
      const routes = this.sim.capacity.routes()
      const why = `${name(d.from)} congestionada (${routes[d.from].velocidade ?? '—'} km/h); ${name(d.to)} com folga de ${Math.round(routes[d.to].folga ?? 0)} veíc/h`
      const outcome = this.propose({ tipo: 'desvio', de: d.from, para: d.to, n: d.n, p: d.p, justificativa: why }, 'regra')
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
        this.note(origem, `Nada a desviar de ${name(action.de)} para ${name(action.para)}: sem excesso ou sem folga.`)
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
      this.note('regra', `Verde de ${action.verdeS} s no ${action.intersecao} recusado: fora de 10 a 60 s.`)
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
      this.sim.engine.setDiversion({ from: action.de, to: action.para, fraction: action.p })
      return true
    }
    const ok = this.sim.engine.setNextGreen(action.intersecao, action.verdeS)
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

  /** One aggregated notice per window to the drivers' map app (simulated channel, AD-026). */
  private notify(now: number): void {
    const total = this.sim.engine.getState().divertedTotal
    const diverted = total - this.lastDiverted
    this.lastDiverted = total
    const d = this.sim.engine.getState().diversion
    if (diverted <= 0 || !d) return
    this.notified += diverted
    const msg = {
      ts: now,
      canal: NOTIFICATION_CHANNEL,
      de: d.from,
      para: d.to,
      quantidade: diverted,
      mensagem: `Trânsito lento na ${name(d.from)}: siga pela ${name(d.to)}.`,
    }
    this.transport.publish(NOTIFICATIONS_TOPIC, JSON.stringify(msg), { qos: 0, retain: false })
  }
}
