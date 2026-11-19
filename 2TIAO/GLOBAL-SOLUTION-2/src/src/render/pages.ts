/** The menu's pages. */
export type Tab = 'mapa' | 'cameras' | 'semaforos' | 'desvio' | 'relatorios'

/** The pages of the menu, in order (AD-111): each one is a page with its own address (`#<id>`). */
export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'mapa', label: 'Mapa ao vivo' },
  { id: 'cameras', label: 'Câmeras' },
  { id: 'semaforos', label: 'Semáforos' },
  { id: 'desvio', label: 'Desvio' },
  { id: 'relatorios', label: 'Relatórios' },
]

/** The page an address (`#desvio`) opens; the map for anything else. */
export const tabFromHash = (hash: string): Tab => TABS.find((t) => `#${t.id}` === hash)?.id ?? 'mapa'
