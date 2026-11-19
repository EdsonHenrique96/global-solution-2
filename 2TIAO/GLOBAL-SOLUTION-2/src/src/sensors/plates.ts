import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { mulberry32, type Rng } from '../sim/random'

/** A Mercosul plate: three letters, a digit, a letter, two digits (door 4). */
export const PLACA_RE = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/

/** The salt changes every simulated hour, the same on every camera (single clock, RF03). */
export const SALT_PERIOD_MS = 3_600_000

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Draws the plates of one run from its seed: same seed, same sequence; never the same plate twice. */
export class PlateGenerator {
  private rng: Rng
  private used = new Set<string>()

  constructor(seed: number) {
    this.rng = mulberry32(seed * 31_337 + 11)
  }

  /** A copy that draws the plates this one would draw next. */
  clone(): PlateGenerator {
    const c = new PlateGenerator(0)
    c.rng = this.rng.clone()
    c.used = new Set(this.used)
    return c
  }

  private draw(): string {
    const letter = () => LETTERS[Math.floor(this.rng() * 26)]
    const digit = () => String(Math.floor(this.rng() * 10))
    return letter() + letter() + letter() + digit() + letter() + digit() + digit()
  }

  next(): string {
    let placa = this.draw()
    while (this.used.has(placa)) placa = this.draw()
    this.used.add(placa)
    return placa
  }
}

/** The simulated hour a timestamp falls in. */
export const hourOf = (ts: number) => Math.floor(ts / SALT_PERIOD_MS)

/** The salt of one simulated hour, derived from the run's seed. */
export function salt(seed: number, hora: number): Uint8Array {
  return sha256(utf8ToBytes(`transito-sal:${seed}:${hora}`))
}

/** `placaHash`: the first 16 hex of HMAC-SHA-256(salt of the hour, plate) (door 4). */
export function plateHash(placa: string, ts: number, seed: number): string {
  return bytesToHex(hmac(sha256, salt(seed, hourOf(ts)), utf8ToBytes(placa))).slice(0, 16)
}
