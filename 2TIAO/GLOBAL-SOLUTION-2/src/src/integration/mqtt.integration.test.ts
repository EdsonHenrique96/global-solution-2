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
    it('an external subscriber receives readings from all 3 drones through Mosquitto', async () => {
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
        'transito/drones/D1/telemetria',
        'transito/drones/D2/telemetria',
        'transito/drones/D3/telemetria',
      ])
      for (const { topic, payload } of received) {
        expect(topic).toBe(`transito/drones/${payload.droneId}/telemetria`)
        expect(payload).toMatchObject({ ts: 10_000, janelaS: 10, ruidoPct: 10 })
        expect(typeof payload.contagem).toBe('number')
      }
    })

    it('the capacity service learns from porVia readings received through Mosquitto', async () => {
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

      // 60 simulated seconds: cars reach the drones from ~25 s on
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)
      await waitFor(() => service.snapshot().central.amostras.length > 0, 5000)

      const central = service.snapshot().central
      expect(central.estado).not.toBe('sem dados')
      // a car can leave the circle before the window closes: count 0 with sampled speed is valid
      for (const s of central.amostras) {
        expect(s.k).toBeGreaterThanOrEqual(0)
        expect(s.q).toBeGreaterThanOrEqual(0)
        // density is the count over the 220 m under D2: a whole number of cars per 0.22 km
        expect((s.k * 220) / 1000).toBeCloseTo(Math.round((s.k * 220) / 1000), 6)
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
        transport.publish('transito/drones/D1/telemetria', '{}', { qos: 0, retain: false }),
      ).not.toThrow()
    })
  })
})
