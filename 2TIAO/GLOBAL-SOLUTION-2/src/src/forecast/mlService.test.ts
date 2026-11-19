import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Vitest runs from the frontend folder; the compose file is at the project root. */
const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8')

describe('ml service', () => {
  it('C12 compose runs ml on 127.0.0.1:8788 and Vite proxies /ml', () => {
    const compose = read('docker-compose.yml')
    // the ml service block: from "  ml:" to the next top-level service or the end
    const start = compose.indexOf('\n  ml:\n')
    expect(start).toBeGreaterThan(-1)
    const rest = compose.slice(start + 1)
    const next = rest.slice(1).search(/\n {2}[a-z]/)
    const block = next === -1 ? rest : rest.slice(0, next + 2)
    expect(block).toMatch(/\n {4}image: transito-ml\n/)
    expect(block).toMatch(/\n {4}container_name: transito-ml\n/)
    expect(block).toMatch(/\n {4}build: \.\/ml\n/)
    expect(block).toMatch(/\n {6}- "127\.0\.0\.1:8788:8788"\n/)
    expect(block).toMatch(/\n {6}- \.\/ml\/modelos:\/app\/ml\/modelos\n/)
    expect(block).toMatch(/\n {6}- \.\/data:\/app\/data\n/)
    const vite = read('src/vite.config.ts')
    expect(vite).toContain(`'/ml': 'http://127.0.0.1:8788'`)
    expect(vite).toContain(`'/api': 'http://127.0.0.1:8787'`)
  })
})
