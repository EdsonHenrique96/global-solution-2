import { DEFAULT_RATE_PER_MINUTE } from '../sim/SimulationEngine'

/** Up to double the default demand: the V1 demonstration (AC 17). */
export const MAX_RATE_PER_MINUTE = 2 * DEFAULT_RATE_PER_MINUTE

interface Props {
  value: number
  onChange: (ratePerMinute: number) => void
}

export function VolumeControl({ value, onChange }: Props) {
  return (
    <label className="volume-control">
      <span>Carros por minuto</span>
      <input
        type="range"
        min={0}
        max={MAX_RATE_PER_MINUTE}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value}</output>
    </label>
  )
}
