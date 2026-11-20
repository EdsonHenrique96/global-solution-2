export const MODEL = 'openai/gpt-oss-20b'


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
- Para um evento com trecho, as leituras consultar_trecho, prever_trecho e simular_desvio já vêm no histórico. Use seus resultados. Use propor_desvio para registrar a fração calculada, inclusive 0, com os números retornados e a justificativa. Em uma avaliação geral comece chamando estado_rede. Só proponha ação quando o estado mostrar motivo (trecho
  congestionado, acidente, fila).
- Evento fila: use as contagens H e V fornecidas. Com controle adaptativo e fila maior em uma fase, avalie priorizá-la no próximo verde usando propor_semaforo. Com filas equilibradas explique por que manter.
- Semáforo: só proponha ajuste quando conhecer as filas das duas fases. Não alegue aplicação sem retorno da ferramenta.
- Toda decisão tomada ou recusada recebe uma explicação curta com registrar_explicacao, citando os
  números do estado (velocidade, folga, fila).
- Em todo trecho crítico, acidente ou fila, avalie desvio e semáforos. Se não recomendar desvio,
  use registrar_explicacao com decisao='manter_rota' apenas se decidir manter a rota e registre o motivo com os dados: cálculo pendente, ausência de candidatos,
  nenhuma fração eficaz, desvio já ativo ou cenário sem desvio suficiente. Não invente motivos.
- Ações acima dos limites de autonomia vão para aprovação do operador; isso é esperado.
- Se nada precisa mudar, registre uma explicação curta dizendo isso e termine.`

// The simulator validates membership and adjacency locally. Repeating the 48 IDs
// for every tool on every round needlessly consumes the prototype's token quota.
const segmentId = { type: 'string', pattern: '^I[1-4][1-4]>I[1-4][1-4]$' }
const cornerId = { type: 'string', pattern: '^I[1-4][1-4]$' }

export const TOOLS = [
  {
    name: 'estado_rede',
    description:
      'Estado atual da rede: os 10 piores trechos (estado, velocidade, densidade, fluxo, capacidade, folga, demanda), trechos com alerta, filas dos semáforos, motoristas com app de mapa ativo, desvio em vigor e métricas.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  ...[
    ['consultar_trecho', 'Consulta medidas atuais e nível do trecho.'],
    ['prever_trecho', 'Consulta velocidade, fluxo e ocupação previstos em 15 e 30 minutos.'],
    ['simular_desvio', 'Compara sete frações e informa a escolhida.'],
  ].map(([name, description]) => ({ name, description, input_schema: {
    type: 'object', properties: { trecho: segmentId },
    required: ['trecho'], additionalProperties: false,
  } })),
  {
    name: 'propor_desvio',
    description:
      'Propõe avisar, pelo app de mapa, os motoristas que ainda vão passar pelo trecho e têm uma rota pelo menos 10% mais rápida até o destino. Copie escolhida e numeros de simular_desvio; acima de 30%, a ação aguarda aprovação do operador.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        trecho: segmentId,
        fracao: { type: 'number', minimum: 0, maximum: 1 },
        numeros: {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(['ocupacaoAtualPct', 'ocupacaoPrevistaPct', 'ocupacaoAlternativaPct', 'ganhoTempoS', 'ganhoCo2Kg'].map(k => [k, { type: ['number', 'null'] }])),
          required: ['ocupacaoAtualPct', 'ocupacaoPrevistaPct', 'ocupacaoAlternativaPct', 'ganhoTempoS', 'ganhoCo2Kg'],
        },
        justificativa: { type: 'string' },
      },
      required: ['trecho', 'fracao', 'justificativa', 'numeros'],
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
        intersecao: cornerId,
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
      properties: { texto: { type: 'string' }, decisao: { type: 'string', enum: ['manter_rota'], description: 'Opcional, somente para a decisão explícita de não desviar o trecho avaliado.' } },
      required: ['texto'],
      additionalProperties: false,
    },
  },
]
