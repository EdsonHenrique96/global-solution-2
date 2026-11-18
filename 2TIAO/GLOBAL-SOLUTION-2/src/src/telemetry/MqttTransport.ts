import mqtt from 'mqtt'
import { topicMatches, type ConnectionStatus, type PublishOptions, type TelemetryTransport } from './transport'

export const DEFAULT_MQTT_URL = 'ws://localhost:9001'
const RECONNECT_MS = 2000

export type MqttTransport = TelemetryTransport

/** mqtt.js over WebSocket. Reconnects every 2 s; QoS 0 messages are dropped, not queued, while offline. */
export function createMqttTransport(url: string = DEFAULT_MQTT_URL): MqttTransport {
  const client = mqtt.connect(url, {
    reconnectPeriod: RECONNECT_MS,
    connectTimeout: 5000,
    queueQoSZero: false,
  })
  let current: ConnectionStatus = 'disconnected'
  const listeners = new Set<(s: ConnectionStatus) => void>()
  const set = (s: ConnectionStatus) => {
    current = s
    for (const l of listeners) l(s)
  }
  client.on('connect', () => set('connected'))
  client.on('close', () => set('disconnected'))
  client.on('offline', () => set('disconnected'))
  // Connection errors surface as 'close'; keep them from becoming unhandled.
  client.on('error', () => {})

  return {
    status: () => current,
    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(topic: string, payload: string, options: PublishOptions) {
      if (current !== 'connected') return
      client.publish(topic, payload, options)
    },
    subscribe(filter, handler) {
      const onMessage = (topic: string, buf: Uint8Array) => {
        if (topicMatches(filter, topic)) handler(topic, new TextDecoder().decode(buf))
      }
      client.subscribe(filter, { qos: 0 })
      client.on('message', onMessage)
      return () => {
        client.off('message', onMessage)
        client.unsubscribe(filter)
      }
    },
    close() {
      listeners.clear()
      client.end(true)
    },
  }
}
