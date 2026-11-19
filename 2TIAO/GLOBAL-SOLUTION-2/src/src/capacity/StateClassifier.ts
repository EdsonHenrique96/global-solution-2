import { ruleClassifier, type ClassifierInput, type Nivel, type SegmentClassifier } from './SegmentClassifier'

export type NivelKMeans = Extract<Nivel, 'livre' | 'moderado' | 'intenso' | 'critico'>

/** Door 7: the frozen K-means of the ML service; `centro` is in the standardized space. */
export interface KMeansModel {
  versao: string
  variaveis: string[]
  media: number[]
  desvio: number[]
  centroides: { nivel: NivelKMeans; centro: number[] }[]
  concordanciaRegraPct: number
}

export const KMEANS_VARIAVEIS = ['velocidade_kmh', 'fluxo_veic_min', 'densidade_veic_km'] as const
/** A segment without a pair speed is an empty road (door 7). */
export const VELOCIDADE_VAZIA_KMH = 50
const NIVEIS_KMEANS: readonly NivelKMeans[] = ['livre', 'moderado', 'intenso', 'critico']

/** Whether a payload is a door 7 model this classifier can use. */
export function isKMeansModel(m: unknown): m is KMeansModel {
  if (!m || typeof m !== 'object') return false
  const k = m as Partial<KMeansModel>
  const three = (xs: unknown) => Array.isArray(xs) && xs.length === 3 && xs.every((x) => typeof x === 'number' && Number.isFinite(x))
  return (
    typeof k.versao === 'string' &&
    JSON.stringify(k.variaveis) === JSON.stringify(KMEANS_VARIAVEIS) &&
    three(k.media) &&
    three(k.desvio) &&
    (k.desvio as number[]).every((s) => s > 0) &&
    Array.isArray(k.centroides) &&
    k.centroides.length === 4 &&
    k.centroides.every((c) => NIVEIS_KMEANS.includes(c?.nivel) && three(c?.centro)) &&
    typeof k.concordanciaRegraPct === 'number'
  )
}

/** A centroid in real units: km/h, cars/min, veh/km. */
export function centroidUnits(m: KMeansModel, centro: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((i) => centro[i] * m.desvio[i] + m.media[i]) as [number, number, number]
}

/**
 * The unified congestion state (AD-074) behind the V1 interface (AD-082): each segment with a pair
 * gets the level of the nearest K-means centroid in the standardized space of door 7; on a tie,
 * the slower centroid (the graver level). Until the model loads - or without it - the V1 rule.
 */
export class StateClassifier implements SegmentClassifier {
  model: KMeansModel | null = null

  get nome(): string {
    return this.model ? `K-means k = 4 (${this.model.versao})` : ruleClassifier.nome
  }

  /** Takes the model when it is a door 7 one; returns whether it did. */
  use(model: unknown): boolean {
    if (!isKMeansModel(model)) return false
    this.model = model
    return true
  }

  /** Loads the model from the service; false (and the rule) when it fails. */
  async load(fetchModel: () => Promise<unknown>): Promise<boolean> {
    try {
      return this.use(await fetchModel())
    } catch {
      return false
    }
  }

  classify(input: ClassifierInput): Exclude<Nivel, 'sem dado'> {
    const m = this.model
    if (!m || input.fluxo === null || input.densidade === null) return ruleClassifier.classify(input)
    const x = [input.velocidade ?? VELOCIDADE_VAZIA_KMH, input.fluxo / 60, input.densidade]
    const z = x.map((v, i) => (v - m.media[i]) / m.desvio[i])
    let best: { nivel: NivelKMeans; d: number; v: number } | null = null
    for (const c of m.centroides) {
      const d = c.centro.reduce((sum, ci, i) => sum + (ci - z[i]) ** 2, 0)
      const v = centroidUnits(m, c.centro)[0]
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && v < best.v)) best = { nivel: c.nivel, d, v }
    }
    return best!.nivel
  }
}
