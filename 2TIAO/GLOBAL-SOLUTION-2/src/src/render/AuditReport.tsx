import type { AuditEntry, Evidence } from '../agent/ProposalAudit'

export function Figures({ data }: { data: Evidence['numeros'] }) {
  const fmt = (v: number | null, unit: string) => v === null ? 'sem dado' : v.toLocaleString('pt-BR', {maximumFractionDigits:2}) + unit
  return <span>Ocupação atual {fmt(data.ocupacaoAtualPct, '%')} · prevista {fmt(data.ocupacaoPrevistaPct, '%')} · alternativa {fmt(data.ocupacaoAlternativaPct, '%')} · ganho de tempo {fmt(data.ganhoTempoS, ' s')} · ganho de CO₂ {fmt(data.ganhoCo2Kg, ' kg')}</span>
}
export function AuditReport({ entries }: { entries: AuditEntry[] }) {
  function save() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], {type:'application/json'}))
    const a = document.createElement('a')
    a.href = url
    a.download = 'auditoria-agente.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <section aria-label="Auditoria do agente"><h2>Auditoria do agente</h2>
    {entries.length === 0 ? <p>Nenhuma proposta do agente ainda</p> : <>
      <button onClick={save}>Baixar auditoria</button>
      <ol>{entries.map(e => <li key={e.id}>
        <strong>{Math.floor(e.ts / 1000)} s · {e.acao.tipo} · {e.acao.tipo === 'desvio' ? e.acao.trecho : e.acao.intersecao} · {e.decisao}</strong>
        <p>{e.justificativa}</p>{e.numeros && <Figures data={e.numeros} />}
        {e.resultado && <p>Após 10 min: trecho {e.resultado.ocupacaoTrechoPct ?? '—'}%, alternativa {e.resultado.ocupacaoAlternativaPct ?? '—'}%, viagem {e.resultado.tempoMedioS ?? '—'} s.</p>}
      </li>)}</ol></>}
  </section>
}
