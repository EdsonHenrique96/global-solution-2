import type { Reading } from '../sensors/reader'
import type { SimulationEngine } from '../sim/SimulationEngine'
import type { TelemetryTransport } from './transport'

export const TELEMETRY_FILTER = 'transito/sensores/+/telemetria'
export const telemetryTopic = (sensorId: string) => `transito/sensores/${sensorId}/telemetria`

export class TelemetryPublisher {
  private readonly transport: TelemetryTransport

  constructor(transport: TelemetryTransport) {
    this.transport = transport
  }

  publish(reading: Reading): void {
    const payload = {
      sensorId: reading.sensorId,
      tipo: reading.tipo,
      ts: reading.ts,
      janelaS: reading.janelaS,
      contagem: reading.contagem,
      velocidadeMediaKmh: reading.velocidadeMediaKmh,
      ruidoPct: reading.ruidoPct,
      porTrecho: reading.porTrecho.map((t) => ({
        trecho: t.trecho,
        contagem: t.contagem,
        fonteContagem: t.fonteContagem,
        velocidadeMediaKmh: t.velocidadeMediaKmh,
        fonteVelocidade: t.fonteVelocidade,
        amostrasRadar: t.amostrasRadar,
        comprimentoCobertoM: t.comprimentoCobertoM,
        cobertura: t.cobertura,
      })),
    }
    this.transport.publish(telemetryTopic(reading.sensorId), JSON.stringify(payload), { qos: 0, retain: false })
  }
}

/** Publishes every reading the engine produces. Returns the unsubscribe. */
export function wireTelemetry(engine: SimulationEngine, transport: TelemetryTransport): () => void {
  const publisher = new TelemetryPublisher(transport)
  return engine.onReading((r) => publisher.publish(r))
}
