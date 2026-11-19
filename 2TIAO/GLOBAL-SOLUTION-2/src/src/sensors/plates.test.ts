import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PlateCameraSet, defaultPlateCameras } from './PlateCamera'
import { buildSegments } from './segments'
import { buildCityNetwork } from '../sim/cityNetwork'
import { STOP_LINE_M } from '../sim/SimulationEngine'
import { PLACA_RE, PlateGenerator, hourOf, plateHash, salt } from './plates'

const at = (h: number, m: number, s = 0) => ((h * 60 + m) * 60 + s) * 1000

describe('plates', () => {
  it('C3 draws 2000 distinct Mercosul plates repeatable by seed', () => {
    const draw = (seed: number, n: number) => {
      const g = new PlateGenerator(seed)
      return Array.from({ length: n }, () => g.next())
    }
    const run = draw(1001, 2000)
    expect(run.every((p) => PLACA_RE.test(p))).toBe(true)
    expect(new Set(run).size).toBe(2000)
    expect(draw(1001, 2000)).toEqual(run)
    expect(draw(1002, 2000)).not.toEqual(run)
  })

  it('C8 hashes the plate with the salt of the simulated hour', () => {
    const seed = 1001
    const h = plateHash('ABC1D23', at(7, 10), seed)
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    // door 4: the first 16 hex of HMAC-SHA-256(salt of the hour, plate)
    const expected = createHmac('sha256', Buffer.from(salt(seed, hourOf(at(7, 10)))))
      .update('ABC1D23')
      .digest('hex')
      .slice(0, 16)
    expect(h).toBe(expected)
    expect(plateHash('ABC1D23', at(7, 50), seed)).toBe(h)
    expect(plateHash('ABC1D23', at(7, 59, 59), seed)).not.toBe(plateHash('ABC1D23', at(8, 0, 0), seed))

    // the entry and the exit camera of a pair hash the same plate alike in the same hour
    const segments = buildSegments(buildCityNetwork())
    const cameras = defaultPlateCameras(segments, STOP_LINE_M).filter((c) => c.trecho === 'I11>I12')
    const set = new PlateCameraSet(cameras, seed)
    const L = segments.find((s) => s.id === 'I11>I12')!.length
    const car = (d: number) => [{ id: 1, placa: 'ABC1D23', classe: 'carro' as const, segmentId: 'I11>I12', distance: d }]
    const entry = set.observe(car(0), at(7, 10)).events
    set.observe(car(L / 2), at(7, 30))
    const exit = set.observe(car(L - 1), at(7, 50)).events
    expect(entry.map((e) => e.cameraId)).toEqual(['C01E'])
    expect(exit.map((e) => e.cameraId)).toEqual(['C01S'])
    expect(entry[0].placaHash).toBe(h)
    expect(exit[0].placaHash).toBe(h)
  })
})
