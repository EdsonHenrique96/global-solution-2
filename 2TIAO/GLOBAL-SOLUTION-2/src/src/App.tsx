import { useEffect, useState } from 'react'
import { CapacityService } from './capacity/CapacityService'
import { CapacityPanel } from './render/CapacityPanel'
import { NoiseControl } from './render/NoiseControl'
import { SimulationCanvas } from './render/SimulationCanvas'
import { TelemetryPanel } from './render/TelemetryPanel'
import { VolumeControl } from './render/VolumeControl'
import { SimulationEngine, TICK_MS } from './sim/SimulationEngine'
import { TELEMETRY_FILTER, wireTelemetry } from './telemetry/TelemetryPublisher'
import { createOfflineTransport, type TelemetryTransport } from './telemetry/transport'
import './App.css'

interface Props {
  /** Injected in tests; the page creates its own. */
  engine?: SimulationEngine
  /** The broker connection; `main.tsx` passes the MQTT one. Without it the page runs offline. */
  transport?: TelemetryTransport
}

function App({ engine: injectedEngine, transport: injectedTransport }: Props) {
  const [engine] = useState(() => injectedEngine ?? new SimulationEngine())
  const [transport] = useState(() => injectedTransport ?? createOfflineTransport())
  const [rate, setRate] = useState(() => engine.getRate())
  const [noise, setNoise] = useState(() => engine.getNoise())
  const [stats, setStats] = useState({ active: 0, spawned: 0 })
  const [capacity] = useState(() => new CapacityService(transport, () => engine.getState().timeMs))
  const [selectedRoute, setSelectedRoute] = useState('central')
  const [estimates, setEstimates] = useState(() => capacity.snapshot())

  useEffect(() => wireTelemetry(engine, transport), [engine, transport])

  useEffect(() => {
    capacity.start()
    // a message can change an estimate between ticks; refresh on each one too
    const off = transport.subscribe(TELEMETRY_FILTER, () => setEstimates(capacity.snapshot()))
    return () => {
      off()
      capacity.stop()
    }
  }, [capacity, transport])

  useEffect(() => {
    const id = setInterval(() => {
      engine.tick(TICK_MS)
      const state = engine.getState()
      setStats({ active: state.cars.length, spawned: state.spawnedTotal })
      setEstimates(capacity.snapshot())
    }, TICK_MS)
    return () => clearInterval(id)
  }, [engine, capacity])

  const changeRate = (next: number) => {
    engine.setRate(next)
    setRate(engine.getRate())
  }

  const changeNoise = (next: number) => {
    engine.setNoise(next)
    setNoise(engine.getNoise())
  }

  return (
    <main className="app">
      <header className="toolbar">
        <h1>Trânsito inteligente — simulação base</h1>
        <VolumeControl value={rate} onChange={changeRate} />
        <NoiseControl value={noise} onChange={changeNoise} />
        <p className="stats">
          Carros na via: <strong data-testid="active-cars">{stats.active}</strong> · Gerados:{' '}
          <strong data-testid="spawned-total">{stats.spawned}</strong>
        </p>
      </header>
      <div className="workspace">
        <SimulationCanvas
          engine={engine}
          routeStatus={() => Object.fromEntries(Object.entries(capacity.snapshot()).map(([id, e]) => [id, e.estado]))}
          selectedRoute={selectedRoute}
          onSelectRoute={setSelectedRoute}
        />
        <div className="side">
          <CapacityPanel routeId={selectedRoute} estimate={estimates[selectedRoute]} />
          <TelemetryPanel transport={transport} droneIds={engine.getState().drones.map((d) => d.id)} />
        </div>
      </div>
    </main>
  )
}

export default App
