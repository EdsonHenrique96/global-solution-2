import { useEffect, useState } from 'react'
import { AgentRunner } from './agent/AgentRunner'
import { proxyLlm, type LlmTurn } from './agent/llm'
import { StateClassifier } from './capacity/StateClassifier'
import { httpMl, type MlClient } from './forecast/mlClient'
import { formatClock } from './sim/clock'
import type { Incident } from './decision/IncidentLog'
import { Simulation } from './decision/Simulation'
import { workerRunner } from './decision/fractionRunner'
import { AgentPanel } from './render/AgentPanel'
import { AppPanel } from './render/AppPanel'
import { CameraEventsPanel } from './render/CameraEventsPanel'
import { CameraPanel } from './render/CameraPanel'
import { CapacityPanel } from './render/CapacityPanel'
import {
  DashboardHeader,
  IncidentHistory,
  IncidentsPanel,
  MapLegend,
  MapOverlay,
  SelectedRoad,
  StatCard,
  StreetRanking,
  type Classificacao,
  type MapIncident,
  type Tab,
} from './render/Dashboard'
import { StatesPanel } from './render/StatesPanel'
import { clampView, fitTransform, gridCenter, ZOOM_STEPS, type MapView } from './render/draw'
import { ExperimentsPanel } from './render/ExperimentsPanel'
import {
  averageSpeed,
  camerasCard,
  hourAgo,
  incidentsCard,
  networkOccupancy,
  NIVEIS,
  rankStreets,
  signalsCard,
  streetRows,
  totalFlowPerMin,
  unitOnline,
  versusHourAgo,
} from './render/levels'
import { MetricsPanel } from './render/MetricsPanel'
import { SegmentTooltip } from './render/SegmentTooltip'
import { SimulationCanvas, type IncidentMode, type IncidentTarget } from './render/SimulationCanvas'
import { segmentTooltip } from './render/tooltip'
import { VolumeControl } from './render/VolumeControl'
import { METRICS_FILTER } from './fusion/PlateMatcher'
import { PAPEL_LABEL, pairOf } from './sensors/PlateCamera'
import { pointOnSegment, segmentName } from './sensors/segments'
import { SimulationEngine, TICK_MS, WORK_ZONE_KMH } from './sim/SimulationEngine'
import type { Point } from './sim/types'
import { createOfflineTransport, type TelemetryTransport } from './telemetry/transport'
import './App.css'

interface Props {
  /** Injected in tests; the page creates its own. */
  engine?: SimulationEngine
  /** The broker connection; `main.tsx` passes the MQTT one. Without it the page runs offline. */
  transport?: TelemetryTransport
  /** The model behind the agent; the page calls the local proxy by default. */
  llm?: LlmTurn
  /** The ML service (forecast and K-means); the page calls it through the Vite proxy by default. */
  ml?: MlClient
}

function agentSnapshot(agent: AgentRunner) {
  return { mode: agent.mode, log: agent.log.entries(), cards: agent.queue.pending() }
}

/** The segment shown first: Al. Santos, R. Bela Cintra → R. Haddock Lobo. */
const FIRST_SEGMENT = 'I12>I13'

/** The incidents layer's dot: a neutral light grey, so it does not read as the red "Acidente" mode. */
export const LAYER_INCIDENTS_DOT = '#C9D1DC'

const MODES: readonly { id: IncidentMode; label: string; color: string }[] = [
  { id: 'acidente', label: 'Acidente', color: NIVEIS.critico.color },
  { id: 'obra', label: 'Obra', color: NIVEIS.intenso.color },
  { id: 'semaforo', label: 'Semáforo', color: NIVEIS.moderado.color },
]

const MODE_HINTS: Record<IncidentMode, string> = {
  acidente: 'Modo acidente: clique numa via para bloquear · clique no bloqueio para liberar',
  obra: 'Modo obra: clique numa via para reduzir a velocidade a 20 km/h por 10 min',
  semaforo: 'Modo semáforo: clique numa esquina para deixá-la intermitente por 10 min',
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`
}
const seconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

function App({ engine: injectedEngine, transport: injectedTransport, llm, ml: injectedMl }: Props) {
  const [transport] = useState(() => injectedTransport ?? createOfflineTransport())
  const [ml] = useState(() => injectedMl ?? httpMl())
  // the K-means of the ML service classifies every segment once it loads; the V1 rule until then (AD-074)
  const [classifier] = useState(() => new StateClassifier())
  const [classificacao, setClassificacao] = useState<Classificacao>('carregando')
  const [sim] = useState(() => new Simulation({ engine: injectedEngine ?? new SimulationEngine(), transport, agentControl: true, classifier, prever: ml.prever, fractionRunner: workerRunner() }))
  const [agent] = useState(() => new AgentRunner({ sim, llm: llm ?? proxyLlm() }))
  const [agentView, setAgentView] = useState(() => agentSnapshot(agent))
  const { engine, capacity } = sim
  const [rate, setRate] = useState(() => engine.getRate())
  const [selectedSegment, setSelectedSegment] = useState(FIRST_SEGMENT)
  const [estimates, setEstimates] = useState(() => capacity.snapshot())
  const [fused, setFused] = useState(() => capacity.fusion.state())
  const [metrics, setMetrics] = useState(() => sim.metrics.snapshot())
  const [diversion, setDiversion] = useState(() => sim.diversion)
  const [diversionOn, setDiversionOn] = useState(() => sim.isDiversionEnabled())
  const [signalsOn, setSignalsOn] = useState(() => engine.getState().adaptiveSignals)
  const [hover, setHover] = useState<{ segmentId: string; x: number; y: number } | null>(null)
  const [connection, setConnection] = useState(() => transport.status())
  const [tab, setTab] = useState<Tab>('mapa')
  const [layers, setLayers] = useState({ density: true, cameras: true, incidents: true })
  const [mode, setMode] = useState<IncidentMode | null>(null)
  const [view, setView] = useState<MapView>(() => ({ zoom: 1, center: gridCenter(engine.getState().network) }))
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  // re-reads what the simulation keeps (history, incidents, unit presence) on every tick
  const [, setFrame] = useState(0)
  const refresh = () => setFrame((f) => f + 1)

  useEffect(() => {
    void classifier.load(ml.kmeans).then((ok) => setClassificacao(ok ? 'kmeans' : 'regra'))
  }, [classifier, ml])
  const retryKMeans = () => {
    setClassificacao('carregando')
    void classifier.load(ml.kmeans).then((ok) => setClassificacao(ok ? 'kmeans' : 'regra'))
  }

  useEffect(() => {
    sim.start()
    // a message can change an estimate between ticks; refresh on each one too
    const off = transport.subscribe(METRICS_FILTER, () => {
      setEstimates(capacity.snapshot())
      setFused(capacity.fusion.state())
    })
    const offStatus = transport.onStatus(setConnection)
    return () => {
      off()
      offStatus()
      sim.stop()
    }
  }, [sim, capacity, transport])

  useEffect(() => {
    const id = setInterval(() => {
      sim.tick()
      agent.tick()
      setEstimates(capacity.snapshot())
      setFused(capacity.fusion.state())
      setMetrics(sim.metrics.snapshot())
      setDiversion(sim.diversion)
      setAgentView(agentSnapshot(agent))
      setFrame((f) => f + 1)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [sim, engine, capacity, agent])

  const state = engine.getState()
  const now = state.timeMs
  const segById = new Map(state.segments.map((s) => [s.id, s]))
  const corners: Record<string, Point> = Object.fromEntries(state.network.intersections.map((i) => [i.id, i.position]))
  const cornerName = (id: string) => state.network.intersections.find((i) => i.id === id)?.nome ?? id
  // one level per segment, the simulation's own, for the map, the ranking, the tooltip, the selected
  // road and the decision alike (AD-082) - a confirmed incident (AD-104) or a registered accident
  // (AD-110) shows as Crítico here too
  const readings = sim.readingsFrom(estimates, fused, now)
  const readingList = Object.values(readings)
  const streets = streetRows(state.segments, readings)
  // the map shows "Em verificação" while a warning is open (AD-100); the decision reads the level
  const levelMap = Object.fromEntries(readingList.map((r) => [r.id, r.exibido]))
  const levelsNow = () => levelMap

  const changeRate = (next: number) => {
    engine.setRate(next)
    setRate(engine.getRate())
  }

  const toggleDiversion = () => {
    sim.setDiversionEnabled(!sim.isDiversionEnabled())
    setDiversionOn(sim.isDiversionEnabled())
    setDiversion(sim.diversion)
  }

  const toggleSignals = () => {
    engine.setAdaptiveSignals(!engine.getState().adaptiveSignals)
    setSignalsOn(engine.getState().adaptiveSignals)
  }

  // Incidents: where each sits on the map, what it says, who covers it.
  const placeOf = (i: Incident) => (i.intersectionId ? cornerName(i.intersectionId) : segmentName(i.segmentId!))
  const positionOf = (i: Incident): Point => {
    if (i.intersectionId) return corners[i.intersectionId]
    const s = segById.get(i.segmentId!)!
    return pointOnSegment(s, i.kind === 'colisao' && i.distance !== null ? i.distance : s.length / 2)
  }
  const detailOf = (i: Incident): string => {
    switch (i.kind) {
      case 'colisao':
        return `Bloqueio a ${Math.round(i.distance ?? 0)} m do cruzamento · libera em ${seconds((i.endsAtMs ?? now) - now)}`
      case 'obra':
        return `Velocidade reduzida a ${WORK_ZONE_KMH} km/h · até ${hhmm(i.endsAtMs ?? now)}`
      case 'semaforo':
        return `Amarelo piscante · normaliza às ${hhmm(i.endsAtMs ?? now)}`
      case 'possivel-incidente':
        return 'Anomalia: carros que entraram não saíram no tempo esperado · aguarda confirmação'
      case 'previsto':
        return `Ocupação prevista ${Math.round(i.ocupacaoPrevista ?? 0)}% da capacidade · previsto para ${formatClock(i.previstoPara ?? now)}`
      default:
        return `Desvio ativo · ${diversion.status === 'ativo' ? diversion.notificados : 0} motoristas notificados`
    }
  }
  const activeIncidents = sim.incidents.active()
  const mapIncidents: MapIncident[] = activeIncidents.map((i) => ({ incident: i, position: positionOf(i), place: placeOf(i), detail: detailOf(i) }))
  /** The first segment arriving at a corner. */
  const intoCorner = (id: string) => state.segments.find((s) => s.to === id)!.id
  const cameras = state.cameras
  const pairFor = (segmentId: string) => pairOf(cameras, segmentId)
  /** The entry camera of the incident's segment pair (of any segment at the corner), or null. */
  const unitFor = (i: Incident): string | null => {
    const ids = i.intersectionId ? state.segments.filter((s) => s.to === i.intersectionId || s.from === i.intersectionId).map((s) => s.id) : [i.segmentId!]
    return ids.map(pairFor).find((p) => p !== null)?.[0] ?? null
  }
  const endIncident = (i: Incident) => {
    if (i.refId === null) return
    if (i.kind === 'colisao') engine.removeBlockage(i.refId)
    else if (i.kind === 'obra') engine.removeWorkZone(i.refId)
    else if (i.kind === 'semaforo') engine.removeFlashing(i.refId)
    sim.refreshIncidents()
    refresh()
  }
  const addIncident = (m: IncidentMode, target: IncidentTarget) => {
    if ('intersectionId' in target) {
      if (m === 'semaforo') engine.addFlashing(target.intersectionId)
    } else if (m === 'acidente') sim.reportAccident(target.segmentId, target.distance)
    else if (m === 'obra') engine.addWorkZone(target.segmentId)
    sim.refreshIncidents()
    refresh()
  }
  const removeBlockage = (id: number) => {
    engine.removeBlockage(id)
    sim.refreshIncidents()
    refresh()
  }

  // Map view: zoom steps centred on the selected segment, dragging moves it when zoomed in.
  const zoomIndex = ZOOM_STEPS.indexOf(view.zoom as (typeof ZOOM_STEPS)[number])
  const zoomTo = (index: number) => {
    const zoom = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index))]
    const s = segById.get(selectedSegment)
    const center = s ? pointOnSegment(s, s.length / 2) : gridCenter(state.network)
    setView(clampView(state.network, { zoom, center }))
  }
  const fit = fitTransform(state.network, size.width, size.height, view)

  // Indicators.
  const lastStatus = sim.cameraLastStatus
  const units = cameras.map((c) => ({
    id: c.id,
    position: c.position,
    online: unitOnline(lastStatus[c.id], now),
    at: `${PAPEL_LABEL[c.papel]} · ${segmentName(c.trecho)}`,
  }))
  const camCard = camerasCard(
    cameras.map((c) => c.id),
    lastStatus,
    now,
  )
  const incCard = incidentsCard(activeIncidents.map((i) => i.nivel))
  const sigCard = signalsCard(state.flashing.length, state.lights.length)
  const occupancy = networkOccupancy(readingList)
  const speed = averageSpeed(readingList)
  const before = hourAgo(sim.history.network(), now)
  const travelMin = metrics.travelLastMinuteS === null ? null : metrics.travelLastMinuteS / 60
  const n = (v: number, digits = 0) => v.toLocaleString('pt-BR', { maximumFractionDigits: digits })
  const speedNote = versusHourAgo(speed, before?.avgSpeed, 'km/h')
  const travelNote = versusHourAgo(travelMin, before?.travelMin, 'min')
  const apps = sim.fleet.snapshot()
  const jammed = diversion.status === 'ativo' ? diversion.trecho : null

  const go = (t: Tab) => {
    setTab(t)
    setHover(null)
  }

  return (
    <div className="app">
      <DashboardHeader connection={connection} simTimeMs={now} pending={agentView.cards.length} active={tab} onNavigate={go} />
      <main className="dash">
        {tab === 'mapa' && (
          <>
            <section id="mapa" className="dash-main" aria-label="Mapa de tráfego">
              <div className="card map-card">
                <div className="map-head">
                  <div className="card-title">
                    <h2>Mapa ao vivo</h2>
                    <span className="muted">{mode ? MODE_HINTS[mode] : 'Clique numa via para ver os detalhes · atualizado a cada 10 s'}</span>
                  </div>
                  <div className="map-tools">
                    <span className="muted">Camadas</span>
                    <div className="toggles" role="group" aria-label="Camadas do mapa">
                      {(
                        [
                          ['density', 'Densidade', NIVEIS.intenso.color],
                          ['cameras', 'Câmeras', '#7FB5FF'],
                          // neutral: red belongs to "Acidente", which creates one
                          ['incidents', 'Incidentes', LAYER_INCIDENTS_DOT],
                        ] as const
                      ).map(([key, label, dot]) => (
                        <button key={key} type="button" aria-pressed={layers[key]} onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}>
                          <i className="dot sq" style={{ background: layers[key] ? dot : '#3A4656' }} />
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="divider" />
                    <span className="muted">Criar</span>
                    <div className="toggles" role="group" aria-label="Criar incidente">
                      {MODES.map((m) => (
                        <button key={m.id} type="button" className="mode" aria-pressed={mode === m.id} onClick={() => setMode((cur) => (cur === m.id ? null : m.id))}>
                          <i className="dot" style={{ background: m.color }} />
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <span className="divider" />
                    <button type="button" className="square" aria-label="Aproximar" disabled={zoomIndex >= ZOOM_STEPS.length - 1} onClick={() => zoomTo(zoomIndex + 1)}>
                      +
                    </button>
                    <button type="button" className="square" aria-label="Afastar" disabled={zoomIndex <= 0} onClick={() => zoomTo(zoomIndex - 1)}>
                      −
                    </button>
                  </div>
                </div>
                <div className={`map-area ${mode ? `mode-${mode}` : ''} ${view.zoom > 1 ? 'zoomed' : ''}`} data-testid="map-area" data-zoom={view.zoom}>
                  <SimulationCanvas
                    engine={engine}
                    segmentLevel={levelsNow}
                    selectedSegment={selectedSegment}
                    onSelectSegment={setSelectedSegment}
                    density={layers.density}
                    view={view}
                    onPan={setView}
                    incidentMode={mode}
                    onIncident={addIncident}
                    onRemoveBlockage={removeBlockage}
                    onHoverSegment={setHover}
                    onResize={(width, height) => setSize({ width, height })}
                  />
                  <MapOverlay
                    map={fit.map}
                    base={fitTransform(state.network, size.width, size.height)}
                    width={size.width}
                    height={size.height}
                    corners={corners}
                    streets={streets}
                    selected={selectedSegment}
                    onSelect={setSelectedSegment}
                    units={units}
                    incidents={mapIncidents}
                    nowMs={now}
                    showUnits={layers.cameras}
                    showIncidents={layers.incidents}
                  />
                  {hover && (
                    <SegmentTooltip
                      content={segmentTooltip(
                        hover.segmentId,
                        pairFor(hover.segmentId),
                        capacity.fusion.state()[hover.segmentId],
                        readings[hover.segmentId].exibido,
                        now,
                        jammed,
                      )}
                      x={hover.x}
                      y={hover.y}
                    />
                  )}
                </div>
                <MapLegend classificacao={classificacao} onRetry={retryKMeans} />
              </div>

              <div className="stat-grid auto">
                <StatCard
                  label="Tempo médio de viagem"
                  value={travelMin === null ? '—' : n(travelMin, 1)}
                  unit={travelMin === null ? undefined : 'min'}
                  note={travelNote}
                  tone={travelNote.startsWith('+') ? 'alert' : undefined}
                  testId="card-viagem"
                />
                <StatCard label="Semáforos operando" value={sigCard.value} note={sigCard.note} tone={state.flashing.length ? 'warn' : undefined} testId="card-semaforos" />
                <StatCard
                  label="Ocupação média da rede"
                  value={occupancy === null ? 'aprendendo' : `${occupancy.pct}%`}
                  note={occupancy === null ? 'capacidade em aprendizado' : `${n(occupancy.flow)} de ${n(occupancy.cap)} carros/min`}
                  testId="card-ocupacao"
                />
                <StatCard label="Motoristas notificados" value={n(sim.notifiedTotal)} note={`${n(apps.total)} com app de mapa ativo`} testId="card-notificados" />
              </div>
            </section>

            <aside className="dash-side" aria-label="Indicadores da operação">
              <div className="stat-grid two">
                <StatCard size="lg" label="Fluxo total" value={n(totalFlowPerMin(readingList))} note="carros/min nas vias monitoradas" testId="card-fluxo" />
                <StatCard
                  size="lg"
                  label="Velocidade média"
                  value={speed === null ? '—' : n(speed)}
                  unit="km/h"
                  note={speedNote}
                  tone={speedNote.startsWith('−') ? 'alert' : undefined}
                  testId="card-velocidade"
                />
                <StatCard size="lg" label="Incidentes ativos" value={incCard.value} alarm={incCard.value > 0} note={incCard.note} testId="card-incidentes" />
                <StatCard size="lg" label="Câmeras online" value={camCard.value} note={camCard.note} testId="card-cameras" />
              </div>
              <SelectedRoad
                reading={readings[selectedSegment]}
                pair={pairFor(selectedSegment)}
                forecast={sim.forecast ? { status: sim.forecast.status, previsao: sim.forecast.previsoes[selectedSegment] ?? null } : null}
                history={sim.history.of(selectedSegment)}
                nowMs={now}
                onCameras={() => go('cameras')}
                onSignals={() => go('semaforos')}
              />
              <StreetRanking rows={rankStreets(streets)} selected={selectedSegment} onSelect={setSelectedSegment} />
              <IncidentsPanel
                incidents={mapIncidents}
                nowMs={now}
                unitFor={unitFor}
                onSelect={(i) => setSelectedSegment(i.segmentId ?? intoCorner(i.intersectionId!))}
                onEnd={endIncident}
                isConfirmed={(i) => i.segmentId !== null && sim.isConfirmed(i.segmentId)}
                onConfirm={(i) => {
                  if (i.segmentId && sim.confirmIncident(i.segmentId)) refresh()
                }}
                onCamera={(unitId) => {
                  setSelectedUnit(unitId)
                  go('cameras')
                }}
                onHistory={() => {
                  go('relatorios')
                  requestAnimationFrame(() => document.getElementById('historico')?.scrollIntoView?.({ block: 'start' }))
                }}
              />
            </aside>
          </>
        )}

        <div id="cameras" className="dash-section" hidden={tab !== 'cameras'}>
          <div className="panel-grid">
            <CameraPanel cameras={cameras} lastStatus={lastStatus} nowMs={now} selected={selectedUnit} />
            <CameraEventsPanel transport={transport} />
          </div>
        </div>

        <div id="semaforos" className="dash-section" hidden={tab !== 'semaforos'}>
          <div className="panel-grid">
            <div className="card controls" role="group" aria-label="Controle da simulação">
              <div className="card-head">
                <h2>Controle da operação</h2>
              </div>
              <p className="muted">
                Carros na via: <strong data-testid="active-cars">{state.cars.length}</strong> · Gerados: <strong data-testid="spawned-total">{state.spawnedTotal}</strong>
              </p>
              <VolumeControl value={rate} onChange={changeRate} />
              <div className="toggles stack">
                <button type="button" aria-pressed={diversionOn} onClick={toggleDiversion}>
                  Desvio parcial
                </button>
                <button type="button" aria-pressed={signalsOn} onClick={toggleSignals}>
                  Controle de semáforos
                </button>
              </div>
            </div>
            <AgentPanel
              {...agentView}
              onApprove={(id) => {
                agent.approve(id)
                setAgentView(agentSnapshot(agent))
              }}
              onReject={(id) => {
                agent.reject(id)
                setAgentView(agentSnapshot(agent))
              }}
            />
            <AppPanel transport={transport} diversion={diversion} />
          </div>
        </div>

        <div id="relatorios" className="dash-section" hidden={tab !== 'relatorios'}>
          <div className="panel-grid">
            <MetricsPanel metrics={metrics} diversion={diversion} />
            <CapacityPanel
              segmentId={selectedSegment}
              estimate={estimates[selectedSegment]}
              nivel={readings[selectedSegment].exibido}
              fused={fused[selectedSegment]}
              pair={pairFor(selectedSegment)}
            />
            <StatesPanel model={classificacao === 'kmeans' ? classifier.model : null} readings={readingList.filter((r) => pairFor(r.id) !== null)} />
            <IncidentHistory incidents={sim.incidents.history()} placeOf={placeOf} />
            <ExperimentsPanel />
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
