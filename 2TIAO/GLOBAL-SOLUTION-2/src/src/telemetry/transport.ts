export type ConnectionStatus = 'connected' | 'disconnected'

export interface PublishOptions {
  qos: 0
  retain: false
}

/** What the page needs from a message broker; MQTT in the page, an in-memory fake in tests. */
export interface TelemetryTransport {
  status(): ConnectionStatus
  onStatus(listener: (status: ConnectionStatus) => void): () => void
  publish(topic: string, payload: string, options: PublishOptions): void
  subscribe(filter: string, handler: (topic: string, payload: string) => void): () => void
  close(): void
}

/** MQTT topic filter match with `+` (one level) and `#` (rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}

/** A transport that never connects: the page without a broker. */
export function createOfflineTransport(): TelemetryTransport {
  return {
    status: () => 'disconnected',
    onStatus: () => () => {},
    publish: () => {},
    subscribe: () => () => {},
    close: () => {},
  }
}
