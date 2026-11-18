import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { createMqttTransport, DEFAULT_MQTT_URL } from './telemetry/MqttTransport'

const transport = createMqttTransport(import.meta.env.VITE_MQTT_URL ?? DEFAULT_MQTT_URL)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
)
