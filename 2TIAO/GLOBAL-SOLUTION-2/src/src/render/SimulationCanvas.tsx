import { useEffect, useRef } from 'react'
import { pointOnSegment } from '../sensors/segments'
import type { SimulationEngine } from '../sim/SimulationEngine'
import {
  BLOCKAGE_PICK_PX,
  clampView,
  CORNER_PICK_PX,
  distanceToSegment,
  drawScene,
  fitTransform,
  ROUTE_PICK_PX,
  type MapView,
} from './draw'
import type { Nivel } from './levels'

export type IncidentMode = 'acidente' | 'obra' | 'semaforo'

/** Where a click in an incident mode landed: a point on a segment, or a corner ("Semáforo"). */
export type IncidentTarget = { segmentId: string; distance: number } | { intersectionId: string }

interface Props {
  engine: SimulationEngine
  /** Read on every frame: the density level of each road segment. */
  segmentLevel?: () => Record<string, Nivel>
  selectedSegment?: string
  onSelectSegment?: (segmentId: string) => void
  /** The "Densidade" layer (on by default). */
  density?: boolean
  view?: MapView
  /** Dragging the map while zoomed in moves the view. */
  onPan?: (view: MapView) => void
  /** In an incident mode a click creates that incident; in "acidente" a click on a marker removes it. */
  incidentMode?: IncidentMode | null
  onIncident?: (mode: IncidentMode, target: IncidentTarget) => void
  onRemoveBlockage?: (id: number) => void
  /** The segment under the mouse (null when none), with the mouse position in the canvas, px. */
  onHoverSegment?: (hover: { segmentId: string; x: number; y: number } | null) => void
  /** The canvas size in CSS pixels, on mount and on every resize. */
  onResize?: (width: number, height: number) => void
}

/** Pointer travel (px) below which a press and release on the map is a click, not a drag. */
const CLICK_SLOP_PX = 4

/**
 * Fills its container with a canvas and redraws the simulation on every animation frame.
 * The cameras are fixed (AD-076): a press on one is a press on the map. Zoomed in, dragging the
 * map moves the view.
 */
export function SimulationCanvas(props: Props) {
  const { engine } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Latest props for the long-lived listeners and frame loop below.
  const propsRef = useRef(props)
  useEffect(() => {
    propsRef.current = props
  })

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    let width = 0
    let height = 0
    let dpr = 1
    // the view while a drag moves it, ahead of the page's next render
    let panView: MapView | null = null
    const currentView = () => panView ?? propsRef.current.view

    const draw = () => {
      const p = propsRef.current
      drawScene(ctx, engine.getState(), width, height, dpr, {
        segmentLevel: p.segmentLevel?.(),
        selectedSegment: p.selectedSegment,
        density: p.density,
        view: currentView(),
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
      propsRef.current.onResize?.(width, height)
      draw()
    }

    const fitNow = () => fitTransform(engine.getState().network, width, height, currentView())
    const toNetwork = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const fit = fitNow()
      return { fit, point: fit.unmap({ x: e.clientX - rect.left, y: e.clientY - rect.top }) }
    }

    const nearestSegment = (fit: ReturnType<typeof fitTransform>, point: { x: number; y: number }) => {
      const screen = fit.map(point)
      return engine
        .getState()
        .segments.map((segment) => {
          let best = Infinity
          for (let i = 1; i < segment.points.length; i++) {
            best = Math.min(best, distanceToSegment(screen, fit.map(segment.points[i - 1]), fit.map(segment.points[i])))
          }
          return { segment, dist: best }
        })
        .filter(({ dist }) => dist <= ROUTE_PICK_PX)
        .sort((a, b) => a.dist - b.dist)[0]?.segment
    }

    const pickSegment = (fit: ReturnType<typeof fitTransform>, point: { x: number; y: number }) => {
      const onSelect = propsRef.current.onSelectSegment
      const segment = nearestSegment(fit, point)
      if (onSelect && segment) {
        onSelect(segment.id)
        draw()
      }
    }

    const incident = (mode: IncidentMode, fit: ReturnType<typeof fitTransform>, point: { x: number; y: number }) => {
      const { onIncident: add, onRemoveBlockage: remove } = propsRef.current
      const state = engine.getState()
      const screen = fit.map(point)
      if (mode === 'semaforo') {
        const corner = state.network.intersections
          .map((i) => ({ i, d: Math.hypot(fit.map(i.position).x - screen.x, fit.map(i.position).y - screen.y) }))
          .filter(({ d }) => d <= CORNER_PICK_PX)
          .sort((a, b) => a.d - b.d)[0]
        if (corner) add?.(mode, { intersectionId: corner.i.id })
        draw()
        return
      }
      if (mode === 'acidente') {
        const hit = state.blockages.find((b) => {
          const segment = state.segments.find((s) => s.id === b.segmentId)
          if (!segment) return false
          const c = fit.map(pointOnSegment(segment, b.distance))
          return Math.hypot(c.x - screen.x, c.y - screen.y) <= BLOCKAGE_PICK_PX
        })
        if (hit) {
          remove?.(hit.id)
          draw()
          return
        }
      }
      const segment = nearestSegment(fit, point)
      if (segment) {
        // where along the segment the click fell, metres
        const [a, b] = segment.points
        const t = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (segment.length * segment.length)
        add?.(mode, { segmentId: segment.id, distance: Math.min(1, Math.max(0, t)) * segment.length })
      }
      draw()
    }

    const click = (e: MouseEvent) => {
      const { fit, point } = toNetwork(e)
      const mode = propsRef.current.incidentMode
      if (mode) incident(mode, fit, point)
      else pickSegment(fit, point)
    }

    // Zoomed in: a press on the map either clicks (released in place) or drags the view.
    let pan: { x: number; y: number; moved: boolean; start: MouseEvent } | null = null
    const onPanMove = (e: MouseEvent) => {
      if (!pan) return
      const dx = e.clientX - pan.x
      const dy = e.clientY - pan.y
      if (!pan.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return
      pan.moved = true
      const view = currentView()
      if (!view || view.zoom <= 1) return
      const next = clampView(engine.getState().network, { zoom: view.zoom, center: fitNow().dragCenter(dx, dy) })
      pan.x = e.clientX
      pan.y = e.clientY
      panView = next
      propsRef.current.onPan?.(next)
      draw()
    }
    const onPanUp = (e: MouseEvent) => {
      onPanMove(e)
      if (pan && !pan.moved) click(pan.start)
      pan = null
      panView = null
      canvas.style.cursor = ''
      window.removeEventListener('mousemove', onPanMove)
      window.removeEventListener('mouseup', onPanUp)
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if ((currentView()?.zoom ?? 1) > 1) {
        e.preventDefault()
        pan = { x: e.clientX, y: e.clientY, moved: false, start: e }
        canvas.style.cursor = 'grabbing'
        window.addEventListener('mousemove', onPanMove)
        window.addEventListener('mouseup', onPanUp)
        return
      }
      click(e)
    }

    let frame = 0
    const loop = () => {
      draw()
      frame = requestAnimationFrame(loop)
    }

    const onHover = (e: MouseEvent) => {
      const report = propsRef.current.onHoverSegment
      if (!report || pan) return
      const { fit, point } = toNetwork(e)
      const segment = nearestSegment(fit, point)
      const rect = canvas.getBoundingClientRect()
      report(segment ? { segmentId: segment.id, x: e.clientX - rect.left, y: e.clientY - rect.top } : null)
    }
    const onLeave = () => propsRef.current.onHoverSegment?.(null)

    resize()
    window.addEventListener('resize', resize)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onHover)
    canvas.addEventListener('mouseleave', onLeave)
    frame = requestAnimationFrame(loop)
    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onPanMove)
      window.removeEventListener('mouseup', onPanUp)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onHover)
      canvas.removeEventListener('mouseleave', onLeave)
      cancelAnimationFrame(frame)
    }
  }, [engine])

  return (
    <div ref={wrapRef} className="sim-canvas">
      <canvas ref={canvasRef} aria-label="Mapa da cidade: vias coloridas pela densidade e semáforos" role="img" />
    </div>
  )
}
