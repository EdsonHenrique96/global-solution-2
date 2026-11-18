import { positionOnRoute } from '../sim/car'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type { TelemetryTransport } from '../telemetry/transport'

export const ALERTS_TOPIC = 'transito/alertas'

/** An incident reported to the central (door 1 of fusao-trechos). */
export interface Alert {
  id: number
  tipo: 'acidente'
  x: number
  y: number
  ts: number
  fonte: 'operador'
  ativo: boolean
}

/** Publishes an accident alert when the operator blocks a road, and its end when it clears. */
export function wireAlerts(engine: SimulationEngine, transport: TelemetryTransport): () => void {
  return engine.onBlockage(({ blockage, ativo, ts }) => {
    const route = engine.getState().network.routes.find((r) => r.id === blockage.routeId)
    if (!route) return
    const p = positionOnRoute(route, blockage.distance)
    const alert: Alert = { id: blockage.id, tipo: 'acidente', x: p.x, y: p.y, ts, fonte: 'operador', ativo }
    transport.publish(ALERTS_TOPIC, JSON.stringify(alert), { qos: 0, retain: false })
  })
}
