import { pathStreets, segmentName } from '../sensors/segments'
import { mulberry32 } from '../sim/random'
import type { AppName } from '../sim/types'
import type { TelemetryTransport } from '../telemetry/transport'
import { APP_NAMES } from './apps'

export const NOTIFICATIONS_FILTER = 'transito/notificacoes/+'
export const notificationTopic = (app: AppName) => `transito/notificacoes/${app}`
export const RECENT_SIZE = 10

/** One route-change notice to a driver's map app (door 4). */
export interface DriverNotification {
  ts: number
  app: AppName
  /** Anonymous id of the app session - never the car. */
  motorista: string
  trechoEvitado: string
  rotaSugerida: string[]
  ganhoS: number
  mensagem: string
}

/**
 * One adapter per map app (simulated, AD-036): each notice goes to the topic of the app the driver
 * uses. The real integrations (Waze, Google Maps) are out of the MVP (AD-026).
 */
export class AppNotifier {
  private readonly transport: TelemetryTransport
  private readonly sessions = new Map<number, string>()
  private readonly rng = mulberry32(7_340_033)
  private readonly recentList: DriverNotification[] = []
  readonly porApp: Record<AppName, number> = Object.fromEntries(APP_NAMES.map((a) => [a, 0])) as Record<AppName, number>
  total = 0

  constructor(transport: TelemetryTransport) {
    this.transport = transport
  }

  /** The app session's anonymous id: random, stable per driver, unrelated to the car id. */
  private session(carId: number): string {
    let id = this.sessions.get(carId)
    if (!id) {
      id = `sessao-${Math.floor(this.rng() * 0xffffffff).toString(16).padStart(8, '0')}`
      this.sessions.set(carId, id)
    }
    return id
  }

  send(carId: number, app: AppName, trechoEvitado: string, rotaSugerida: readonly string[], ganhoS: number, ts: number): DriverNotification {
    const n: DriverNotification = {
      ts,
      app,
      motorista: this.session(carId),
      trechoEvitado,
      rotaSugerida: [...rotaSugerida],
      ganhoS: Math.round(ganhoS),
      mensagem: `Trânsito lento em ${segmentName(trechoEvitado)}. Siga por ${pathStreets(rotaSugerida).join(', ')} e ganhe ${Math.round(ganhoS)} s.`,
    }
    this.total += 1
    this.porApp[app] += 1
    this.recentList.unshift(n)
    if (this.recentList.length > RECENT_SIZE) this.recentList.pop()
    this.transport.publish(notificationTopic(app), JSON.stringify(n), { qos: 0, retain: false })
    return n
  }

  /** The last 10 notices, newest first. */
  recent(): DriverNotification[] {
    return [...this.recentList]
  }
}
