// @vitest-environment node
import mqtt from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { CapacityService } from '../capacity/CapacityService'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { createMqttTransport, type MqttTransport } from '../telemetry/MqttTransport'
import { TELEMETRY_FILTER, wireTelemetry } from '../telemetry/TelemetryPublisher'

const BROKER_WS = process.env.VITE_MQTT_URL ?? 'ws://localhost:9001'
const BROKER_TCP = process.env.MQTT_TCP_URL ?? 'mqtt://localhost:1883'

const open: { close(): void }[] = []
afterEach(() => {
  while (open.length) open.pop()!.close()
})

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (predicate()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error('timed out'))
      else setTimeout(poll, 20)
    }
    poll()
  })
}

describe('integration', () => {
  describe('mqtt', () => {
    it('an external subscriber receives per-segment readings from the 3 cameras through Mosquitto', async () => {
      const external = mqtt.connect(BROKER_TCP, { reconnectPeriod: 0 })
      open.push({ close: () => external.end(true) })
      const received: { topic: string; payload: Record<string, unknown> }[] = []
      external.on('message', (topic, buf) => received.push({ topic, payload: JSON.parse(buf.toString()) }))
      await new Promise<void>((resolve, reject) => {
        external.once('connect', () => external.subscribe(TELEMETRY_FILTER, (err) => (err ? reject(err) : resolve())))
        external.once('error', reject)
      })

      const transport: MqttTransport = createMqttTransport(BROKER_WS)
      open.push(transport)
      await waitFor(() => transport.status() === 'connected', 5000)

      const engine = new SimulationEngine({ ratePerMinute: 60 })
      wireTelemetry(engine, transport)
      for (let t = 0; t < 10_000; t += TICK_MS) engine.tick(TICK_MS)

      await waitFor(() => received.length >= 3, 5000)
      expect(received.map((m) => m.topic).sort()).toEqual([
        'transito/sensores/C1/telemetria',
        'transito/sensores/C2/telemetria',
        'transito/sensores/C3/telemetria',
      ])
      for (const { topic, payload } of received) {
        expect(topic).toBe(`transito/sensores/${payload.sensorId}/telemetria`)
        expect(payload).toMatchObject({ tipo: 'fixo', ts: 10_000, janelaS: 10, ruidoPct: 10 })
        expect(typeof payload.contagem).toBe('number')
        const perSegment = payload.porTrecho as { trecho: string; cobertura: number }[]
        expect(perSegment.length).toBeGreaterThan(0)
        for (const t of perSegment) expect(t.cobertura).toBeGreaterThanOrEqual(0.3)
      }
      const c2 = received.find((m) => m.payload.sensorId === 'C2')!.payload.porTrecho as { trecho: string }[]
      expect(c2.map((t) => t.trecho)).toContain('central-I1-I2')
    })

    it('the capacity service learns per segment from readings received through Mosquitto', async () => {
      const publisherSide = createMqttTransport(BROKER_WS)
      const modelSide = createMqttTransport(BROKER_WS)
      open.push(publisherSide, modelSide)
      await waitFor(() => publisherSide.status() === 'connected' && modelSide.status() === 'connected', 5000)

      const engine = new SimulationEngine({ ratePerMinute: 120, noisePct: 0 })
      const service = new CapacityService(modelSide, () => engine.getState().timeMs)
      service.start()
      open.push({ close: () => service.stop() })
      // let the subscription reach the broker before anything is published
      await new Promise((r) => setTimeout(r, 300))
      wireTelemetry(engine, publisherSide)

      // 60 simulated seconds: cars reach the cameras from ~25 s on
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
      await waitFor(() => service.snapshot()['central-I1-I2'].amostras.length > 0, 5000)

      const central = service.snapshot()['central-I1-I2']
      const covered = engine.coverage.entries('central-I1-I2')[0].cobertura * 400
      const coveredM = Math.round(covered * 10) / 10
      expect(central.estado).not.toBe('sem dados')
      // a car can leave the cone before the window closes: count 0 with sampled speed is valid
      for (const s of central.amostras) {
        expect(s.k).toBeGreaterThanOrEqual(0)
        expect(s.q).toBeGreaterThanOrEqual(0)
        // density is the count over the metres C2 sees: a whole number of cars per covered km
        expect((s.k * coveredM) / 1000).toBeCloseTo(Math.round((s.k * coveredM) / 1000), 6)
      }
      expect(central.amostras.some((s) => s.k > 0)).toBe(true)
    })

    it('MqttTransport reports disconnected when the broker is unreachable', async () => {
      const transport = createMqttTransport('ws://127.0.0.1:9')
      open.push(transport)
      const statuses: string[] = []
      transport.onStatus((s) => statuses.push(s))
      expect(transport.status()).toBe('disconnected')
      await waitFor(() => statuses.includes('disconnected'), 5000)
      expect(statuses).not.toContain('connected')
      // publishing while disconnected neither throws nor queues
      expect(() =>
        transport.publish('transito/sensores/C1/telemetria', '{}', { qos: 0, retain: false }),
      ).not.toThrow()
    })
  })
})
