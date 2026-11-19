import type { Prever, PrevisaoSaida } from './ForecastClient'

/** What the panel asks the ML service (door 1): the forecast (door 2) and the K-means (door 7). */
export interface MlClient {
  prever: Prever
  kmeans: () => Promise<unknown>
}

export const ML_TIMEOUT_MS = 5_000

/** The service through the Vite proxy (`/ml` -> 127.0.0.1:8788); any non-2xx answer is a failure. */
export function httpMl(base = '/ml', fetchFn: typeof fetch = (...args) => fetch(...args)): MlClient {
  const json = async (r: Response) => {
    if (!r.ok) throw new Error(`ml ${r.status}`)
    return r.json() as Promise<unknown>
  }
  return {
    prever: (body) =>
      fetchFn(`${base}/prever`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ML_TIMEOUT_MS),
      }).then(json) as Promise<PrevisaoSaida>,
    kmeans: () => fetchFn(`${base}/kmeans`, { signal: AbortSignal.timeout(ML_TIMEOUT_MS) }).then(json),
  }
}
