// @vitest-environment node
import mqtt from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { CapacityService } from '../capacity/CapacityService'
import { monitoredSegments, PlateMatcher } from '../fusion/PlateMatcher'
import { CAMERA_STATUS_FILTER, EVENTS_FILTER, wirePlateCameras } from '../sensors/PlateCamera'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { createMqttTransport, type MqttTransport } from '../telemetry/MqttTransport'

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
    it('an external subscriber receives the plate events and camera status through Mosquitto', async () => {
      const external = mqtt.connect(BROKER_TCP, { reconnectPeriod: 0 })
      open.push({ close: () => external.end(true) })
      const received: { topic: string; payload: Record<string, unknown> }[] = []
      external.on('message', (topic, buf) => received.push({ topic, payload: JSON.parse(buf.toString()) }))
      await new Promise<void>((resolve, reject) => {
        external.once('connect', () => external.subscribe([EVENTS_FILTER, CAMERA_STATUS_FILTER], (err) => (err ? reject(err) : resolve())))
        external.once('error', reject)
      })

      const transport: MqttTransport = createMqttTransport(BROKER_WS)
      open.push(transport)
      await waitFor(() => transport.status() === 'connected', 5000)

      const engine = new SimulationEngine({ ratePerMinute: 60 })
      wirePlateCameras(engine, transport)
      for (let t = 0; t < 30_000; t += TICK_MS) engine.tick(TICK_MS)

      await waitFor(() => received.filter((m) => m.topic.endsWith('/status')).length >= 72, 5000)
      const events = received.filter((m) => m.topic.endsWith('/eventos'))
      expect(events.length).toBeGreaterThan(0)
      for (const { topic, payload } of events) {
        expect(topic).toBe(`transito/vias/${payload.trecho}/eventos`)
        expect(Object.keys(payload).sort()).toEqual(['cameraId', 'classe', 'faixa', 'papel', 'placaHash', 'trecho', 'ts'])
        expect(payload.placaHash).toMatch(/^[0-9a-f]{16}$/)
      }
    })

    it('the capacity service learns per segment from the metrics received through Mosquitto', async () => {
      const publisherSide = createMqttTransport(BROKER_WS)
      const modelSide = createMqttTransport(BROKER_WS)
      open.push(publisherSide, modelSide)
      await waitFor(() => publisherSide.status() === 'connected' && modelSide.status() === 'connected', 5000)

      const engine = new SimulationEngine({ ratePerMinute: 120 })
      const now = () => engine.getState().timeMs
      const service = new CapacityService(modelSide, now)
      const matcher = new PlateMatcher(modelSide, now, monitoredSegments(engine.getState().cameras))
      service.start()
      matcher.start()
      open.push({ close: () => service.stop() }, { close: () => matcher.stop() })
      // let the subscriptions reach the broker before anything is published
      await new Promise((r) => setTimeout(r, 300))
      wirePlateCameras(engine, publisherSide)

      // 3 simulated minutes, a little real time per second so the events come back in between
      for (let t = 0; t < 180_000; t += TICK_MS) {
        engine.tick(TICK_MS)
        matcher.tick()
        if (t % 1_000 === 0) await new Promise((r) => setTimeout(r, 2))
      }
      await waitFor(() => service.snapshot()['I12>I13'].amostras.length > 0, 5000)
      const fused = service.fusion.state()['I12>I13']
      expect(fused.fontes.length === 0 || fused.fontes.join() === 'C02E,C02S').toBe(true)
      for (const s of service.snapshot()['I12>I13'].amostras) {
        expect(s.k).toBeGreaterThanOrEqual(0)
        expect(s.q).toBeGreaterThanOrEqual(0)
      }
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
        transport.publish('transito/vias/I11>I12/eventos', '{}', { qos: 0, retain: false }),
      ).not.toThrow()
    })
  })
})
