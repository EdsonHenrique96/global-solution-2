/**
 * Training-data demand curve (door 4, AD-101): weekdays 30 cars/min at night (0-6 h), 150 at the
 * peaks (7-9 h and 17-19 h), 75 the rest of the day; Saturday and Sunday 0.6 x the weekday value.
 * In the 30 min before each change the demand moves linearly to the next value. Only the dataset
 * generator uses it: the live demand is the operator's (AD-077).
 */
const LEVELS: readonly (readonly [startMin: number, carsPerMin: number])[] = [
  [0, 30],
  [6 * 60, 75],
  [7 * 60, 150],
  [9 * 60, 75],
  [17 * 60, 150],
  [19 * 60, 75],
]
export const RAMP_MIN = 30
const DAY_MIN = 1440

const weekend = (dia: number) => dia === 0 || dia === 6

/** The plateau value at a minute of a day (no ramp). */
function plateau(diaSemana: number, horaMin: number): number {
  let v = LEVELS[0][1]
  for (const [start, value] of LEVELS) if (horaMin >= start) v = value
  return (weekend(diaSemana) ? 0.6 : 1) * v
}

/** Cars per minute at `horaMin` of `diaSemana` (0 = domingo). */
export function demandaPorHora(diaSemana: number, horaMin: number): number {
  const nextChange = LEVELS.map(([start]) => start).find((start) => start > horaMin) ?? DAY_MIN
  const here = plateau(diaSemana, horaMin)
  if (horaMin < nextChange - RAMP_MIN) return here
  const next = nextChange === DAY_MIN ? plateau((diaSemana + 1) % 7, 0) : plateau(diaSemana, nextChange)
  return here + ((next - here) * (horaMin - (nextChange - RAMP_MIN))) / RAMP_MIN
}
