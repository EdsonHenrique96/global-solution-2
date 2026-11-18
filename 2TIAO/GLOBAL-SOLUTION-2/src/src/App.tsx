import { useEffect, useState } from 'react'
import { Simulation } from './decision/Simulation'
import { CapacityPanel } from './render/CapacityPanel'
import { MetricsPanel } from './render/MetricsPanel'
import { NoiseControl } from './render/NoiseControl'
import { SimulationCanvas } from './render/SimulationCanvas'
import { TelemetryPanel } from './render/TelemetryPanel'
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
}

function App({ engine: injectedEngine, transport: injectedTransport }: Props) {
  const [transport] = useState(() => injectedTransport ?? createOfflineTransport())
  const [sim] = useState(() => new Simulation({ engine: injectedEngine ?? new SimulationEngine(), transport }))
  const { engine, capacity } = sim
  const [rate, setRate] = useState(() => engine.getRate())
  const [noise, setNoise] = useState(() => engine.getNoise())
  const [stats, setStats] = useState({ active: 0, spawned: 0 })
  const [selectedSegment, setSelectedSegment] = useState('central-I1-I2')
  const [estimates, setEstimates] = useState(() => capacity.snapshot())
  const [metrics, setMetrics] = useState(() => sim.metrics.snapshot())
  const [diversion, setDiversion] = useState(() => sim.diversion)
  const [accidentMode, setAccidentMode] = useState(false)
  const [diversionOn, setDiversionOn] = useState(() => sim.isDiversionEnabled())
  const [signalsOn, setSignalsOn] = useState(() => engine.getState().adaptiveSignals)

  useEffect(() => {
    sim.start()
    // a message can change an estimate between ticks; refresh on each one too
    const off = transport.subscribe(TELEMETRY_FILTER, () => setEstimates(capacity.snapshot()))
    return () => {
      off()
      sim.stop()
    }
  }, [sim, capacity, transport])

  useEffect(() => {
    const id = setInterval(() => {
      sim.tick()
      const state = engine.getState()
      setStats({ active: state.cars.length, spawned: state.spawnedTotal })
      setEstimates(capacity.snapshot())
      setMetrics(sim.metrics.snapshot())
      setDiversion(sim.diversion)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [sim, engine, capacity])

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

  return (
    <main className="app">
      <header className="toolbar">
        <h1>Trânsito inteligente — simulação</h1>
        <VolumeControl value={rate} onChange={changeRate} />
        <NoiseControl value={noise} onChange={changeNoise} />
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
        <SimulationCanvas
          engine={engine}
          segmentStatus={() => Object.fromEntries(Object.entries(capacity.snapshot()).map(([id, e]) => [id, e.estado]))}
          selectedSegment={selectedSegment}
          onSelectSegment={setSelectedSegment}
          accidentMode={accidentMode}
          onAccident={(routeId, distance) => engine.addBlockage(routeId, distance)}
          onRemoveBlockage={(id) => engine.removeBlockage(id)}
        />
        <div className="side">
          <MetricsPanel metrics={metrics} diversion={diversion} />
          <CapacityPanel segmentId={selectedSegment} estimate={estimates[selectedSegment]} />
          <TelemetryPanel transport={transport} sensorIds={engine.getState().cameras.map((c) => c.id)} />
        </div>
      </div>
    </main>
  )
}

export default App
