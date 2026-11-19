import type { DiversionState } from '../decision/DiversionController'
import { segmentName } from '../sensors/segments'

/** What the diversion is doing now, in one line (the Desvio page). */
export function diversionText(d: DiversionState): string {
  switch (d.status) {
    case 'ativo':
      // the fraction comes from the simulation ahead (RF18); "notificar todos" tells everyone
      if (d.calculando) return `evitar ${segmentName(d.trecho)} · ${d.candidatos} motoristas com app à frente · calculando a fração… · ${d.notificados} notificados na janela`
      return `evitar ${segmentName(d.trecho)} · ${d.candidatos} motoristas com app à frente · fração ${Math.round(d.p * 100)}%${d.simulacao ? ' (simulada)' : ''} · ${d.notificados} notificados na janela`
    case 'desligado':
      return 'desligado'
    default:
      return 'inativo'
  }
}
