import { useEffect, useState } from 'react'
import { SimulationCanvas } from './render/SimulationCanvas'
import { VolumeControl } from './render/VolumeControl'
import { SimulationEngine, TICK_MS } from './sim/SimulationEngine'
import './App.css'

interface Props {
  /** Injected in tests; the page creates its own. */
  engine?: SimulationEngine
}

function App({ engine: injected }: Props) {
  const [engine] = useState(() => injected ?? new SimulationEngine())
  const [rate, setRate] = useState(() => engine.getRate())
  const [stats, setStats] = useState({ active: 0, spawned: 0 })

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

  return (
    <main className="app">
      <header className="toolbar">
        <h1>Trânsito inteligente — simulação base</h1>
        <VolumeControl value={rate} onChange={changeRate} />
        <p className="stats">
          Carros na via: <strong data-testid="active-cars">{stats.active}</strong> · Gerados:{' '}
          <strong data-testid="spawned-total">{stats.spawned}</strong>
        </p>
      </header>
      <SimulationCanvas engine={engine} />
    </main>
  )
}

export default App
