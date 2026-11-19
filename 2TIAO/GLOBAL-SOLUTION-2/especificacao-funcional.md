# Especificação Funcional — Sistema de Gestão e Monitoramento de Trânsito (MVP)

Nov 19, 2026 · @Henrique

## Contexto e objetivo

O MVP é um painel de gestão de tráfego para a prefeitura que mede a velocidade média por trecho via leitura de placas, detecta incidentes por visão computacional e usa um agente LLM para propor ações aos gestores.

- **Problema social:** congestionamento aumenta o tempo de viagem, as emissões de CO₂ e o tempo de resposta a incidentes. Desvios em massa por apps de navegação costumam apenas transferir o congestionamento para outra rota.
- **Público-alvo:** gestores públicos e engenharia de tráfego (centro de controle operacional da cidade). Não é um app de navegação para o motorista.
- **Objetivos:** mais fluidez, menos emissões (ODS 11.6 e ODS 13) e resposta mais rápida a incidentes.
- **Hipótese principal:** notificar apenas uma fração dos motoristas para desviar reduz o tempo médio de viagem e as emissões mais do que notificar todos.
- **Natureza:** projeto de curso do Tecnólogo em Inteligência Artificial, integrando Visão Computacional, Machine Learning, LLM, IoT e Data Mining.

## Escopo do MVP

O MVP roda sobre uma cidade simulada com câmeras fixas (no mínimo 2 por via) e demonstra visualmente, num dashboard, a medição, a detecção de incidentes e as propostas do agente. Drones foram removidos do projeto.

| Item | No MVP | Como |
| --- | --- | --- |
| Malha viária e tráfego | Sim | Mapa de vias simulado já existente no projeto |
| Câmeras e leitura de placas no fluxo | Sim, simulado | Câmeras virtuais geram eventos (placa, timestamp, faixa) |
| OCR de placas | Sim, real | Pipeline rodando em vídeos gravados |
| Incidente: veículo parado na faixa | Sim, real | Detecção + rastreamento em vídeo gravado |
| Incidente: pedestre na pista | Sim, real | Detecção de pessoa + zona proibida em vídeo gravado |
| Velocidade média, fluxo, densidade, capacidade | Sim | Calculados a partir dos eventos |
| Previsão de congestionamento e anomalias | Sim | Modelos de ML treinados com dados da simulação |
| Agente LLM | Sim | Propõe ações; gestor aprova ou rejeita |
| Ajuste de semáforos | Sim, simulado | Agente propõe, gestor aprova, o mapa simulado aplica |
| Notificação de desvio | Sim, simulado | API mock que representa os apps de navegação |
| Acionar agente de trânsito e socorro | Sim, simulado | Proposta registrada no dashboard, sem integração real |
| Hardware real, integração real com Waze/Google, despacho real | Não | Trabalho futuro |
| Acidente, atropelamento, buraco, obstrução geral | Não | Trabalho futuro |
| Drones | Não | Removidos do projeto |

## Versões do protótipo

O recorte mínimo do TCC são as versões V1 a V4: juntas elas já cobrem as cinco matérias e testam a hipótese, com uma demonstração fechada ao final de cada uma. A V5 junta tudo o que amplia o sistema sem mudar a tese.

| Versão | Entrega | Matérias | Demonstração ao final |
| --- | --- | --- | --- |
| V1 — Núcleo de medição | Mapa de vias simulado com 3 ou 4 vias e uma rota alternativa; câmeras virtuais publicando eventos por MQTT; pareamento de placas; velocidade média, fluxo e densidade por trecho; dashboard com mapa colorido e KPIs | IoT, Data Mining | O mapa muda de cor em tempo real conforme o tráfego simulado aumenta |
| V2 — Previsão e desvio parcial | Capacidade da via; previsão com LightGBM; simulação de desvio com frações; API mock de notificação; tempo médio de viagem e CO₂ estimado | Machine Learning, Data Mining | Comparação: sem desvio vs. 100% notificados vs. fração, ou seja, a hipótese testada |
| V3 — Agente que propõe | Agente LLM com tools de leitura e `propor_desvio`; fila de propostas com Aprovar/Rejeitar e justificativa | LLM | O agente prevê o congestionamento, propõe notificar uma fração e o gestor aprova |
| V4 — Visão computacional | OCR de placa e alerta de veículo parado rodando em vídeo gravado; alerta com evidência no dashboard | Visão Computacional | Um vídeo real gera leitura de placas e um alerta de veículo parado |
| V5 — Ampliação | Pedestre na pista; ajuste de semáforo e acionamento de agente/socorro pelo agente; Isolation Forest para anomalias; K-means e padrões históricos; chat de consulta | Todas | Os casos de uso UC02 a UC05 completos |

- **Ordem:** V1 → V2 → V3 dependem uma da outra; a V4 não depende delas e pode ser feita em paralelo (por exemplo, pelo colega de grupo).
- **Se faltar tempo:** a V4 pode entregar só o OCR de placa, sem o alerta de veículo parado, e ainda cobrir Visão Computacional.
- **Ligação entre V4 e V1:** na V4, as leituras do vídeo podem ser publicadas no mesmo tópico MQTT das câmeras virtuais, o que mostra que o núcleo aceita câmera real sem mudança.

## Arquitetura e fluxo de dados

Os dados sobem das câmeras até o dashboard em seis camadas, cada uma associada a uma matéria do curso; o que o gestor aprova volta à simulação como ação.

&#91;embedded content: arquitetura · 6 camadas e o ciclo de atuação\]

O dashboard é o centro do produto: é onde o gestor vê o estado da cidade e decide sobre cada proposta do agente.

## Requisitos funcionais

Os 26 requisitos abaixo estão agrupados por módulo; a coluna Matéria indica a disciplina do curso que cada um exercita.

| ID | Módulo | Requisito | Matéria |
| --- | --- | --- | --- |
| RF01 | Coleta | Cada câmera publica um evento por veículo detectado: id da câmera, hash da placa, timestamp, faixa e classe do veículo | IoT |
| RF02 | Coleta | Os eventos trafegam por um broker MQTT, com um tópico por via | IoT |
| RF03 | Coleta | Os relógios das câmeras são sincronizados (NTP/GPS na arquitetura real; relógio único na simulação) | IoT |
| RF04 | Coleta | Os semáforos recebem comandos de tempo de verde por tópico MQTT | IoT |
| RF05 | Visão | Detectar veículos e pessoas em cada frame | Visão Computacional |
| RF06 | Visão | Rastrear cada veículo entre frames, com identificador único | Visão Computacional |
| RF07 | Visão | Localizar a placa e ler os caracteres por OCR | Visão Computacional |
| RF08 | Visão | Gerar alerta de veículo parado quando um veículo rastreado ficar imóvel na faixa acima de um tempo limite configurável | Visão Computacional |
| RF09 | Visão | Gerar alerta de pedestre na pista quando uma pessoa for detectada dentro da zona de rolamento demarcada | Visão Computacional |
| RF10 | Visão | Anexar ao alerta o frame de evidência e a confiança da detecção | Visão Computacional |
| RF11 | Métricas | Parear a mesma placa entre a câmera de entrada e a de saída do trecho e calcular tempo de viagem e velocidade média do veículo | Data Mining |
| RF12 | Métricas | Calcular por trecho, em janela de 1 minuto: velocidade média do fluxo, fluxo (veículos/min) e densidade (entraram menos saíram) | Data Mining |
| RF13 | Métricas | Classificar o estado do trecho (livre, carregado, congestionado) por clustering do histórico | Data Mining |
| RF14 | Métricas | Identificar padrões de congestionamento por hora e dia da semana | Data Mining |
| RF15 | ML | Estimar a capacidade de cada via (veículos/min) | Machine Learning |
| RF16 | ML | Prever velocidade e fluxo de cada trecho para os próximos 15 e 30 minutos | Machine Learning |
| RF17 | ML | Detectar anomalia no trecho a partir de tempo de viagem e densidade, mesmo fora do campo de visão das câmeras | Machine Learning |
| RF18 | ML | Simular desvios com frações diferentes de motoristas e indicar a menor fração que alivia o trecho sem congestionar a rota alternativa | Machine Learning |
| RF19 | Agente | Receber eventos e alertas e montar uma proposta de ação com justificativa em linguagem natural | LLM |
| RF20 | Agente | Propor ajuste de tempo de verde em semáforos | LLM |
| RF21 | Agente | Propor desvio de rota para uma fração dos motoristas | LLM |
| RF22 | Agente | Propor acionamento de agente de trânsito ou socorro conforme o tipo de incidente | LLM |
| RF23 | Agente | Responder perguntas do gestor sobre o estado atual e o histórico das vias | LLM |
| RF24 | Dashboard | Exibir mapa com trechos coloridos pelo estado e KPIs por trecho | Integração |
| RF25 | Dashboard | Exibir feed de alertas com evidência e fila de ações propostas com Aprovar/Rejeitar | Integração |
| RF26 | Dashboard | Exibir indicadores de impacto: tempo médio de viagem e CO₂ estimado, com e sem intervenção | Integração |

## Modelos e técnicas

O MVP prioriza modelos leves e explicáveis, fáceis de treinar com dados da simulação e de defender na banca; modelos mais pesados ficam como evolução.

| Problema | Técnica no MVP | Por quê | Evolução futura |
| --- | --- | --- | --- |
| Detecção de veículos e pessoas | YOLO (v8 ou v11) pré-treinado | Classes já existem no COCO, sem treino extra | Fine-tuning com imagens locais |
| Rastreamento | ByteTrack | Simples, roda junto do YOLO | — |
| Leitura de placa | Detector de placa (YOLO) + OCR (PaddleOCR ou fast-plate-ocr) | Datasets de placas brasileiras disponíveis (UFPR-ALPR, RodoSol-ALPR) | Modelo treinado para o padrão Mercosul |
| Veículo parado | Regra sobre o rastreamento: deslocamento abaixo de um limite por N segundos | Determinística e fácil de calibrar | Classificador de incidentes |
| Pedestre na pista | Pessoa detectada + polígono da zona de rolamento | Determinística, sem treino | — |
| Estados da via | K-means sobre velocidade, fluxo e densidade | Mostra Data Mining de forma clara | — |
| Capacidade da via | Ajuste do diagrama fundamental (fluxo × densidade) por regressão; capacidade = fluxo máximo antes da queda de velocidade | Base teórica de engenharia de tráfego | Modelo por via com variáveis de contexto |
| Previsão de congestionamento | LightGBM com features de defasagem (últimos minutos, hora, dia da semana) | Rápido, preciso e com importância de variáveis | LSTM ou modelos em grafo (DCRNN, Graph WaveNet) |
| Anomalia no trecho | Isolation Forest sobre tempo de viagem e densidade | Não precisa de dados rotulados | Autoencoder temporal |
| Fração de desvio | Simulação de cenários no mapa simulado (10%, 20%, 30%...) e escolha da menor fração eficaz | Responde diretamente à hipótese | Otimização ou aprendizado por reforço |
| Orquestração e explicação | LLM com tool calling | Cálculos ficam nas tools, o LLM decide e explica | — |

## Agente LLM

No MVP o agente só propõe: toda ação passa pela aprovação do gestor no dashboard, e os cálculos ficam em tools determinísticas, nunca no texto gerado.

| Tool | O que faz | Tipo |
| --- | --- | --- |
| `consultar_trecho` | Retorna velocidade, fluxo, densidade, estado e capacidade de um trecho | Leitura |
| `prever_trecho` | Retorna a previsão para 15 e 30 minutos | Leitura |
| `simular_desvio` | Roda o cenário com uma fração de motoristas e devolve o impacto nos dois trechos | Leitura |
| `propor_ajuste_semaforo` | Cria uma proposta de novo tempo de verde, dentro de limites mínimo e máximo | Ação (aprovação) |
| `propor_desvio` | Cria uma proposta de notificação para uma fração dos motoristas, com a rota alternativa | Ação (aprovação) |
| `propor_acionamento` | Cria uma proposta de envio de agente de trânsito ou socorro | Ação (aprovação) |

**Fluxo de uma proposta**

1. Um alerta ou uma previsão de congestionamento chega ao agente como evento estruturado.
2. O agente consulta as tools de leitura para entender o contexto.
3. O agente cria a proposta, com a justificativa e os números que a sustentam.
4. A proposta aparece na fila do dashboard; o gestor aprova ou rejeita.
5. Se aprovada, o sistema executa (comando ao semáforo no mapa simulado, notificação pela API mock ou registro do acionamento) e passa a medir o efeito.
6. Toda proposta, decisão e resultado fica registrada para auditoria.

**Regras de segurança**

- O agente não executa ação sem aprovação.
- Tempos de semáforo ficam sempre dentro dos limites configurados por cruzamento.
- O agente não tem acesso a placas, apenas a hashes e métricas agregadas.
- A autonomia híbrida (ajustes pequenos executados sem aprovação) fica como evolução após o MVP.

## Casos de uso

Cinco casos de uso cobrem a demonstração do MVP; o ator principal é o gestor de tráfego.

**UC01 — Congestionamento previsto e desvio parcial**

1. O modelo prevê que o trecho A vai passar de 90% da capacidade em 15 minutos.
2. O agente simula desvios de 10%, 20% e 30% para a rota B e escolhe a menor fração que mantém A e B abaixo do limite.
3. O agente propõe: “notificar 20% dos motoristas que entram em A”, com o ganho estimado de tempo e CO₂.
4. O gestor aprova; a API mock notifica a fração; o dashboard mostra a evolução dos dois trechos.

**UC02 — Veículo parado na faixa**

1. A visão computacional detecta um veículo imóvel na faixa acima do tempo limite.
2. O alerta chega ao dashboard com o frame de evidência.
3. Ao mesmo tempo, a densidade do trecho sobe e a velocidade cai, o que confirma o impacto.
4. O agente propõe enviar agente de trânsito e, se a previsão indicar congestionamento, um desvio parcial.

**UC03 — Pedestre na pista**

1. A visão computacional detecta uma pessoa dentro da zona de rolamento.
2. O alerta chega com prioridade alta e o frame de evidência.
3. O agente propõe enviar agente de trânsito e, se houver indicação de atropelamento, socorro.

**UC04 — Ajuste de semáforo**

1. O trecho de chegada a um cruzamento acumula fila enquanto a via transversal está livre.
2. O agente propõe aumentar o tempo de verde da via com fila, dentro dos limites do cruzamento.
3. O gestor aprova; o mapa simulado aplica o novo tempo; o dashboard compara a fila antes e depois.

**UC05 — Consulta do gestor**

1. O gestor pergunta no chat, por exemplo: “por que a Av. X congestionou ontem às 18h?”.
2. O agente consulta o histórico e responde com os números e os eventos do período.

## Requisitos não funcionais e métricas de sucesso

O MVP é considerado bem-sucedido se demonstrar a hipótese do desvio parcial na simulação e detectar os dois incidentes nos vídeos de teste.

**Requisitos não funcionais**

- **RNF01 — Privacidade (LGPD):** a placa vira hash com salt rotativo na própria câmera; o hash é descartado após o pareamento; imagens só são guardadas como evidência de alerta.
- **RNF02 — Latência:** um alerta aparece no dashboard em até alguns segundos após a detecção (valor-alvo a definir no teste).
- **RNF03 — Atualização:** as métricas de cada trecho são atualizadas a cada 1 minuto.
- **RNF04 — Rastreabilidade:** toda proposta do agente registra entradas, números usados, decisão do gestor e resultado.
- **RNF05 — Explicabilidade:** toda proposta traz justificativa em linguagem natural e os dados que a sustentam.
- **RNF06 — Reprodutibilidade:** os cenários do mapa simulado partem das mesmas condições iniciais (mesma demanda e mesma semente aleatória, se houver), para comparar resultados entre execuções.

**Métricas de sucesso**

| Dimensão | Métrica | Como medir |
| --- | --- | --- |
| Hipótese | Tempo médio de viagem e CO₂ estimado: sem desvio vs. 100% notificados vs. fração | Cenários no mapa simulado com as mesmas condições iniciais |
| OCR | Taxa de leitura correta da placa inteira | Vídeos de teste com placas anotadas |
| Incidentes | Precisão e recall de veículo parado e pedestre na pista | Vídeos de teste com eventos anotados |
| Previsão | Erro médio (MAE) da velocidade prevista em 15 e 30 minutos | Dados da simulação separados em treino e teste |
| Anomalia | Tempo entre o início do bloqueio simulado e o alerta | Bloqueios injetados no mapa simulado |
| Agente | Proporção de propostas coerentes com a situação | Avaliação manual de um conjunto de cenários |

## Riscos, limitações e trabalho futuro

O principal limite do MVP é a integração com apps de navegação: até onde se sabe, Waze e Google Maps não oferecem API para notificar uma fração escolhida de motoristas, por isso a notificação é simulada.

| Risco ou limitação | Impacto | Tratamento no MVP |
| --- | --- | --- |
| Sem API pública para notificar parte dos motoristas | Desvio parcial não pode ser feito nos apps reais | API mock; integração via parcerias (ex.: programa de dados para cidades do Waze) como trabalho futuro |
| Câmeras só veem o próprio campo de visão | Incidente entre câmeras não é visto | Detecção indireta por densidade e tempo de viagem (RF17) |
| Erro de OCR quebra o pareamento | Menos amostras de velocidade | Métrica usa amostra; fluxo conta todos os veículos detectados |
| Relógios dessincronizados | Velocidade calculada errada | Sincronização NTP/GPS (RF03) |
| Dados de placa são pessoais | Risco de LGPD | Hash na borda e descarte após pareamento (RNF01) |
| Dados 100% simulados | Resultados podem não se repetir na rua | Declarar a limitação; validar com dados públicos de tráfego no futuro |
| LLM pode propor ação inadequada | Decisão ruim na operação | Aprovação humana obrigatória e limites nas tools |

**Trabalho futuro**

- Hardware real nas vias (câmeras com processamento na borda).
- Integração real com apps de navegação, órgãos de trânsito e serviços de socorro.
- Novos incidentes: acidente, atropelamento, buraco e obstrução geral da pista.
- Modelos em grafo para previsão em toda a malha e aprendizado por reforço para semáforos e desvios.
- Autonomia híbrida do agente, com ajustes pequenos executados sem aprovação.
