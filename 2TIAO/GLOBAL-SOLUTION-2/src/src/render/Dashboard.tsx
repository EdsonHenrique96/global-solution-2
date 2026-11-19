import type { CSSProperties, ReactNode } from 'react'
import { SPEED_LIMIT_KMH } from '../capacity/CapacityModel'
import { INCIDENT_TITLES, type Incident } from '../decision/IncidentLog'
import type { HistoryPoint } from '../decision/SegmentHistory'
import type { ForecastStatus, Previsao } from '../forecast/ForecastClient'
import { formatClock } from '../sim/clock'
import { segmentName } from '../sensors/segments'
import type { Point } from '../sim/types'
import type { ConnectionStatus } from '../telemetry/transport'
import { labelRect, placeLabels, placeNotes } from './labels'
import { labelLines, NIVEIS, perMin, type SegmentReading, type StreetRow } from './levels'

export type Tab = 'mapa' | 'cameras' | 'semaforos' | 'relatorios'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'mapa', label: 'Mapa ao vivo' },
  { id: 'cameras', label: 'Câmeras' },
  { id: 'semaforos', label: 'Semáforos' },
  { id: 'relatorios', label: 'Relatórios' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Simulated time as hh:mm:ss (the run starts at 00:00:00). */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** Simulated time as hh:mm; negative times wrap to the previous day. */
function hhmm(ms: number): string {
  const day = 24 * 3_600_000
  const m = Math.floor((((ms % day) + day) % day) / 60_000)
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

interface HeaderProps {
  connection: ConnectionStatus
  simTimeMs: number
  pending: number
  active: Tab
  onNavigate: (tab: Tab) => void
}

export function DashboardHeader({ connection, simTimeMs, pending, active, onNavigate }: HeaderProps) {
  const live = connection === 'connected'
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="7" y="2" width="10" height="20" rx="3" />
            <circle cx="12" cy="7" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="17" r="1.6" />
          </svg>
        </div>
        <div className="brand-text">
          <h1>Centro de Operações de Tráfego</h1>
          <span>Região Jardins · São Paulo</span>
        </div>
      </div>
      <nav aria-label="Seções" className="tabs">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            aria-current={active === t.id ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault()
              onNavigate(t.id)
            }}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <div className="topbar-right">
        <div className={`live ${live ? 'on' : 'off'}`} title={live ? 'Broker MQTT conectado' : 'Broker MQTT desconectado'}>
          <span className="live-dot" />
          <span className="live-label">{live ? 'AO VIVO' : 'OFFLINE'}</span>
          <span className="live-clock" data-testid="sim-clock">
            {formatClock(simTimeMs)}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={pending > 0 ? `Notificações: ${pending} aguardando aprovação` : 'Notificações'}
          onClick={() => onNavigate('semaforos')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {pending > 0 && <span className="badge" data-testid="bell-dot" />}
        </button>
      </div>
    </header>
  )
}

interface StatProps {
  label: string
  value: ReactNode
  unit?: string
  note?: ReactNode
  /** Colour of the note. */
  tone?: 'ok' | 'warn' | 'alert' | 'bad'
  /** Paints the value red. */
  alarm?: boolean
  size?: 'md' | 'lg'
  testId?: string
}

export function StatCard({ label, value, unit, note, tone, alarm, size = 'md', testId }: StatProps) {
  return (
    <div className={`stat ${size}`} data-testid={testId}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${alarm ? 'tone-bad' : ''}`}>
        {value}
        {unit && <span className="stat-unit"> {unit}</span>}
      </span>
      {note && <span className={`stat-note ${tone ? `tone-${tone}` : ''}`}>{note}</span>}
    </div>
  )
}

/** Who gives each segment its level: the K-means of the ML service, or the V1 rule (AD-074). */
export type Classificacao = 'carregando' | 'kmeans' | 'regra'

interface LegendProps {
  classificacao?: Classificacao
  /** "Tentar de novo": loads the K-means again. */
  onRetry?: () => void
}

/** Below the map: the levels, who classifies them, and the camera icons. */
export function MapLegend({ classificacao = 'regra', onRetry }: LegendProps = {}) {
  const kmeans = classificacao === 'kmeans'
  return (
    <div className="map-foot">
      <div className="legend" aria-label="Legenda da densidade">
        <span className="muted">{kmeans ? 'Estado do trecho (K-means)' : 'Densidade (fluxo ÷ capacidade)'}</span>
        {(['livre', 'moderado', 'intenso', 'critico', 'aprendendo', 'sem dado', 'verificacao'] as const).map((k) => (
          <span key={k} className="legend-item">
            <span
              className={`legend-swatch ${k === 'sem dado' || k === 'verificacao' ? 'dashed' : ''}`}
              style={{ color: NIVEIS[k].color, background: k === 'sem dado' || k === 'verificacao' ? undefined : NIVEIS[k].color }}
            />
            {NIVEIS[k].label}
            {!kmeans && NIVEIS[k].range && <span className="faint">{NIVEIS[k].range}</span>}
          </span>
        ))}
        <span className="legend-item classificacao" data-testid="classificacao">
          {kmeans ? 'classificação K-means' : classificacao === 'carregando' ? 'carregando K-means…' : 'classificação por regra'}
          {classificacao === 'regra' && onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Tentar de novo
            </button>
          )}
        </span>
      </div>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-cam on" />
          Câmera online
        </span>
        <span className="legend-item">
          <span className="legend-cam off" />
          Offline
        </span>
      </div>
    </div>
  )
}

export interface MapUnit {
  id: string
  position: Point
  online: boolean
  /** Its role and segment: "entrada · Al. Santos, R. da Consolação → R. Bela Cintra". */
  at: string
}

/** An incident placed on the map. */
export interface MapIncident {
  incident: Incident
  position: Point
  place: string
  detail: string
}

interface OverlayProps {
  /** Map metres -> canvas px, the canvas's own transform. */
  map: (p: Point) => Point
  /** The same at 1×, where the street labels are laid out. */
  base: { map: (p: Point) => Point; unmap: (p: Point) => Point }
  width: number
  height: number
  corners: Record<string, Point>
  streets: readonly StreetRow[]
  selected: string
  onSelect: (segmentId: string) => void
  units: readonly MapUnit[]
  incidents: readonly MapIncident[]
  nowMs: number
  showUnits: boolean
  showIncidents: boolean
}

/** Each incident type's colour on the map and in the panel, as in the prototype; the pill still says its level. */
const KIND_COLOR: Record<Incident['kind'], string> = {
  colisao: NIVEIS.critico.color,
  obra: NIVEIS.intenso.color,
  semaforo: NIVEIS.moderado.color,
  congestionamento: NIVEIS.intenso.color,
  'possivel-incidente': NIVEIS.moderado.color,
  previsto: '#A78BFA',
}

/** Camera icon border: online, offline (AD-054). */
const UNIT_ON = '#7FB5FF'
const UNIT_OFF = '#5B6676'

const ago = (ms: number) => `há ${Math.max(0, Math.floor(ms / 60_000))} min`

/** What sits on top of the canvas: a label per street, the camera icons and the incident markers with their notes. */
export function MapOverlay({ map, base, width, height, corners, streets, selected, onSelect, units, incidents, nowMs, showUnits, showIncidents }: OverlayProps) {
  const place = (p: Point): CSSProperties => {
    const q = map(p)
    return { left: q.x, top: q.y }
  }
  const unitBoxes = (m: (p: Point) => Point) => (showUnits ? units.map((u) => ({ x: m(u.position).x - 16, y: m(u.position).y - 16, w: 32, h: 32 })) : [])
  const markersOn = (m: (p: Point) => Point) => (showIncidents ? incidents.map((i) => ({ key: i.incident.key, at: m(i.position) })) : [])
  // notes first, on the 1x view, so the labels keep clear of them and of the markers
  const baseMarkers = markersOn(base.map)
  const baseNotes = placeNotes(baseMarkers, unitBoxes(base.map), width, height)
  const spots = placeLabels(
    streets.map((s) => s.rua),
    corners,
    base,
    width,
    height,
    [
      ...Object.values(baseNotes).map((p) => ({ x: p.x, y: p.y, w: 240, h: 92 })),
      ...baseMarkers.map((m) => ({ x: m.at.x - 16, y: m.at.y - 16, w: 32, h: 32 })),
    ],
  )
  const notes = placeNotes(markersOn(map), [...streets.map((s) => labelRect(map(spots[s.rua]))), ...unitBoxes(map)], width, height)
  return (
    <div className="map-overlay">
      {streets.map(({ rua, worst }) => {
        const at = map(spots[rua])
        const l = labelLines(worst)
        const color = NIVEIS[worst.exibido].color
        const on = worst.id === selected
        return (
          <button
            key={rua}
            type="button"
            className={`street-label ${on ? 'on' : ''}`}
            data-testid={`street-${rua}`}
            aria-pressed={on}
            style={{ left: at.x, top: at.y }}
            onClick={() => onSelect(worst.id)}
          >
            <span className="street-name">
              <i className="dot" data-testid="street-dot" style={{ background: color }} />
              {rua}
            </span>
            <span className="street-flow">
              <strong data-testid="street-atual" style={{ color }}>
                {l.atual}
              </strong>{' '}
              / {l.suporta}
            </span>
            <span className="street-speed">
              Pista {SPEED_LIMIT_KMH} · Média {l.media} km/h
            </span>
          </button>
        )
      })}
      {showUnits &&
        units.map((u) => {
          const name = `${u.id} · ${u.at} · ${u.online ? 'online' : 'offline'}`
          return (
            <span
              key={u.id}
              role="img"
              aria-label={name}
              title={name}
              className={`unit-icon ${u.online ? 'on' : 'off'}`}
              style={{ ...place(u.position), borderColor: u.online ? UNIT_ON : UNIT_OFF }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 10l5-3v10l-5-3" />
                <rect x="2" y="6" width="14" height="12" rx="2" />
              </svg>
            </span>
          )
        })}
      {showIncidents &&
        incidents.map(({ incident, position, place: where, detail }) => {
          const q = map(position)
          const color = KIND_COLOR[incident.kind]
          const { x: left, y: top } = notes[incident.key]
          return (
            <div key={incident.key} className="incident-on-map" style={{ ['--sev' as string]: color }}>
              <span className="incident-marker" data-testid={`marker-${incident.key}`} style={{ left: q.x, top: q.y }} role="img" aria-label={INCIDENT_TITLES[incident.kind]}>
                !
              </span>
              <div role="note" className="incident-note" style={{ left, top }}>
                <div className="note-head">
                  <span className="note-title">{INCIDENT_TITLES[incident.kind]}</span>
                  <span className="note-ago">{ago(nowMs - incident.startMs)}</span>
                </div>
                <span className="note-place">{where}</span>
                <span className="note-detail">{detail}</span>
              </div>
            </div>
          )
        })}
    </div>
  )
}

interface IncidentsProps {
  incidents: readonly MapIncident[]
  nowMs: number
  /** The camera covering the incident, or null. */
  unitFor: (incident: Incident) => string | null
  onSelect: (incident: Incident) => void
  onEnd: (incident: Incident) => void
  onCamera: (unitId: string) => void
  onHistory: () => void
}

/** What needs the operator now, critical first then the newest. */
export function IncidentsPanel({ incidents, nowMs, unitFor, onSelect, onEnd, onCamera, onHistory }: IncidentsProps) {
  return (
    <section className="incidents card" aria-label="Incidentes">
      <div className="card-head">
        <h2>Incidentes</h2>
        <a
          href="#historico"
          className="link"
          onClick={(e) => {
            e.preventDefault()
            onHistory()
          }}
        >
          Ver histórico
        </a>
      </div>
      {incidents.length === 0 && <p className="empty">Nenhum incidente ativo.</p>}
      {incidents.map(({ incident: i, place, detail }) => {
        const unit = unitFor(i)
        return (
          <article key={i.key} className="incident" data-testid={`incident-${i.key}`} style={{ ['--sev' as string]: KIND_COLOR[i.kind] }}>
            <div className="incident-head">
              <span className="incident-title">
                <i className="dot" />
                {INCIDENT_TITLES[i.kind]}
              </span>
              <span className="pill sev">{NIVEIS[i.nivel].label}</span>
            </div>
            <span className="incident-place">
              {place} · {ago(nowMs - i.startMs)}
            </span>
            <span className="incident-detail">{detail}</span>
            <div className="incident-actions">
              <button type="button" className="btn sm" onClick={() => onSelect(i)}>
                Ver trecho
              </button>
              {(i.kind === 'colisao' || i.kind === 'obra') && (
                <button type="button" className="btn sm" onClick={() => onEnd(i)}>
                  Liberar via
                </button>
              )}
              {i.kind === 'semaforo' && (
                <button type="button" className="btn sm" onClick={() => onEnd(i)}>
                  Normalizar semáforo
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={unit === null}
                title={unit === null ? 'Nenhuma câmera cobre este local' : `${unit} cobre este local`}
                onClick={() => unit && onCamera(unit)}
              >
                Ver câmera
              </button>
            </div>
          </article>
        )
      })}
    </section>
  )
}

/** Ended incidents, newest first (Relatórios). */
export function IncidentHistory({ incidents, placeOf }: { incidents: readonly Incident[]; placeOf: (i: Incident) => string }) {
  const minutes = (ms: number) => {
    const s = Math.round(ms / 1000)
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
  }
  return (
    <section id="historico" className="card history" aria-label="Histórico de incidentes">
      <div className="card-head">
        <h2>Histórico de incidentes</h2>
        <span className="muted">{incidents.length ? `${incidents.length} encerrados` : 'nenhum encerrado'}</span>
      </div>
      {incidents.length === 0 ? (
        <p className="empty">Nenhum incidente encerrado ainda.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Local</th>
              <th>Início</th>
              <th>Duração</th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((i) => (
              <tr key={`${i.key}:${i.startMs}`} data-testid="history-row">
                <td>{INCIDENT_TITLES[i.kind]}</td>
                <td>{placeOf(i)}</td>
                <td>{clock(i.startMs)}</td>
                <td>{minutes((i.endMs ?? i.startMs) - i.startMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** "Vias mais saturadas": the 8 streets by their worst segment. */
export function StreetRanking({ rows, selected, onSelect }: { rows: readonly StreetRow[]; selected: string; onSelect: (segmentId: string) => void }) {
  return (
    <section className="ranking card" aria-label="Vias mais saturadas">
      <div className="card-head">
        <h2>Vias mais saturadas</h2>
        <span className="muted">fluxo ÷ capacidade</span>
      </div>
      {rows.map(({ rua, worst, pct }) => (
        <button
          key={rua}
          type="button"
          className={`rank-row ${worst.id === selected ? 'on' : ''}`}
          data-testid={`rank-${rua}`}
          aria-pressed={worst.id === selected}
          onClick={() => onSelect(worst.id)}
        >
          <span className="rank-name">{rua}</span>
          <span className="track" aria-hidden="true">
            <span style={{ width: `${Math.min(100, pct ?? 0)}%`, background: NIVEIS[worst.exibido].color }} />
          </span>
          <span className="rank-pct">{pct === null ? '—' : `${pct}%`}</span>
        </button>
      ))}
    </section>
  )
}

const W = 360
const FLOW_H = 150
const SPEED_H = 80
const WINDOW_MS = 2 * 3_600_000

/** The selected segment's forecast (RF16): the service's state and its last answer for the segment. */
export interface SelectedForecast {
  status: ForecastStatus
  previsao: Previsao | null
}

interface SelectedProps {
  reading: SegmentReading
  /** Null without the ML service (experiments) or for a segment without a pair. */
  forecast?: SelectedForecast | null
  /** The segment's camera pair; null when it has none (estimado). */
  pair: readonly [string, string] | null
  history: readonly HistoryPoint[]
  nowMs: number
  onCameras: () => void
  onSignals: () => void
}

/** The selected segment: level, occupancy, the pairing figures and its last 2 h (AC 35-40). */
function ForecastFacts({ forecast }: { forecast: SelectedForecast }) {
  const { status, previsao: p } = forecast
  const row = (label: string, v: number, f: number, testId: string) => (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>
        {Math.max(0, Math.round(v))} <small>km/h</small> · {Math.max(0, Math.round(f))} <small>carros/min</small>
      </dd>
    </div>
  )
  return (
    <div className="forecast" data-testid="selected-previsao">
      {status === 'indisponivel' ? (
        <p className="empty">Previsão indisponível</p>
      ) : !p ? (
        <p className="empty">Previsão aguardando 10 min de histórico</p>
      ) : (
        <dl className="facts">
          {row('Previsão 15 min', p.v15, p.f15, 'selected-previsao-15')}
          {row('Previsão 30 min', p.v30, p.f30, 'selected-previsao-30')}
        </dl>
      )}
    </div>
  )
}

export function SelectedRoad({ reading: r, pair, history, nowMs, onCameras, onSignals, forecast = null }: SelectedProps) {
  const lv = NIVEIS[r.exibido]
  const speedPct = r.velocidade === null ? null : Math.round((r.velocidade / SPEED_LIMIT_KMH) * 100)
  const speedColor = speedPct === null ? undefined : speedPct < 40 ? NIVEIS.critico.color : speedPct < 70 ? NIVEIS.moderado.color : NIVEIS.livre.color
  const from = nowMs - WINDOW_MS
  const x = (t: number) => ((t - from) / WINDOW_MS) * W
  const shown = history.filter((p) => p.t >= from)
  const flows = shown.filter((p) => p.fluxo !== null)
  const speeds = shown.filter((p) => p.velocidade !== null)
  const cap = r.capacidade === null ? null : perMin(r.capacidade)
  const maxY = Math.max(1, cap ?? 0, ...flows.map((p) => perMin(p.fluxo!))) * 1.2
  const fy = (v: number) => FLOW_H - (v / maxY) * FLOW_H
  const flowLine = flows.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${fy(perMin(p.fluxo!)).toFixed(1)}`).join(' ')
  const sMax = SPEED_LIMIT_KMH * 1.15
  const sy = (v: number) => SPEED_H - (Math.min(v, sMax) / sMax) * SPEED_H
  const speedLine = speeds.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${sy(p.velocidade!).toFixed(1)}`).join(' ')
  const lastFlow = flows.at(-1)
  const lastSpeed = speeds.at(-1)
  const empty = <p className="empty">Sem histórico ainda.</p>
  return (
    <section className="selected card" aria-label="Via selecionada">
      <div className="card-head top">
        <div className="card-title">
          <span className="eyebrow">Via selecionada</span>
          <h2 className="display" data-testid="selected-name">
            {segmentName(r.id)}
          </h2>
        </div>
        <span className="pill" data-testid="selected-level" style={{ color: lv.color, background: lv.bg }}>
          {lv.label}
        </span>
      </div>

      <div className="meter">
        <div className="meter-label">
          <span>Ocupação da capacidade</span>
          <strong data-testid="selected-pct">{r.pct === null ? (r.nivel === 'aprendendo' ? 'aprendendo' : '—') : `${r.pct}%`}</strong>
        </div>
        <div className="track big">
          <span data-testid="selected-bar" style={{ width: `${Math.min(100, r.pct ?? 0)}%`, background: lv.color }} />
        </div>
      </div>

      <dl className="facts">
        <div>
          <dt>Fluxo atual</dt>
          <dd data-testid="selected-fluxo">
            {r.fluxo === null ? '—' : perMin(r.fluxo)} <small>carros/min</small>
          </dd>
        </div>
        <div>
          <dt>Capacidade</dt>
          <dd data-testid="selected-capacidade">{cap === null ? 'aprendendo' : <>{cap} <small>carros/min</small></>}</dd>
        </div>
        <div>
          <dt>Velocidade da pista</dt>
          <dd data-testid="selected-pista">
            {SPEED_LIMIT_KMH} <small>km/h</small>
          </dd>
        </div>
        <div>
          <dt>Velocidade média (pareamento)</dt>
          <dd data-testid="selected-media" style={{ color: speedColor }}>
            {r.velocidade === null ? '—' : Math.round(r.velocidade)} <small>km/h{speedPct !== null && ` · ${speedPct}% do limite`}</small>
            {r.ultimoParEm !== null && <small data-testid="selected-ultimo-par"> · último par há {Math.max(0, Math.round((nowMs - r.ultimoParEm) / 1000))} s</small>}
          </dd>
        </div>
        <div>
          <dt>No trecho agora</dt>
          <dd data-testid="selected-ocupacao">
            {r.contagem === null ? '—' : r.contagem} <small>veíc</small>
          </dd>
        </div>
        <div>
          <dt>Densidade</dt>
          <dd data-testid="selected-densidade">
            {r.densidade === null ? '—' : r.densidade.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} <small>veíc/km</small>
          </dd>
        </div>
        <div>
          <dt>Pares no último minuto</dt>
          <dd data-testid="selected-pares">{r.pares === null ? '—' : r.pares}</dd>
        </div>
        <div>
          <dt>Câmeras do par</dt>
          <dd data-testid="selected-par">{pair ? pair.join(' · ') : 'nenhuma (estimado)'}</dd>
        </div>
      </dl>

      {pair && forecast && <ForecastFacts forecast={forecast} />}

      <div className="chart">
        <div className="chart-head">
          <span>Fluxo × capacidade · últimas 2 h</span>
          <span className="chart-legend">
            <span>
              <i className="swatch line accent" />
              Fluxo
            </span>
            <span>
              <i className="swatch dashed" />
              Capacidade
            </span>
          </span>
        </div>
        {flows.length === 0 ? (
          empty
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${FLOW_H}`} className="series" role="img" aria-label={`Fluxo de ${segmentName(r.id)} nas últimas 2 h`}>
              <line x1="0" y1={FLOW_H} x2={W} y2={FLOW_H} className="axis" />
              <line x1="0" y1={FLOW_H / 2} x2={W} y2={FLOW_H / 2} className="grid" />
              <path d={`${flowLine} L${x(lastFlow!.t).toFixed(1)},${FLOW_H} L${x(flows[0].t).toFixed(1)},${FLOW_H} Z`} className="flow-area" />
              <path d={flowLine} className="flow-line" data-testid="flow-line" />
              {cap !== null && (
                <>
                  <line x1="0" y1={fy(cap)} x2={W} y2={fy(cap)} className="limit" data-testid="capacity-line" />
                  <text x="4" y={fy(cap) - 6} className="tick">
                    {cap}/min
                  </text>
                </>
              )}
              <circle cx={x(lastFlow!.t)} cy={fy(perMin(lastFlow!.fluxo!))} r="4" className="flow-dot" />
            </svg>
            <div className="time-marks" data-testid="time-marks">
              <span>{hhmm(nowMs - WINDOW_MS)}</span>
              <span>{hhmm(nowMs - 80 * 60_000)}</span>
              <span>{hhmm(nowMs - 40 * 60_000)}</span>
              <span>agora</span>
            </div>
          </>
        )}
      </div>

      <div className="chart">
        <div className="chart-head">
          <span>Velocidade média × limite da pista</span>
          <span className="chart-legend">
            <span>
              <i className="swatch line yellow" />
              Média
            </span>
            <span>
              <i className="swatch dashed" />
              Limite
            </span>
          </span>
        </div>
        {speeds.length === 0 ? (
          empty
        ) : (
          <svg viewBox={`0 0 ${W} ${SPEED_H}`} className="series" role="img" aria-label={`Velocidade média de ${segmentName(r.id)}, limite de ${SPEED_LIMIT_KMH} km/h`}>
            <line x1="0" y1={SPEED_H} x2={W} y2={SPEED_H} className="axis" />
            <line x1="0" y1={sy(SPEED_LIMIT_KMH)} x2={W} y2={sy(SPEED_LIMIT_KMH)} className="limit" data-testid="limit-line" data-kmh={SPEED_LIMIT_KMH} />
            <path d={speedLine} className="speed-line" data-testid="speed-line" />
            <circle cx={x(lastSpeed!.t)} cy={sy(lastSpeed!.velocidade!)} r="4" className="speed-dot" />
          </svg>
        )}
      </div>

      <div className="card-actions">
        <button type="button" className="btn primary" onClick={onCameras}>
          Ver câmeras da via
        </button>
        <button type="button" className="btn" onClick={onSignals}>
          Ajustar semáforos
        </button>
      </div>
    </section>
  )
}

