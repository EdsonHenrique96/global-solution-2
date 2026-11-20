import type { AgentEvent } from '../agent/ProposalAudit'
import type { Simulation } from './Simulation'

const INTERVAL_MS = 30_000
// Space successive incidents around the grid while previous queues clear.
const corridors = [
  ['I11>I12', 'I12>I13', 'I13>I14'],
  ['I44>I43', 'I43>I42', 'I42>I41'],
  ['I14>I24', 'I24>I34', 'I34>I44'],
]
const approaches = [
  ['I21>I22', 'I22>I23'],
  ['I33>I23', 'I23>I13'],
  ['I43>I33', 'I33>I23'],
]

/** Adds demand and short-lived blockages. All recommendations use the live engine and its policy. */
export class PresentationTraffic {
  active = false
  nextAt = 0
  label = ''
  private step = 0
  private previousSignals = false
  private blocks: number[] = []

  start(sim: Simulation) {
    if (this.active) return
    this.active = true
    this.step = 0
    // Align the pulse with the ten-second diversion windows so candidates can be notified before entering the blockage.
    this.nextAt = (Math.floor(sim.engine.getState().timeMs / 10000) + 1) * 10000
    this.previousSignals = sim.engine.getState().adaptiveSignals
    sim.engine.setAdaptiveSignals(true)
  }
  stop(sim: Simulation) {
    if (!this.active) return
    this.active = false
    for (const id of this.blocks) sim.engine.removeBlockage(id)
    this.blocks = []
    sim.refreshIncidents()
    sim.engine.setAdaptiveSignals(this.previousSignals)
  }

  tick(sim: Simulation): AgentEvent | null {
    const { engine } = sim
    const state = engine.getState()
    if (!this.active || state.timeMs < this.nextAt) return null
    const index = Math.floor(this.step / 2) % corridors.length
    const signal = this.step++ % 2 === 1
    this.nextAt = state.timeMs + INTERVAL_MS
    const path = signal ? approaches[index] : corridors[index]
    const entry = engine.segment(path[0])!
    const occupied = state.cars.filter(c => c.path[c.seg] === entry.id).map(c => c.distance)
    // A platoon with connected navigation approaches the incident. Keep real gaps
    // from existing traffic and the stop line; the IDM engine drives every vehicle.
    for (let d = entry.length - 9, added = 0; d >= 0 && added < 12; d -= 8) {
      if (occupied.some(x => Math.abs(d - x) < 7)) continue
      engine.addCar({ path, distance: d, velocity: 0, app: 'waze' })
      occupied.push(d)
      added++
    }
    if (signal) {
      this.label = 'Fila no cruzamento ' + entry.to
      return { tipo: 'fila', trecho: entry.id, ts: state.timeMs, dados: {
        intersecao: entry.to, H: engine.queueAt(entry.to,'H'), V: engine.queueAt(entry.to,'V'),
        controleAdaptativo: engine.getState().adaptiveSignals, origem: 'apresentacao',
      } }
    }
    const trecho = path[1]
    this.blocks = this.blocks.filter(id => state.blockages.some(b => b.id === id))
    this.blocks.push(sim.reportAccident(trecho, 21, 45_000).id)
    this.label = 'Acidente no trecho ' + trecho
    return { tipo:'congestionamento', trecho, ts:state.timeMs, dados:{motivo:'acidente registrado',origem:'apresentacao'} }
  }
}
