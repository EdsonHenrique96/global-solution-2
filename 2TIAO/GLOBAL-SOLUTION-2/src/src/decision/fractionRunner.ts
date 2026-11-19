import { fractionJob, runFractionJob, simulateDiversion, type DiversionSimulation, type FractionJob } from './simulateDiversion'
import type { Simulation } from './Simulation'

/**
 * Where the fraction simulation runs (AD-103). A synchronous answer is applied in the same
 * recompute (experiments, tests); a promise is applied in the first recompute after it arrives,
 * while the tick and the panel keep going (the page, in a Web Worker).
 */
export interface FractionRunner {
  run(sim: Simulation, trecho: string): DiversionSimulation | Promise<DiversionSimulation>
}

/** In this thread, synchronously. */
export const inThreadRunner = (simulate: (sim: Simulation, trecho: string) => DiversionSimulation = simulateDiversion): FractionRunner => ({
  run: (sim, trecho) => simulate(sim, trecho),
})

/** What the page and its worker say to each other. */
export type WorkerRequest = { id: number; job: FractionJob }
export type WorkerReply = { id: number; result: DiversionSimulation } | { id: number; error: string }

/** The part of a Worker the runner uses (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null
  onerror: ((e: unknown) => void) | null
}

const defaultWorker = (): WorkerLike => new Worker(new URL('./fractionWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike

/**
 * In a Web Worker: the job (the engine as plain data, the panel's speeds and capacities) is posted
 * and the answer comes back as a promise. Without Worker support (jsdom, Node) it runs in this thread.
 */
export function workerRunner(makeWorker: (() => WorkerLike) | null = typeof Worker === 'undefined' ? null : defaultWorker): FractionRunner {
  if (!makeWorker) return inThreadRunner()
  let worker: WorkerLike | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (r: DiversionSimulation) => void; reject: (e: Error) => void }>()
  const failAll = (why: string) => {
    for (const p of pending.values()) p.reject(new Error(why))
    pending.clear()
    worker = null
  }
  return {
    run(sim, trecho) {
      if (!worker) {
        worker = makeWorker()
        worker.onmessage = (e) => {
          const reply = e.data
          const p = pending.get(reply.id)
          if (!p) return
          pending.delete(reply.id)
          if ('result' in reply) p.resolve(reply.result)
          else p.reject(new Error(reply.error))
        }
        worker.onerror = () => failAll('worker de frações falhou')
      }
      const id = ++seq
      const answer = new Promise<DiversionSimulation>((resolve, reject) => pending.set(id, { resolve, reject }))
      worker.postMessage({ id, job: fractionJob(sim, trecho) })
      return answer
    },
  }
}

/** The worker's side: runs each job it receives. */
export function answerJob(request: WorkerRequest): WorkerReply {
  try {
    return { id: request.id, result: runFractionJob(request.job) }
  } catch (e) {
    return { id: request.id, error: e instanceof Error ? e.message : String(e) }
  }
}
