import type { FixedCamera } from '../sensors/camera'

interface Props {
  cameras: readonly FixedCamera[]
  onChange: (id: string, change: Partial<Pick<FixedCamera, 'heading' | 'fov' | 'range'>>) => void
  onAdd: () => void
  onRemove: (id: string) => void
  /** The unit "Ver câmera" opened this tab for. */
  selected?: string | null
}

/** The camera+radar units the operator configures: camera and radar turn together (AC 12). */
export function CameraPanel({ cameras, onChange, onAdd, onRemove, selected }: Props) {
  return (
    <section className="cameras" aria-label="Unidades câmera+radar">
      <h2>Unidades câmera+radar</h2>
      <ul>
        {cameras.map((c) => (
          <li key={c.id} data-testid={`camera-${c.id}`} aria-current={c.id === selected ? 'true' : undefined} className={c.id === selected ? 'selected' : undefined}>
            <strong>{c.id}</strong>
            <label>
              Direção (°)
              <input type="number" min={0} max={359} value={c.heading} onChange={(e) => onChange(c.id, { heading: Number(e.target.value) })} />
            </label>
            <label>
              Ângulo câmera (°)
              <input type="number" min={10} max={170} value={c.fov} onChange={(e) => onChange(c.id, { fov: Number(e.target.value) })} />
            </label>
            <label>
              Alcance câmera (m)
              <input type="number" min={20} max={500} value={c.range} onChange={(e) => onChange(c.id, { range: Number(e.target.value) })} />
            </label>
            <button type="button" onClick={() => onRemove(c.id)}>
              Remover
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onAdd}>
        Adicionar unidade
      </button>
    </section>
  )
}
