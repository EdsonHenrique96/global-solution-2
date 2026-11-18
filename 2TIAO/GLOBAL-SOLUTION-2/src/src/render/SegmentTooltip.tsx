import type { TooltipContent } from './tooltip'

interface Props {
  content: TooltipContent
  x: number
  y: number
}

export function SegmentTooltip({ content, x, y }: Props) {
  return (
    <div className="segment-tooltip" role="tooltip" style={{ left: x + 14, top: y + 14 }}>
      <strong data-testid="tooltip-nome">{content.nome}</strong>
      {content.estimado && <span className="tag">estimado</span>}
      <dl>
        <dt>Estado</dt>
        <dd data-testid="tooltip-estado">{content.estado}</dd>
        <dt>Contagem (câmera)</dt>
        <dd data-testid="tooltip-contagem">{content.contagem}</dd>
        <dt>Velocidade (radar)</dt>
        <dd data-testid="tooltip-velocidade">{content.velocidade}</dd>
        <dt>Densidade</dt>
        <dd data-testid="tooltip-densidade">{content.densidade}</dd>
        <dt>Unidade</dt>
        <dd data-testid="tooltip-unidade">{content.unidade}</dd>
        <dt>Confiança</dt>
        <dd data-testid="tooltip-confianca">{content.confianca}</dd>
        <dt>Idade do dado</dt>
        <dd data-testid="tooltip-idade">{content.idade}</dd>
      </dl>
      {content.avisos.length > 0 && (
        <ul className="avisos" data-testid="tooltip-avisos">
          {content.avisos.map((a) => (
            <li key={a}>⚠ {a}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
