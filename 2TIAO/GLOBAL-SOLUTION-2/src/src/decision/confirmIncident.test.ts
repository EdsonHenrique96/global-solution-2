import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATIONS_FILTER } from '../apps/AppNotifier'
import { anomalyTopic } from '../fusion/PlateMatcher'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { topicMatches } from '../telemetry/transport'
import { answerJob, workerRunner, type FractionRunner, type WorkerLike, type WorkerReply, type WorkerRequest } from './fractionRunner'
import { FRACOES, fractionJob, rerouterSpeed, runFractionJob, type DiversionSimulation } from './simulateDiversion'
import { Simulation } from './Simulation'

const JAMMED = 'I12>I13'

const table = (trecho: string, escolhida: number): DiversionSimulation => ({
  trecho,
  horizonteMin: 10,
  fracoes: FRACOES.map((fracao) => ({ fracao, ocupacaoMaxTrecho: fracao >= escolhida ? 80 : 120, ocupacaoMaxAlternativa: 40, tempoMedioS: 90, co2Kg: 2 })),
  escolhida,
  eficaz: true,
})

/** 10 app drivers waiting before the block; the fractions come from `runner`. */
function setup(runner: FractionRunner) {
  const transport = new FakeTransport(true)
  const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0, cameras: [] }), transport, fractionRunner: runner })
  sim.start()
  for (let i = 0; i < 10; i++) sim.engine.addCar({ path: ['I11>I12', JAMMED, 'I13>I14'], distance: 5 + i * 8, velocity: 0, app: 'waze' })
  const warn = (ativo: boolean) =>
    transport.deliver(anomalyTopic(JAMMED), JSON.stringify({ trecho: JAMMED, ts: sim.engine.getState().timeMs, ativo, atrasados: 4, fracao: 1 }))
  const advance = (ms: number) => {
    const end = sim.engine.getState().timeMs + ms
    while (sim.engine.getState().timeMs < end) {
      sim.tick()
      // the segment's cameras keep reporting (a crawl): its reading is never stale
      const now = sim.engine.getState().timeMs
      if (now % 10_000 === 0) deliverMetrics(transport, JAMMED, now, { k: 60, v: 4, ocupacao: 9 })
    }
  }
  const notices = () => transport.published.filter((m) => topicMatches(NOTIFICATIONS_FILTER, m.topic))
  return { sim, transport, warn, advance, notices }
}

describe('confirm, then divert (AD-104)', () => {
  it('C45 the warning computes the fractions and applies nothing; the confirmation applies them', () => {
    const run = vi.fn((_sim: Simulation, trecho: string) => table(trecho, 0.2))
    const { sim, warn, advance, notices } = setup({ run })
    advance(5_000)
    // no warning: nothing to confirm
    expect(sim.confirmIncident(JAMMED)).toBe(false)
    warn(true)
    advance(TICK_MS)
    expect(sim.capacity.fusion.state()[JAMMED].possivelIncidente).toBe(true)
    // in the routes the segment in verification crawls at 2 km/h, not 40
    expect(rerouterSpeed(sim.capacity.fusion.state()[JAMMED])).toBe(2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toBe(JAMMED)
    advance(30_000)
    // still "Em verificação": no diversion, nobody told, no second computation
    expect(sim.readings()[JAMMED].exibido).toBe('verificacao')
    expect(sim.diversion.status).toBe('inativo')
    expect(notices()).toHaveLength(0)
    expect(run).toHaveBeenCalledTimes(1)
    // the operator confirms: Crítico now, the diversion leaves with the fraction computed at the warning
    expect(sim.confirmIncident(JAMMED)).toBe(true)
    expect(sim.isConfirmed(JAMMED)).toBe(true)
    expect(sim.readings()[JAMMED].exibido).toBe('critico')
    expect(sim.diversion).toMatchObject({ status: 'ativo', trecho: JAMMED, p: 0.2, calculando: false })
    expect(notices().length).toBeGreaterThan(0)
    expect(run).toHaveBeenCalledTimes(1)
    // the warning closes: the confirmation ends with it
    warn(false)
    advance(TICK_MS)
    expect(sim.isConfirmed(JAMMED)).toBe(false)
    expect(sim.confirmIncident(JAMMED)).toBe(false)
  })

  it('C46 a warning that closes unconfirmed discards its computation', async () => {
    let answer!: (r: DiversionSimulation) => void
    const run = vi.fn(() => new Promise<DiversionSimulation>((resolve) => (answer = resolve)))
    const { sim, warn, advance } = setup({ run })
    advance(5_000)
    warn(true)
    advance(TICK_MS)
    warn(false)
    advance(TICK_MS)
    answer(table(JAMMED, 0.3))
    await Promise.resolve()
    expect(sim.simulations).toHaveLength(0)
    // a new warning computes again
    warn(true)
    advance(TICK_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('fractions off the tick (AD-103)', () => {
  it('C47 the tick goes on while the fractions compute; the diversion is sized when they arrive', async () => {
    let answer!: (r: DiversionSimulation) => void
    const run = vi.fn(() => new Promise<DiversionSimulation>((resolve) => (answer = resolve)))
    const { sim, warn, advance, notices } = setup({ run })
    advance(5_000)
    warn(true)
    advance(10_000)
    expect(sim.diversion.status).toBe('inativo')
    expect(sim.confirmIncident(JAMMED)).toBe(true)
    // Crítico, but the fractions have not answered: "calculando", nobody told
    expect(sim.diversion).toMatchObject({ status: 'ativo', trecho: JAMMED, calculando: true, notificados: 0 })
    const t = sim.engine.getState().timeMs
    advance(5_000)
    expect(sim.engine.getState().timeMs).toBe(t + 5_000)
    expect(notices()).toHaveLength(0)
    answer(table(JAMMED, 0.2))
    await Promise.resolve()
    // applied at the first recompute after the answer
    advance(10_000)
    expect(sim.diversion).toMatchObject({ status: 'ativo', p: 0.2, calculando: false })
    expect(sim.diversion.status === 'ativo' && sim.diversion.simulacao?.escolhida).toBe(0.2)
    expect(notices().length).toBeGreaterThan(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('C48 the worker gets the job as plain data and answers what this thread would', async () => {
    const posted: WorkerRequest[] = []
    const fake: WorkerLike = { postMessage: (m) => posted.push(structuredClone(m)), onmessage: null, onerror: null }
    const runner = workerRunner(() => fake)
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 75, seed: 1001, cameras: [] }), transport: new FakeTransport(true) })
    sim.start()
    for (let t = 0; t < 30_000; t += TICK_MS) sim.tick()
    const answer = runner.run(sim, JAMMED)
    expect(answer).toBeInstanceOf(Promise)
    expect(posted).toHaveLength(1)
    // the job survives a structured clone (the worker boundary) and gives the same table
    const reply = answerJob(posted[0])
    expect(reply).toEqual({ id: posted[0].id, result: runFractionJob(fractionJob(sim, JAMMED)) })
    fake.onmessage!({ data: reply } as MessageEvent<WorkerReply>)
    await expect(answer).resolves.toEqual((reply as { result: DiversionSimulation }).result)
    // a failed worker rejects what is pending
    const pending = runner.run(sim, JAMMED)
    fake.onerror!(new Error('x'))
    await expect(pending).rejects.toThrow('worker de frações falhou')
    // an error inside the job comes back as an error
    expect(answerJob({ id: 9, job: { ...posted[0].job, engine: null as never } })).toMatchObject({ id: 9, error: expect.any(String) })
  }, 60_000)

  it('C49 without Worker support it runs in this thread', () => {
    expect(typeof Worker).toBe('undefined')
    const runner = workerRunner()
    const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0, cameras: [] }), transport: new FakeTransport(true) })
    expect(runner.run(sim, JAMMED)).not.toBeInstanceOf(Promise)
  })
})
