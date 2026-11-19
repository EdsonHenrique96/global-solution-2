/** Day names of the simulated clock, 0 = domingo (as in JavaScript's Date). */
export const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const

export interface ClockTime {
  /** 0 = domingo, 1 = segunda ... 6 = sábado. */
  diaSemana: number
  /** Minutes since midnight, 0-1439. */
  horaMin: number
}

/** The live run starts on Monday at 07:00 (AD-077). */
export const SIM_START: ClockTime = { diaSemana: 1, horaMin: 7 * 60 }

const DAY_MIN = 1440
const WEEK_MIN = 7 * DAY_MIN

/** Day and minute of the simulated clock `ms` after `start`. */
export function clockAt(ms: number, start: ClockTime = SIM_START): ClockTime {
  const total = start.diaSemana * DAY_MIN + start.horaMin + Math.floor(ms / 60_000)
  const m = ((total % WEEK_MIN) + WEEK_MIN) % WEEK_MIN
  return { diaSemana: Math.floor(m / DAY_MIN), horaMin: m % DAY_MIN }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "Seg 07:00". */
export function formatClockTime({ diaSemana, horaMin }: ClockTime): string {
  return `${DIAS[diaSemana]} ${pad(Math.floor(horaMin / 60))}:${pad(horaMin % 60)}`
}

/** The simulated clock `ms` into the run, as the header shows it. */
export const formatClock = (ms: number, start: ClockTime = SIM_START) => formatClockTime(clockAt(ms, start))
