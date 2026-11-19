import { useEffect, useState } from 'react'
import { EVENTS_FILTER, type PlateEvent } from '../sensors/PlateCamera'
import type { ConnectionStatus, TelemetryTransport } from '../telemetry/transport'

const LOG_SIZE = 20
const HASH_SHOWN = 6

interface Props {
  transport: TelemetryTransport
}

interface Row {
  key: number
  event: PlateEvent
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Simulated time as hh:mm:ss. */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** The last plate events that came back through the broker subscription, newest first (AD-002). */
export function CameraEventsPanel({ transport }: Props) {
  const [status, setStatus] = useState<ConnectionStatus>(() => transport.status())
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    let seq = 0
    const offStatus = transport.onStatus(setStatus)
    const offEvents = transport.subscribe(EVENTS_FILTER, (_topic, payload) => {
      try {
        const event = JSON.parse(payload) as PlateEvent
        if (typeof event.cameraId !== 'string' || typeof event.placaHash !== 'string' || typeof event.ts !== 'number') return
        setRows((prev) => [{ key: seq++, event }, ...prev].slice(0, LOG_SIZE))
      } catch {
        // not an event
      }
    })
    return () => {
      offStatus()
      offEvents()
    }
  }, [transport])

  return (
    <aside className="telemetry card" aria-label="Eventos das câmeras">
      <h2>Últimos eventos</h2>
      <p className={`mqtt-status ${status}`} role="status">
        {status === 'connected' ? 'MQTT conectado' : 'MQTT desconectado — tentando reconectar'}
      </p>
      {rows.length === 0 ? (
        <p className="empty">Nenhum evento recebido.</p>
      ) : (
        <table className="readings">
          <thead>
            <tr>
              <th scope="col">Hora</th>
              <th scope="col">Câmera</th>
              <th scope="col">Trecho</th>
              <th scope="col">Placa (hash)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, event }) => (
              <tr key={key} data-testid="event-row">
                <td>{clock(event.ts)}</td>
                <td>{event.cameraId}</td>
                <td>{event.trecho}</td>
                <td>
                  <code>{event.placaHash.slice(0, HASH_SHOWN)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  )
}
