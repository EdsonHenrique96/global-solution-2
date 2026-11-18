import { createServer } from 'node:http'
import { clientFromEnvironment, createHandler } from './handler.js'

const PORT = Number(process.env.PORT ?? 8787)
const client = clientFromEnvironment()
createServer(createHandler(client)).listen(PORT, '127.0.0.1', () => {
  console.log(`proxy do agente em http://127.0.0.1:${PORT}${client ? '' : ' (sem credencial: a página roda sem LLM)'}`)
})
