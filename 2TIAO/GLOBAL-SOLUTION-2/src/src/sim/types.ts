export interface Point {
  x: number
  y: number
}

/** Fixed path from the network's origin to its destination. */
export interface Route {
  id: string
  points: Point[]
  intersectionIds: string[]
}

/** Fixed point where a traffic light will sit; no timing logic yet. */
export interface Intersection {
  id: string
  position: Point
}

export interface RoadNetwork {
  /** Logical coordinate space the geometry is drawn in. */
  width: number
  height: number
  origin: Point
  destination: Point
  routes: Route[]
  intersections: Intersection[]
}

export interface Car {
  id: number
  routeId: string
  /** Distance travelled along the route, in network units. */
  distance: number
  /** Network units per second. */
  speed: number
}
