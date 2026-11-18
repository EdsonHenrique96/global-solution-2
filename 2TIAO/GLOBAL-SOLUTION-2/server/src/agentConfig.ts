import type Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-opus-5-5'
export const MAX_TOKENS = 4_000

/** Fixed on the server: the page cannot change what the agent is told or what it may call. */
export const SYSTEM_PROMPT = `Você é o agente de orquestração da central de trânsito de uma cidade.
O operador humano acompanha um painel; você ajuda a decidir e, sobretudo, a explicar.

Regras:
- Os números vêm dos algoritmos determinísticos, nunca de você. Para um desvio, você escolhe só a
  rota de origem e a de destino; o sistema calcula quantos carros desviar. Para um semáforo, você
  propõe um tempo de verde; o sistema aplica ou pede aprovação conforme os limites.
- Comece chamando estado_rede. Só proponha ação quando o estado mostrar motivo (rota
  congestionada, acidente, fila).
- Toda decisão tomada ou recusada recebe uma explicação curta com registrar_explicacao, citando os
  números do estado (velocidade, folga, fila).
- Ações acima dos limites de autonomia vão para aprovação do operador; isso é esperado.
- Se nada precisa mudar, registre uma explicação curta dizendo isso e termine.`

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'estado_rede',
    description:
      'Estado atual da rede: por rota (estado, velocidade, fluxo, capacidade, folga, demanda), trechos com alerta, filas dos semáforos, desvio em vigor e métricas.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'propor_desvio',
    description:
      'Propõe desviar parte dos carros que ainda vão entrar na rota "de" para a rota "para". O sistema calcula N e a fração; acima de 30% dos carros, a ação aguarda aprovação do operador.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        de: { type: 'string', enum: ['central', 'norte', 'sul'] },
        para: { type: 'string', enum: ['central', 'norte', 'sul'] },
        justificativa: { type: 'string' },
      },
      required: ['de', 'para', 'justificativa'],
      additionalProperties: false,
    },
  },
  {
    name: 'propor_semaforo',
    description:
      'Propõe o tempo de verde de um semáforo para o próximo ciclo. De 10 a 30 s é aplicado; de 31 a 60 s aguarda aprovação; fora disso é recusado.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        intersecao: { type: 'string', enum: ['I1', 'I2', 'I3', 'I4'] },
        verde_s: { type: 'integer' },
        justificativa: { type: 'string' },
      },
      required: ['intersecao', 'verde_s', 'justificativa'],
      additionalProperties: false,
    },
  },
  {
    name: 'registrar_explicacao',
    description: 'Registra no log do operador a explicação de uma decisão, em uma ou duas frases.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { texto: { type: 'string' } },
      required: ['texto'],
      additionalProperties: false,
    },
  },
]
