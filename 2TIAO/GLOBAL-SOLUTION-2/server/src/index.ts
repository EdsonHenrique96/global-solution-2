import { createServer } from 'node:http'
import { clientFromEnvironment, createHandler } from './handler.js'

const PORT = Number(process.env.PORT ?? 8787)
// loopback by default; the container sets HOST=0.0.0.0 and publishes the port on loopback only
const HOST = process.env.HOST ?? '127.0.0.1'
const client = clientFromEnvironment()
createServer(createHandler(client)).listen(PORT, HOST, () => {
  console.log(`proxy do agente em http://${HOST}:${PORT}${client ? '' : ' (sem credencial: a página roda sem LLM)'}`)
})
