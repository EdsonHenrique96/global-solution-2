export interface Point {
  x: number
  y: number
}

/** A street corner with a traffic light (cidade-cameras-radar door 1). */
export interface Intersection {
  /** `I<linha><coluna>`: linha = alameda (1 Santos .. 4 Franca), coluna = rua (1 Consolação .. 4 Augusta). */
  id: string
  /** "Al. Santos × R. Augusta". */
  nome: string
  lat: number
  lng: number
  /** Metres from I11, x east, y south (north up on screen). */
  position: Point
  row: number
  col: number
}

export interface RoadNetwork {
  intersections: Intersection[]
  /** Box around everything drawn, metres, with a margin. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/** Which way a road runs: along an alameda (H) or along a rua (V). Each is one phase of a light. */
export type Axis = 'H' | 'V'

/** The map apps a driver may have open (door 4). */
export type AppName = 'waze' | 'google-maps' | 'outros'

/** A simulated car. Its trip (entry, exit, path) exists only inside the simulation (AD-038). */
export interface Car {
  id: number
  /** Directed segment ids from entry to exit. */
  path: string[]
  /** Index in `path` of the segment the car is on. */
  seg: number
  /** Metres along the current segment. */
  distance: number
  /** Desired speed, m/s. */
  speed: number
  /** The map app the driver has open, or null. */
  app: AppName | null
  /** Mercosul plate, unique in the run; only the plate cameras read it, and never publish it. */
  placa: string
  classe: 'carro'
  entrada: string
  saida: string
  /** Simulated time the car was generated (travel time includes the wait to enter). */
  bornAtMs?: number
}
