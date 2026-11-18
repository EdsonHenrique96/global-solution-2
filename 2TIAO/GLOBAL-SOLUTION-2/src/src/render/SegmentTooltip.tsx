import type { TooltipContent } from './tooltip'

interface Props {
  content: TooltipContent
  x: number
  y: number
}

export function SegmentTooltip({ content, x, y }: Props) {
  return (
    <div className="segment-tooltip" role="tooltip" style={{ left: x + 14, top: y + 14 }}>
      <strong>{content.nome}</strong>
      {content.estimado && <span className="tag">estimado</span>}
      <dl>
        <dt>Câmeras</dt>
        <dd data-testid="tooltip-sensores">{content.sensores}</dd>
        <dt>Fontes ativas</dt>
        <dd data-testid="tooltip-fontes">{content.fontes}</dd>
        <dt>Confiança</dt>
        <dd data-testid="tooltip-confianca">{content.confianca}</dd>
        <dt>Idade do dado</dt>
        <dd data-testid="tooltip-idade">{content.idade}</dd>
        <dt>Alertas</dt>
        <dd data-testid="tooltip-alertas">{content.alertas}</dd>
        <dt>Demanda OD</dt>
        <dd data-testid="tooltip-demanda">{content.demanda}</dd>
      </dl>
    </div>
  )
}
