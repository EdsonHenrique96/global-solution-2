import { useEffect, useState } from 'react'
import { APP_LABELS, APP_NAMES } from '../apps/apps'
import { APPS_TOPIC, type ActiveApps } from '../apps/AppFleet'
import { NOTIFICATIONS_FILTER, RECENT_SIZE, type DriverNotification } from '../apps/AppNotifier'
import type { DiversionState } from '../decision/DiversionController'
import { pathStreets, segmentName } from '../sensors/segments'
import type { AppName } from '../sim/types'
import type { TelemetryTransport } from '../telemetry/transport'

interface Props {
  transport: TelemetryTransport
  diversion: DiversionState
}

const empty = () => Object.fromEntries(APP_NAMES.map((a) => [a, 0])) as Record<AppName, number>

/**
 * The drivers' map apps, as the broker shows them (AD-034, AD-036): drivers with an app open per
 * app, notices sent to each app, and the last 10 notices. Only aggregates and anonymous sessions.
 */
export function AppPanel({ transport, diversion }: Props) {
  const [active, setActive] = useState<ActiveApps | null>(null)
  const [sent, setSent] = useState<Record<AppName, number>>(empty)
  const [recent, setRecent] = useState<DriverNotification[]>([])

  useEffect(() => {
    const offApps = transport.subscribe(APPS_TOPIC, (_t, payload) => {
      try {
        setActive(JSON.parse(payload) as ActiveApps)
      } catch {
        // a malformed message is ignored
      }
    })
    const offNotices = transport.subscribe(NOTIFICATIONS_FILTER, (_t, payload) => {
      try {
        const n = JSON.parse(payload) as DriverNotification
        if (!APP_NAMES.includes(n.app)) return
        setSent((prev) => ({ ...prev, [n.app]: prev[n.app] + 1 }))
        setRecent((prev) => [n, ...prev].slice(0, RECENT_SIZE))
      } catch {
        // a malformed message is ignored
      }
    })
    return () => {
      offApps()
      offNotices()
    }
  }, [transport])

  const totalSent = APP_NAMES.reduce((n, a) => n + sent[a], 0)
  return (
    <section className="apps" aria-label="Apps de mapa">
      <h2>Apps de mapa dos motoristas</h2>
      {transport.status() === 'disconnected' && !active && <p className="empty">Sem broker: nada recebido dos apps.</p>}
      <table>
        <thead>
          <tr>
            <th>App</th>
            <th>Ativos</th>
            <th>Notificações</th>
          </tr>
        </thead>
        <tbody>
          {APP_NAMES.map((a) => (
            <tr key={a}>
              <td>{APP_LABELS[a]}</td>
              <td data-testid={`apps-ativos-${a}`}>{active ? active.porApp[a] : '—'}</td>
              <td data-testid={`apps-enviadas-${a}`}>{sent[a]}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Total</td>
            <td data-testid="apps-ativos-total">{active ? active.total : '—'}</td>
            <td data-testid="apps-enviadas-total">{totalSent}</td>
          </tr>
        </tbody>
      </table>
      {diversion.status === 'ativo' && (
        <p className="reach" data-testid="apps-sem-alcance">
          Sem app em {segmentName(diversion.trecho)}: {diversion.semAlcance ?? '—'} motoristas sem alcance
        </p>
      )}
      <h3>Últimas notificações</h3>
      {recent.length === 0 ? (
        <p className="empty">Nenhuma notificação ainda.</p>
      ) : (
        <ol className="notices">
          {recent.map((n, i) => (
            <li key={`${n.motorista}-${n.ts}-${i}`} data-testid="apps-notificacao">
              <strong>{APP_LABELS[n.app]}</strong> · evitar {segmentName(n.trechoEvitado)} · por {pathStreets(n.rotaSugerida).join(' → ')}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
