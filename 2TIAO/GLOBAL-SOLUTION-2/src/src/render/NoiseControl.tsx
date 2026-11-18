import { MAX_NOISE_PCT } from '../telemetry/DroneSensor'

interface Props {
  value: number
  onChange: (pct: number) => void
}

export function NoiseControl({ value, onChange }: Props) {
  return (
    <label className="volume-control">
      <span>Ruído da leitura (%)</span>
      <input
        type="range"
        min={0}
        max={MAX_NOISE_PCT}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value}</output>
    </label>
  )
}
