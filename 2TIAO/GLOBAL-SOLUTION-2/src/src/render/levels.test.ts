import { describe, expect, it } from 'vitest'
import type { Estimate } from '../capacity/CapacityModel'
import type { FusedSegment } from '../fusion/FusionService'
import { buildSegments } from '../sensors/segments'
import { buildCityNetwork } from '../sim/cityNetwork'
import {
  averageSpeed,
  camerasCard,
  hourAgo,
  incidentsCard,
  labelLines,
  networkOccupancy,
  nivelOf,
  rankStreets,
  readSegment,
  signalsCard,
  streetRows,
  totalFlowPerMin,
  unitOnline,
  versusHourAgo,
  type SegmentReading,
} from './levels'

const NOW = 100_000

const estimate = (fluxo: number, capacidade: number | null): Estimate => ({
  estado: 'fluindo',
  densidade: 10,
  velocidade: 40,
  fluxo,
  vf: null,
  kj: null,
  capacidade,
  folga: null,
  amostras: [],
})

const fused = (velocidadeMedia: number | null, atualizadoEm: number | null = NOW - 5_000, contagem: number | null = 5): FusedSegment => ({
  contagem,
  densidade: 10,
  velocidadeMedia,
  alertas: [],
  demandaOD: null,
  fontes: ['U01'],
  confianca: 1,
  atualizadoEm,
  estimado: false,
})

const reading = (id: string, over: Partial<SegmentReading>): SegmentReading => ({
  id,
  nivel: 'livre',
  pct: 10,
  fluxo: 100,
  capacidade: 1000,
  velocidade: 45,
  contagem: 3,
  ...over,
})

describe('levels', () => {
  it('C7 classifies the pct boundaries', () => {
    const cases: [number, string][] = [
      [49, 'livre'],
      [50, 'moderado'],
      [74, 'moderado'],
      [75, 'intenso'],
      [89, 'intenso'],
      [90, 'critico'],
      [130, 'critico'],
    ]
    for (const [pct, nivel] of cases) expect(nivelOf(pct, 50), `pct ${pct}`).toBe(nivel)
    // and through a segment: 1 716 of 1 800 veh/h is 95%
    expect(readSegment('I11>I12', estimate(1716, 1800), fused(45), NOW)).toMatchObject({ nivel: 'critico', pct: 95 })
    expect(readSegment('I11>I12', estimate(882, 1800), fused(45), NOW)).toMatchObject({ nivel: 'livre', pct: 49 })
  })

  it('C8 a slow segment is critical whatever its pct', () => {
    expect(nivelOf(20, 24)).toBe('critico')
    expect(nivelOf(20, 25)).toBe('livre')
    expect(nivelOf(80, 24)).toBe('critico')
    expect(readSegment('I11>I12', estimate(360, 1800), fused(24), NOW)).toMatchObject({ nivel: 'critico', pct: 20 })
    // also while the capacity is still being learned
    expect(readSegment('I11>I12', estimate(360, null), fused(24), NOW)).toMatchObject({ nivel: 'critico', pct: null })
    expect(readSegment('I11>I12', estimate(360, null), fused(25), NOW)).toMatchObject({ nivel: 'aprendendo', pct: null })
  })

  it('C9 learning and no data', () => {
    expect(readSegment('I11>I12', estimate(600, null), fused(45), NOW)).toMatchObject({ nivel: 'aprendendo', pct: null, fluxo: 600 })
    // last reading 20 s ago still counts; 20.001 s ago it does not
    expect(readSegment('I11>I12', estimate(600, 1800), fused(45, NOW - 20_000), NOW).nivel).toBe('livre')
    expect(readSegment('I11>I12', estimate(600, 1800), fused(45, NOW - 20_001), NOW)).toMatchObject({ nivel: 'sem dado', pct: null })
    expect(readSegment('I11>I12', estimate(600, 1800), fused(45, null), NOW).nivel).toBe('sem dado')
    expect(readSegment('I11>I12', undefined, undefined, NOW).nivel).toBe('sem dado')
  })

  it('C13 street label numbers in carros per minute', () => {
    const r = readSegment('I11>I12', estimate(1716, 1800), fused(14), NOW)
    expect(labelLines(r)).toEqual({ atual: '29', suporta: '30 carros/min', media: '14' })
  })

  it('C14 picks the most saturated segment of a street', () => {
    const segments = buildSegments(buildCityNetwork())
    const santos = segments.filter((s) => s.rua === 'Al. Santos').map((s) => s.id)
    expect(santos).toHaveLength(6)
    const base = Object.fromEntries(segments.map((s) => [s.id, reading(s.id, { nivel: 'sem dado', pct: null })]))
    // level beats pct: intenso 80% loses to a critico at 30% (slow)
    base[santos[0]] = reading(santos[0], { nivel: 'intenso', pct: 80 })
    base[santos[1]] = reading(santos[1], { nivel: 'critico', pct: 30 })
    base[santos[2]] = reading(santos[2], { nivel: 'livre', pct: 45 })
    base[santos[3]] = reading(santos[3], { nivel: 'aprendendo', pct: null })
    const row = streetRows(segments, base).find((r) => r.rua === 'Al. Santos')!
    expect(row.worst.id).toBe(santos[1])
    // same level: the higher pct
    base[santos[4]] = reading(santos[4], { nivel: 'critico', pct: 96 })
    expect(streetRows(segments, base).find((r) => r.rua === 'Al. Santos')!.worst.id).toBe(santos[4])
    // full order: critico > intenso > moderado > livre > aprendendo > sem dado
    const order = ['critico', 'intenso', 'moderado', 'livre', 'aprendendo', 'sem dado'] as const
    for (let i = 0; i < order.length - 1; i++) {
      const only = Object.fromEntries(segments.map((s) => [s.id, reading(s.id, { nivel: 'sem dado', pct: null })]))
      only[santos[0]] = reading(santos[0], { nivel: order[i + 1], pct: 99 })
      only[santos[5]] = reading(santos[5], { nivel: order[i], pct: 1 })
      expect(streetRows(segments, only).find((r) => r.rua === 'Al. Santos')!.worst.id, `${order[i]} > ${order[i + 1]}`).toBe(santos[5])
    }
  })

  it('C15 label without capacity or speed', () => {
    const learning = readSegment('I11>I12', estimate(1200, null), fused(null), NOW)
    expect(labelLines(learning)).toEqual({ atual: '20', suporta: 'aprendendo', media: '—' })
  })

  it('C19 a unit is online up to 20 s after its last reading', () => {
    expect(unitOnline(NOW - 20_000, NOW)).toBe(true)
    expect(unitOnline(NOW - 21_000, NOW)).toBe(false)
    expect(unitOnline(undefined, NOW)).toBe(false)
  })

  it('C21 cameras card names the unit silent the longest', () => {
    const ids = ['U01', 'U02', 'U03']
    expect(camerasCard(ids, { U01: NOW, U02: NOW - 1_000, U03: NOW }, NOW)).toEqual({ value: '3 / 3', note: 'todas enviando leitura' })
    const now = 30 * 60_000
    expect(camerasCard(ids, { U01: now, U02: now - 22 * 60_000, U03: now - 5 * 60_000 }, now)).toEqual({ value: '1 / 3', note: 'U02 sem sinal há 22 min' })
  })

  it('C33 incidents card counts critical and moderate', () => {
    expect(incidentsCard(['critico', 'moderado', 'moderado'])).toEqual({ value: 3, note: '1 crítico · 2 moderados' })
    expect(incidentsCard(['moderado'])).toEqual({ value: 1, note: '0 crítico · 1 moderado' })
    expect(incidentsCard([])).toEqual({ value: 0, note: 'nenhum crítico' })
  })

  it('C34 signals card counts flashing corners', () => {
    expect(signalsCard(0, 16)).toEqual({ value: '16 / 16', note: 'todos em ciclo normal' })
    expect(signalsCard(1, 16)).toEqual({ value: '15 / 16', note: '1 em modo intermitente' })
  })

  it('C41 total flow sums segments with readings in carros per minute', () => {
    const rs = [
      reading('a', { fluxo: 600 }),
      reading('b', { fluxo: 1200, nivel: 'aprendendo', pct: null, capacidade: null }),
      reading('c', { fluxo: 6000, nivel: 'sem dado', pct: null }),
    ]
    expect(totalFlowPerMin(rs)).toBe(30)
  })

  it('C42 average speed weighted by count and compared with one hour ago', () => {
    const rs = [reading('a', { velocidade: 10, contagem: 3 }), reading('b', { velocidade: 50, contagem: 1 }), reading('c', { velocidade: null })]
    expect(averageSpeed(rs)).toBe(20)
    expect(averageSpeed([reading('a', { velocidade: null })])).toBeNull()
    const samples = [
      { t: 0, avgSpeed: 38 },
      { t: 1_800_000, avgSpeed: 35 },
    ]
    expect(hourAgo(samples, 3_599_999)).toBeNull()
    expect(versusHourAgo(30, hourAgo(samples, 3_599_999)?.avgSpeed, 'km/h')).toBe('sem histórico de 1 h')
    expect(versusHourAgo(30, hourAgo(samples, 3_600_000)?.avgSpeed, 'km/h')).toBe('−8 km/h vs. 1 h atrás')
    expect(versusHourAgo(40, hourAgo(samples, 5_400_000)?.avgSpeed, 'km/h')).toBe('+5 km/h vs. 1 h atrás')
  })

  it('C43 network occupancy over learned segments', () => {
    const rs = [
      reading('a', { fluxo: 6000, capacidade: 9000, pct: 67 }),
      reading('b', { fluxo: 3600, capacidade: null, pct: null, nivel: 'aprendendo' }),
      reading('c', { fluxo: 1020, capacidade: 1440, pct: 71 }),
    ]
    expect(networkOccupancy(rs)).toEqual({ pct: 67, flow: 117, cap: 174 })
    expect(networkOccupancy([reading('b', { pct: null, capacidade: null, nivel: 'aprendendo' })])).toBeNull()
  })

  it('C44 travel time compared with one hour ago', () => {
    const samples = [{ t: 0, travelMin: 25 }]
    expect(versusHourAgo(34, hourAgo(samples, 3_600_000)?.travelMin, 'min')).toBe('+9 min vs. 1 h atrás')
    expect(versusHourAgo(34, hourAgo(samples, 60_000)?.travelMin, 'min')).toBe('sem histórico de 1 h')
    expect(versusHourAgo(null, 25, 'min')).toBe('sem histórico de 1 h')
  })

  it('C46 ranks the 8 streets by their worst segment', () => {
    const segments = buildSegments(buildCityNetwork())
    const pcts = [95, 84, 79, 66, 41, 43, null, 66]
    const readings = Object.fromEntries(segments.map((s) => [s.id, reading(s.id, { nivel: 'sem dado', pct: null })]))
    const rows = streetRows(segments, readings).map((r, i) => ({ ...r, worst: reading(r.worst.id, { pct: pcts[i], nivel: pcts[i] === null ? 'aprendendo' : 'livre' }) }))
    expect(rows).toHaveLength(8)
    const ranked = rankStreets(rows)
    expect(ranked.map((r) => r.worst.pct)).toEqual([95, 84, 79, 66, 66, 43, 41, null])
    expect(ranked.at(-1)!.rua).toBe(rows[6].rua)
  })
})
