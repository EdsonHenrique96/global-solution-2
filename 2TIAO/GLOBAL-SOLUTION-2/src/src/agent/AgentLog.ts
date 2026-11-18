export const LOG_SIZE = 50

export type LogOrigin = 'agente' | 'regra' | 'operador'

export interface LogEntry {
  /** Simulated time, ms. */
  at: number
  origem: LogOrigin
  texto: string
}

/** The decision log the operator reads: the last 50 entries, newest first. */
export class AgentLog {
  private items: LogEntry[] = []

  add(at: number, origem: LogOrigin, texto: string): void {
    this.items = [{ at, origem, texto }, ...this.items].slice(0, LOG_SIZE)
  }

  entries(): LogEntry[] {
    return [...this.items]
  }
}
