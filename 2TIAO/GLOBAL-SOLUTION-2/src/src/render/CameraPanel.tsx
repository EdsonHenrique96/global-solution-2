import type { FixedCamera } from '../sensors/camera'

interface Props {
  cameras: readonly FixedCamera[]
  onChange: (id: string, change: Partial<Pick<FixedCamera, 'heading' | 'fov' | 'range'>>) => void
  onAdd: () => void
  onRemove: (id: string) => void
}

/** The fixed camera layer the operator configures (spec item 5). */
export function CameraPanel({ cameras, onChange, onAdd, onRemove }: Props) {
  return (
    <section className="cameras" aria-label="Câmeras">
      <h2>Câmeras</h2>
      <ul>
        {cameras.map((c) => (
          <li key={c.id} data-testid={`camera-${c.id}`}>
            <strong>{c.id}</strong>
            <label>
              Direção (°)
              <input type="number" min={0} max={359} value={c.heading} onChange={(e) => onChange(c.id, { heading: Number(e.target.value) })} />
            </label>
            <label>
              Ângulo (°)
              <input type="number" min={10} max={170} value={c.fov} onChange={(e) => onChange(c.id, { fov: Number(e.target.value) })} />
            </label>
            <label>
              Alcance (m)
              <input type="number" min={20} max={500} value={c.range} onChange={(e) => onChange(c.id, { range: Number(e.target.value) })} />
            </label>
            <button type="button" onClick={() => onRemove(c.id)}>
              Remover
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onAdd}>
        Adicionar câmera
      </button>
    </section>
  )
}
