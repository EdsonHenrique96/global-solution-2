import { useEffect, useState } from 'react'
import { AgentRunner } from './agent/AgentRunner'
import { proxyLlm, type LlmTurn } from './agent/llm'
import { Simulation } from './decision/Simulation'
import { AgentPanel } from './render/AgentPanel'
import { AppPanel } from './render/AppPanel'
import { CameraPanel } from './render/CameraPanel'
import { CapacityPanel } from './render/CapacityPanel'
import { ExperimentsPanel } from './render/ExperimentsPanel'
import { MetricsPanel } from './render/MetricsPanel'
import { NoiseControl } from './render/NoiseControl'
import { RoadTable } from './render/RoadTable'
import { fusedStatus } from './render/roads'
import { SegmentTooltip } from './render/SegmentTooltip'
import { SimulationCanvas } from './render/SimulationCanvas'
import { TelemetryPanel } from './render/TelemetryPanel'
import { coveringUnit, segmentTooltip } from './render/tooltip'
import { VolumeControl } from './render/VolumeControl'
import { SimulationEngine, TICK_MS } from './sim/SimulationEngine'
import { createOfflineTransport, type TelemetryTransport } from './telemetry/transport'
import { TELEMETRY_FILTER } from './telemetry/TelemetryPublisher'
import './App.css'

interface Props {
  /** Injected in tests; the page creates its own. */
  engine?: SimulationEngine
  /** The broker connection; `main.tsx` passes the MQTT one. Without it the page runs offline. */
  transport?: TelemetryTransport
  /** The model behind the agent; the page calls the local proxy by default. */
  llm?: LlmTurn
}

function agentSnapshot(agent: AgentRunner) {
  return { mode: agent.mode, log: agent.log.entries(), cards: agent.queue.pending() }
}

/** The segment shown first: Al. Santos, R. Bela Cintra → R. Haddock Lobo. */
const FIRST_SEGMENT = 'I12>I13'

function App({ engine: injectedEngine, transport: injectedTransport, llm }: Props) {
  const [transport] = useState(() => injectedTransport ?? createOfflineTransport())
  const [sim] = useState(() => new Simulation({ engine: injectedEngine ?? new SimulationEngine(), transport, agentControl: true }))
  const [agent] = useState(() => new AgentRunner({ sim, llm: llm ?? proxyLlm() }))
  const [agentView, setAgentView] = useState(() => agentSnapshot(agent))
  const { engine, capacity } = sim
  const [rate, setRate] = useState(() => engine.getRate())
  const [noise, setNoise] = useState(() => engine.getNoise())
  const [stats, setStats] = useState({ active: 0, spawned: 0 })
  const [selectedSegment, setSelectedSegment] = useState(FIRST_SEGMENT)
  const [estimates, setEstimates] = useState(() => capacity.snapshot())
  const [fused, setFused] = useState(() => capacity.fusion.state())
  const [metrics, setMetrics] = useState(() => sim.metrics.snapshot())
  const [diversion, setDiversion] = useState(() => sim.diversion)
  const [accidentMode, setAccidentMode] = useState(false)
  const [diversionOn, setDiversionOn] = useState(() => sim.isDiversionEnabled())
  const [signalsOn, setSignalsOn] = useState(() => engine.getState().adaptiveSignals)
  const [layer, setLayer] = useState<'estado' | 'cobertura'>('estado')
  const [hover, setHover] = useState<{ segmentId: string; x: number; y: number } | null>(null)
  const [cameras, setCameras] = useState(() => engine.getState().cameras.map((c) => ({ ...c })))
  const refreshCameras = () => setCameras(engine.getState().cameras.map((c) => ({ ...c })))
  const segmentIds = capacity.segments.map((s) => s.id)
  const units = Object.fromEntries(segmentIds.map((id) => [id, coveringUnit(engine.coverage.entries(id))]))
  const statusNow = () => {
    const now = engine.getState().timeMs
    const f = capacity.fusion.state()
    return Object.fromEntries(segmentIds.map((id) => [id, fusedStatus(f[id], now)]))
  }
  const status = Object.fromEntries(segmentIds.map((id) => [id, fusedStatus(fused[id], engine.getState().timeMs)]))

  useEffect(() => {
    sim.start()
    // a message can change an estimate between ticks; refresh on each one too
    const off = transport.subscribe(TELEMETRY_FILTER, () => {
      setEstimates(capacity.snapshot())
      setFused(capacity.fusion.state())
    })
    return () => {
      off()
      sim.stop()
    }
  }, [sim, capacity, transport])

  useEffect(() => {
    const id = setInterval(() => {
      sim.tick()
      agent.tick()
      const state = engine.getState()
      setStats({ active: state.cars.length, spawned: state.spawnedTotal })
      setEstimates(capacity.snapshot())
      setFused(capacity.fusion.state())
      setMetrics(sim.metrics.snapshot())
      setDiversion(sim.diversion)
      setAgentView(agentSnapshot(agent))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [sim, engine, capacity, agent])

  const changeRate = (next: number) => {
    engine.setRate(next)
    setRate(engine.getRate())
  }

  const changeNoise = (next: number) => {
    engine.setNoise(next)
    setNoise(engine.getNoise())
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

  const jammed = diversion.status === 'ativo' ? diversion.trecho : null

  return (
    <main className="app">
      <header className="toolbar">
        <h1>Central de trânsito — Jardins</h1>
        <VolumeControl value={rate} onChange={changeRate} />
        <NoiseControl value={noise} onChange={changeNoise} />
        <div className="toggles" role="group" aria-label="Camada do mapa">
          <button type="button" aria-pressed={layer === 'estado'} onClick={() => setLayer('estado')}>
            Estado
          </button>
          <button type="button" aria-pressed={layer === 'cobertura'} onClick={() => setLayer('cobertura')}>
            Cobertura
          </button>
        </div>
        <div className="toggles">
          <button type="button" aria-pressed={accidentMode} onClick={() => setAccidentMode((on) => !on)}>
            Acidente
          </button>
          <button type="button" aria-pressed={diversionOn} onClick={toggleDiversion}>
            Desvio parcial
          </button>
          <button type="button" aria-pressed={signalsOn} onClick={toggleSignals}>
            Controle de semáforos
          </button>
        </div>
        <p className="stats">
          Carros na via: <strong data-testid="active-cars">{stats.active}</strong> · Gerados:{' '}
          <strong data-testid="spawned-total">{stats.spawned}</strong>
        </p>
      </header>
      <div className="workspace">
        <div className="map-column">
          <div className="map-area">
            <SimulationCanvas
              engine={engine}
              segmentStatus={statusNow}
              selectedSegment={selectedSegment}
              onSelectSegment={setSelectedSegment}
              accidentMode={accidentMode}
              onAccident={(segmentId, distance) => engine.addBlockage(segmentId, distance)}
              onRemoveBlockage={(id) => engine.removeBlockage(id)}
              layer={layer}
              onHoverSegment={setHover}
            />
            {hover && (
              <SegmentTooltip
                content={segmentTooltip(
                  hover.segmentId,
                  engine.coverage.entries(hover.segmentId),
                  capacity.fusion.state()[hover.segmentId],
                  fusedStatus(capacity.fusion.state()[hover.segmentId], engine.getState().timeMs),
                  engine.getState().timeMs,
                  jammed,
                )}
                x={hover.x}
                y={hover.y}
              />
            )}
          </div>
          <RoadTable segmentIds={segmentIds} status={status} fused={fused} units={units} selected={selectedSegment} onSelect={setSelectedSegment} />
        </div>
        <div className="side">
          <CapacityPanel
            segmentId={selectedSegment}
            estimate={estimates[selectedSegment]}
            status={status[selectedSegment]}
            fused={fused[selectedSegment]}
            coverage={engine.coverage.entries(selectedSegment)}
          />
          <AppPanel transport={transport} diversion={diversion} />
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
          <MetricsPanel metrics={metrics} diversion={diversion} />
          <CameraPanel
            cameras={cameras}
            onChange={(id, change) => {
              engine.updateCamera(id, change)
              refreshCameras()
            }}
            onAdd={() => {
              engine.addCamera()
              refreshCameras()
            }}
            onRemove={(id) => {
              engine.removeCamera(id)
              refreshCameras()
            }}
          />
          <TelemetryPanel transport={transport} sensorIds={cameras.map((c) => c.id)} />
          <ExperimentsPanel />
        </div>
      </div>
    </main>
  )
}

export default App
