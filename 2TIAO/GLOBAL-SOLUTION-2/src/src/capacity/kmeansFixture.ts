import type { KMeansModel, NivelKMeans } from './StateClassifier'

/** Centroids in real units (km/h, cars/min, veh/km), slowest last, as the ML service orders them. */
export const REAL_CENTROIDS: Record<NivelKMeans, [number, number, number]> = {
  livre: [45, 3, 8],
  moderado: [35, 7, 20],
  intenso: [25, 10, 35],
  critico: [12, 6, 70],
}

const MEDIA = [30, 5, 20]
const DESVIO = [10, 4, 15]

/** A door 7 model with the centroids above, for tests. */
export function kmeansFixture(concordanciaRegraPct = 87): KMeansModel {
  return {
    versao: 'v2-teste',
    variaveis: ['velocidade_kmh', 'fluxo_veic_min', 'densidade_veic_km'],
    media: [...MEDIA],
    desvio: [...DESVIO],
    centroides: (['livre', 'moderado', 'intenso', 'critico'] as const).map((nivel) => ({
      nivel,
      centro: REAL_CENTROIDS[nivel].map((v, i) => (v - MEDIA[i]) / DESVIO[i]),
    })),
    concordanciaRegraPct,
  }
}
