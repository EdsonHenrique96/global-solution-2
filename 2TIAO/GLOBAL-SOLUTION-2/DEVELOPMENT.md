# Desenvolvimento

Como rodar o projeto localmente. Para o propósito, as funcionalidades e a arquitetura, veja o
[GETTING_STARTED.md](GETTING_STARTED.md).

## Requisitos

- Node.js 24+
- Docker (para o broker MQTT, o agente LLM e o serviço de ML)

## 1. Broker MQTT e agente LLM

Na raiz do repositório:

```bash
export ANTHROPIC_API_KEY=sua-chave   # opcional
docker compose up -d --build
```

Sobe dois containers:

- **Mosquitto** (`transito-mosquitto`): MQTT em `localhost:1883` e WebSocket em `localhost:9001`.
- **Proxy do agente** (`transito-agente`): `localhost:8787`. O Vite encaminha `/api` para ele, e a
  chave fica só no container, nunca no navegador.

Os dois são opcionais. Sem o broker, a simulação roda e o painel avisa que o MQTT está
desconectado. Sem o proxy ou sem a chave, o painel entra em "modo sem LLM" e aplica as mesmas
regras. A chave também pode ficar num arquivo `.env` na raiz (não versione esse arquivo).

Para subir só um deles: `docker compose up -d mosquitto` ou `docker compose up -d --build agente`.
Depois de mudar o código em `server/`, rode `docker compose up -d --build agente` de novo.

## 2. Serviço de ML (previsão e K-means)

O container `transito-ml` (pasta `ml/`, Python 3.12, FastAPI, LightGBM, scikit-learn) responde em
`localhost:8788`; o Vite encaminha `/ml` para ele. Ele precisa de um modelo treinado com os dados da
simulação. Na raiz do repositório:

```bash
cd src && npm install && npm run dataset -- --episodios 200 --semente 1 && cd ..   # data/treino/metricas.csv (~3 min)
docker compose build ml
docker compose run --rm ml python -m ml.treinar   # grava ml/modelos/ e mostra o MAE
docker compose up -d --build ml
```

- `npm run dataset` roda episódios de 45 min simulados sem a página (curva de demanda por hora e dia,
  acidente em metade deles); a mesma semente gera o mesmo arquivo. `--saida arquivo.csv` grava em
  outro lugar.
- `python -m ml.treinar` lê `data/treino/metricas.csv`, separa treino e teste por episódio (80/20),
  treina 4 LightGBM (velocidade e fluxo para 15 e 30 min) e o K-means (k = 4), e grava em
  `ml/modelos/` os modelos, `metricas.json` (MAE do modelo e da persistência) e `kmeans.json`.
  Retreinar com o serviço no ar não exige reiniciar: ele relê os modelos.
- `GET /ml/saude` diz qual modelo está carregado (`modelo: null` sem treino); sem modelo,
  `/ml/prever` e `/ml/kmeans` respondem `503`.
- Os dados e os modelos gerados ficam fora do git.

Sem o serviço, o painel funciona: "Via selecionada" mostra "Previsão indisponível" e o mapa é
classificado pela regra ("classificação por regra", com "Tentar de novo" na legenda). O container
grava como o usuário `1000:1000`; outro UID: `ML_UID=$(id -u) ML_GID=$(id -g) docker compose ...`.

## 3. Painel (frontend)

```bash
cd src
npm install
npm run dev
```

Abra a URL que o Vite mostrar (normalmente http://localhost:5173).

A simulação das frações de desvio roda num Web Worker (`src/decision/fractionWorker.ts`), sem
configuração: o Vite o empacota à parte (`dist/assets/fractionWorker-*.js` no `npm run build`).
Enquanto ele calcula, o painel do desvio mostra "calculando a fração…" e a simulação continua. Nos
testes e nos experimentos (Node, sem `Worker`) o mesmo cálculo roda na própria thread.

Para ver o desvio de um acidente: crie um acidente numa via com câmeras, espere o aviso "Possível
incidente" na lista de Incidentes e clique em **Confirmar incidente**. Até a V4, essa confirmação é
do operador.

## 4. Agente LLM fora do Docker (opcional)

Para desenvolver o proxy sem rebuild da imagem, pare o container e rode direto:

```bash
docker compose stop agente
cd server
npm install
npm run build
ANTHROPIC_API_KEY=sua-chave npm start
```

Fora do Docker, o proxy escuta em `127.0.0.1:8787`.

## Variáveis de ambiente

| Variável | Onde | Padrão |
| --- | --- | --- |
| `VITE_MQTT_URL` | `src` | `ws://localhost:9001` |
| `ANTHROPIC_API_KEY` | `server` | sem padrão (sem ela, o painel usa o modo sem LLM) |
| `ANTHROPIC_AUTH_TOKEN` | `server` | alternativa à chave, só fora do Docker (o `docker-compose.yml` repassa apenas `ANTHROPIC_API_KEY`) |
| `PORT` | `server` | `8787` |
| `HOST` | `server` | `127.0.0.1` (no container, `0.0.0.0`) |

## Testes

```bash
cd src
npm test                   # testes unitários
npm run test:integration   # precisa do broker no ar
npm run build && npm run lint

cd ../server
npm test

cd ..
docker compose run --rm --no-deps ml python -m pytest -p no:cacheprovider ml/tests -v
# depois de gerar o CSV da semente 1 e treinar (seção 2): confere o dataset e o modelo treinado
docker compose run --rm --no-deps ml python -m pytest -p no:cacheprovider ml/tests_treino -v
```

Os testes dos experimentos (`src/experiments/experiments.test.ts`) rodam rodadas inteiras de 25 min
simulados e levam alguns segundos cada; a suíte unitária completa leva cerca de 2 min.

## Parar

```bash
docker compose down
```
