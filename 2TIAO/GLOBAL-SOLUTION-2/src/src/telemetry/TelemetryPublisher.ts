import type { SimulationEngine } from '../sim/SimulationEngine'
import type { Reading } from './DroneSensor'
import type { TelemetryTransport } from './transport'

export const TELEMETRY_FILTER = 'transito/drones/+/telemetria'
export const telemetryTopic = (droneId: string) => `transito/drones/${droneId}/telemetria`

export class TelemetryPublisher {
  private readonly transport: TelemetryTransport

  constructor(transport: TelemetryTransport) {
    this.transport = transport
  }

  publish(reading: Reading): void {
    const payload = {
      droneId: reading.droneId,
      ts: reading.ts,
      janelaS: reading.janelaS,
      contagem: reading.contagem,
      velocidadeMediaKmh: reading.velocidadeMediaKmh,
      ruidoPct: reading.ruidoPct,
      porVia: reading.porVia.map((v) => ({
        via: v.via,
        contagem: v.contagem,
        velocidadeMediaKmh: v.velocidadeMediaKmh,
        comprimentoM: v.comprimentoM,
      })),
    }
    this.transport.publish(telemetryTopic(reading.droneId), JSON.stringify(payload), { qos: 0, retain: false })
  }
}

/** Publishes every reading the engine produces. Returns the unsubscribe. */
export function wireTelemetry(engine: SimulationEngine, transport: TelemetryTransport): () => void {
  const publisher = new TelemetryPublisher(transport)
  return engine.onReading((r) => publisher.publish(r))
}
