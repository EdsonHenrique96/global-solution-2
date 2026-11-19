# Desenvolvimento

Como rodar o projeto localmente. Para o propósito, as funcionalidades e a arquitetura, veja o
[GETTING_STARTED.md](GETTING_STARTED.md).

## Requisitos

- Node.js 24+
- Docker (para o broker MQTT e o agente LLM)

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

## 2. Painel (frontend)

```bash
cd src
npm install
npm run dev
```

Abra a URL que o Vite mostrar (normalmente http://localhost:5173).

## 3. Agente LLM fora do Docker (opcional)

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
```

## Parar

```bash
docker compose down
```
