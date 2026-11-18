import { useEffect, useState } from 'react'
import type { Reading } from '../sensors/reader'
import { TELEMETRY_FILTER } from '../telemetry/TelemetryPublisher'
import type { ConnectionStatus, TelemetryTransport } from '../telemetry/transport'

const LOG_SIZE = 20

interface Props {
  transport: TelemetryTransport
  sensorIds: readonly string[]
}

interface LogEntry {
  key: number
  topic: string
  payload: string
}

/** Shows only what comes back through the broker subscription (AD-002). */
export function TelemetryPanel({ transport, sensorIds }: Props) {
  const [status, setStatus] = useState<ConnectionStatus>(() => transport.status())
  const [latest, setLatest] = useState<Record<string, Reading>>({})
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    let seq = 0
    const offStatus = transport.onStatus(setStatus)
    const offMessages = transport.subscribe(TELEMETRY_FILTER, (topic, payload) => {
      setLog((prev) => [{ key: seq++, topic, payload }, ...prev].slice(0, LOG_SIZE))
      try {
        const reading = JSON.parse(payload) as Reading
        if (typeof reading.sensorId === 'string') {
          setLatest((prev) => ({ ...prev, [reading.sensorId]: reading }))
        }
      } catch {
        // a malformed payload still shows in the log, it just updates no sensor
      }
    })
    return () => {
      offStatus()
      offMessages()
    }
  }, [transport])

  const ids = [...new Set([...sensorIds, ...Object.keys(latest)])].sort()

  return (
    <aside className="telemetry" aria-label="Telemetria dos sensores">
      <h2>Telemetria</h2>
      <p className={`mqtt-status ${status}`} role="status">
        {status === 'connected' ? 'MQTT conectado' : 'MQTT desconectado — tentando reconectar'}
      </p>
      <table className="readings">
        <thead>
          <tr>
            <th scope="col">Sensor</th>
            <th scope="col">Carros</th>
            <th scope="col">Vel. média (km/h)</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const r = latest[id]
            return (
              <tr key={id}>
                <th scope="row">{id}</th>
                <td data-testid={`sensor-${id}-contagem`}>{r ? r.contagem : '—'}</td>
                <td data-testid={`sensor-${id}-velocidade`}>
                  {r && r.velocidadeMediaKmh !== null ? r.velocidadeMediaKmh : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h3>Mensagens</h3>
      {log.length === 0 ? (
        <p className="empty">Nenhuma mensagem recebida.</p>
      ) : (
        <ol className="telemetry-log">
          {log.map((m) => (
            <li key={m.key} data-testid="telemetry-log-entry">
              <code className="topic">{m.topic}</code>
              <code className="payload">{m.payload}</code>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
