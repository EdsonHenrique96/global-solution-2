import type Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-opus-5-5'
export const MAX_TOKENS = 4_000

/** Fixed on the server: the page cannot change what the agent is told or what it may call. */
export const SYSTEM_PROMPT = `Você é o agente de orquestração da central de trânsito de uma cidade.
O operador humano acompanha um painel; você ajuda a decidir e, sobretudo, a explicar.

Regras:
- A cidade é uma grade de 4 alamedas (Santos, Jaú, Itu, Franca) e 4 ruas (Consolação, Bela Cintra,
  Haddock Lobo, Augusta). Cada trecho é um quarteirão num sentido, com id "I12>I13" (de uma esquina
  para a vizinha); cada esquina I11..I44 tem um semáforo com duas fases: H (alameda) e V (rua).
- Os números vêm dos algoritmos determinísticos, nunca de você. Para um desvio, você escolhe só o
  trecho a evitar; o sistema escolhe quais motoristas com app de mapa avisar e por onde. Para um
  semáforo, você propõe um tempo de verde de uma fase; o sistema aplica ou pede aprovação.
- Comece chamando estado_rede. Só proponha ação quando o estado mostrar motivo (trecho
  congestionado, acidente, fila).
- Toda decisão tomada ou recusada recebe uma explicação curta com registrar_explicacao, citando os
  números do estado (velocidade, folga, fila).
- Em todo trecho crítico, acidente ou fila, avalie desvio e semáforos. Se não recomendar desvio,
  registre explicitamente o motivo com os dados: cálculo pendente, ausência de candidatos,
  nenhuma fração eficaz, desvio já ativo ou cenário sem desvio suficiente. Não invente motivos.
- Ações acima dos limites de autonomia vão para aprovação do operador; isso é esperado.
- Se nada precisa mudar, registre uma explicação curta dizendo isso e termine.`

const GRID = [1, 2, 3, 4]
/** Corners I11..I44 of the 4×4 grid. */
export const INTERSECTION_IDS = GRID.flatMap((r) => GRID.map((c) => `I${r}${c}`))
/** Every directed segment between neighbouring corners: 48. */
export const SEGMENT_IDS = GRID.flatMap((r) =>
  GRID.flatMap((c) => {
    const out: string[] = []
    if (c < 4) out.push(`I${r}${c}>I${r}${c + 1}`, `I${r}${c + 1}>I${r}${c}`)
    if (r < 4) out.push(`I${r}${c}>I${r + 1}${c}`, `I${r + 1}${c}>I${r}${c}`)
    return out
  }),
)

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'estado_rede',
    description:
      'Estado atual da rede: os 10 piores trechos (estado, velocidade, densidade, fluxo, capacidade, folga, demanda), trechos com alerta, filas dos semáforos, motoristas com app de mapa ativo, desvio em vigor e métricas.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'propor_desvio',
    description:
      'Propõe avisar, pelo app de mapa, os motoristas que ainda vão passar pelo trecho e têm uma rota pelo menos 10% mais rápida até o destino. O sistema calcula a fração; acima de 30%, a ação aguarda aprovação do operador.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        trecho: { type: 'string', enum: SEGMENT_IDS },
        justificativa: { type: 'string' },
      },
      required: ['trecho', 'justificativa'],
      additionalProperties: false,
    },
  },
  {
    name: 'propor_semaforo',
    description:
      'Propõe o tempo de verde de uma fase (H = alameda, V = rua) de um semáforo para o próximo ciclo. De 10 a 30 s é aplicado; de 31 a 60 s aguarda aprovação; fora disso é recusado.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        intersecao: { type: 'string', enum: INTERSECTION_IDS },
        fase: { type: 'string', enum: ['H', 'V'] },
        verde_s: { type: 'integer' },
        justificativa: { type: 'string' },
      },
      required: ['intersecao', 'fase', 'verde_s', 'justificativa'],
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
