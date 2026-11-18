import { useEffect, useRef } from 'react'
import type { RouteStatus } from '../capacity/CapacityModel'
import type { SimulationEngine } from '../sim/SimulationEngine'
import { distanceToSegment, droneGrabRadius, drawScene, fitTransform, ROUTE_PICK_PX } from './draw'

interface Props {
  engine: SimulationEngine
  /** Read on every frame: the state of each route. */
  routeStatus?: () => Record<string, RouteStatus>
  selectedRoute?: string
  onSelectRoute?: (routeId: string) => void
}

/**
 * Fills its container with a canvas and redraws the simulation on every animation frame.
 * A drone can be dragged with the mouse; it is dropped where the button is released.
 */
export function SimulationCanvas({ engine, routeStatus, selectedRoute, onSelectRoute }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Latest props for the long-lived listeners and frame loop below.
  const overlayRef = useRef({ routeStatus, selectedRoute, onSelectRoute })
  useEffect(() => {
    overlayRef.current = { routeStatus, selectedRoute, onSelectRoute }
  })

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    let width = 0
    let height = 0
    let dpr = 1

    const draw = () => {
      const { routeStatus: status, selectedRoute: selected } = overlayRef.current
      drawScene(ctx, engine.getState(), width, height, dpr, {
        routeStatus: status?.(),
        selectedRoute: selected,
      })
    }

    const resize = () => {
      width = wrap.clientWidth
      height = wrap.clientHeight
      dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      draw()
    }

    const toNetwork = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const fit = fitTransform(engine.getState().network, width, height)
      return { fit, point: fit.unmap({ x: e.clientX - rect.left, y: e.clientY - rect.top }) }
    }

    let dragging: string | null = null
    const onMove = (e: MouseEvent) => {
      if (!dragging) return
      engine.moveDrone(dragging, toNetwork(e).point)
      draw()
    }
    const onUp = (e: MouseEvent) => {
      onMove(e)
      dragging = null
      canvas.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    const pickRoute = (fit: ReturnType<typeof fitTransform>, point: { x: number; y: number }) => {
      const onSelect = overlayRef.current.onSelectRoute
      if (!onSelect) return
      const screen = fit.map(point)
      const nearest = engine
        .getState()
        .network.routes.map((route) => {
          let best = Infinity
          for (let i = 1; i < route.points.length; i++) {
            best = Math.min(best, distanceToSegment(screen, fit.map(route.points[i - 1]), fit.map(route.points[i])))
          }
          return { id: route.id, dist: best }
        })
        .filter(({ dist }) => dist <= ROUTE_PICK_PX)
        .sort((a, b) => a.dist - b.dist)[0]
      if (nearest) {
        onSelect(nearest.id)
        draw()
      }
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const { fit, point } = toNetwork(e)
      const grab = droneGrabRadius(fit.scale) / (fit.scale || 1)
      const hit = engine
        .getState()
        .drones.map((d) => ({ d, dist: Math.hypot(d.position.x - point.x, d.position.y - point.y) }))
        .filter(({ dist }) => dist <= grab)
        .sort((a, b) => a.dist - b.dist)[0]
      if (!hit) {
        pickRoute(fit, point)
        return
      }
      e.preventDefault()
      dragging = hit.d.id
      canvas.style.cursor = 'grabbing'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    let frame = 0
    const loop = () => {
      draw()
      frame = requestAnimationFrame(loop)
    }

    resize()
    window.addEventListener('resize', resize)
    canvas.addEventListener('mousedown', onDown)
    frame = requestAnimationFrame(loop)
    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('mousedown', onDown)
      cancelAnimationFrame(frame)
    }
  }, [engine])

  return (
    <div ref={wrapRef} className="sim-canvas">
      <canvas ref={canvasRef} aria-label="Mapa da simulação de trânsito" role="img" />
    </div>
  )
}
