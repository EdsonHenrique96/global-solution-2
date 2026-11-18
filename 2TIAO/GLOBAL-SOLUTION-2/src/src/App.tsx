import { useEffect, useState } from 'react'
import { NoiseControl } from './render/NoiseControl'
import { SimulationCanvas } from './render/SimulationCanvas'
import { TelemetryPanel } from './render/TelemetryPanel'
import { VolumeControl } from './render/VolumeControl'
import { SimulationEngine, TICK_MS } from './sim/SimulationEngine'
import { wireTelemetry } from './telemetry/TelemetryPublisher'
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

  useEffect(() => wireTelemetry(engine, transport), [engine, transport])

  useEffect(() => {
    const id = setInterval(() => {
      engine.tick(TICK_MS)
      const state = engine.getState()
      setStats({ active: state.cars.length, spawned: state.spawnedTotal })
    }, TICK_MS)
    return () => clearInterval(id)
  }, [engine])

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
        <SimulationCanvas engine={engine} />
        <TelemetryPanel transport={transport} droneIds={engine.getState().drones.map((d) => d.id)} />
      </div>
    </main>
  )
}

export default App
