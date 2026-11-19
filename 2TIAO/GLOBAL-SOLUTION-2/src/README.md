# Trânsito inteligente — simulação

## Rodar

```bash
docker compose up -d     # na pasta acima: broker Mosquitto (mqtt :1883, websocket :9001)
npm install
npm run dev
```

A página publica a telemetria dos drones em `transito/drones/<droneId>/telemetria` no broker de
`VITE_MQTT_URL` (padrão `ws://localhost:9001`). Sem broker, a simulação roda e o painel mostra
"MQTT desconectado — tentando reconectar".

Agente LLM (opcional): o proxy em `../server` guarda a chave e fala com a API da Anthropic.

```bash
cd .. && ANTHROPIC_API_KEY=... docker compose up -d --build agente   # :8787; o Vite encaminha /api para ele
```

Para rodar sem Docker, veja o [DEVELOPMENT.md](../DEVELOPMENT.md).

Sem o proxy ou sem chave, o painel mostra "modo sem LLM" e as mesmas regras rodam com explicações
por modelo de texto.

Testes: `npm run test` (unitários) e `npm run test:integration` (precisam do broker no ar); no
servidor, `npm test --prefix ../server`.

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
