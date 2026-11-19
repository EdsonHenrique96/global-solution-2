/**
 * `npm run dataset -- --episodios 200 --semente 1 [--saida caminho.csv]`: the training data of the
 * forecast model (door 3), written to `data/treino/metricas.csv` at the project root by default.
 * Episodes run in parallel worker threads and are written in order, so the same seed gives the
 * same file byte for byte (RNF06).
 */
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { DATASET_HEADER, rowsToCsv, runEpisode } from '../dataset/episode'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(here, '../../../data/treino/metricas.csv')

interface Args {
  episodios: number
  semente: number
  saida: string
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const episodios = Number(get('episodios') ?? 200)
  const semente = Number(get('semente') ?? 1)
  if (!Number.isInteger(episodios) || episodios < 1) throw new Error('--episodios deve ser um inteiro >= 1')
  if (!Number.isInteger(semente)) throw new Error('--semente deve ser um inteiro')
  return { episodios, semente, saida: resolve(process.cwd(), get('saida') ?? DEFAULT_OUT) }
}

async function main(): Promise<void> {
  const { episodios, semente, saida } = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(saida), { recursive: true })
  const fd = openSync(saida, 'w')
  writeSync(fd, DATASET_HEADER + '\n')
  const workers = Math.max(1, Math.min(availableParallelism(), episodios))
  const done = new Map<number, string>()
  let nextToWrite = 1
  let nextToRun = 1
  const started = Date.now()
  await new Promise<void>((finish, fail) => {
    let running = 0
    const spawn = () => {
      if (nextToRun > episodios) {
        if (running === 0) finish()
        return
      }
      const episodio = nextToRun++
      running += 1
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { semente, episodio }, execArgv: ['--import', 'tsx'] })
      w.once('message', (csv: string) => {
        done.set(episodio, csv)
        while (done.has(nextToWrite)) {
          writeSync(fd, done.get(nextToWrite)!)
          done.delete(nextToWrite)
          nextToWrite += 1
        }
      })
      w.once('error', fail)
      w.once('exit', (code) => {
        running -= 1
        if (code !== 0) return fail(new Error(`episódio ${episodio} terminou com código ${code}`))
        if (nextToWrite - 1 === episodios) process.stderr.write(`\r${episodios}/${episodios} episódios`)
        else process.stderr.write(`\r${nextToWrite - 1}/${episodios} episódios`)
        spawn()
      })
    }
    for (let i = 0; i < workers; i++) spawn()
  })
  closeSync(fd)
  process.stderr.write(`\n${saida} (${episodios} episódios, semente ${semente}, ${Math.round((Date.now() - started) / 1000)} s)\n`)
}

if (isMainThread) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
} else {
  const { semente, episodio } = workerData as { semente: number; episodio: number }
  parentPort!.postMessage(rowsToCsv(runEpisode(semente, episodio)))
}
