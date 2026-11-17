import { useEffect, useRef } from 'react'
import type { SimulationEngine } from '../sim/SimulationEngine'
import { drawScene } from './draw'

interface Props {
  engine: SimulationEngine
}

/** Fills its container with a canvas and redraws the simulation on every animation frame. */
export function SimulationCanvas({ engine }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    let width = 0
    let height = 0
    let dpr = 1

    const draw = () => drawScene(ctx, engine.getState(), width, height, dpr)

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

    let frame = 0
    const loop = () => {
      draw()
      frame = requestAnimationFrame(loop)
    }

    resize()
    window.addEventListener('resize', resize)
    frame = requestAnimationFrame(loop)
    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(frame)
    }
  }, [engine])

  return (
    <div ref={wrapRef} className="sim-canvas">
      <canvas ref={canvasRef} aria-label="Mapa da simulação de trânsito" role="img" />
    </div>
  )
}
