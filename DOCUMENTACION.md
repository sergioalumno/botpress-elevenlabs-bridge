# 🤖📞 Botpress + Twilio + ElevenLabs — Voice Bridge

Servidor middleware en Node.js que permite a un bot de **Botpress** hablar por teléfono usando **Twilio** (llamadas) y **ElevenLabs** (voz de alta calidad).

Haces un `curl` o petición POST → el bot te llama → tú hablas → el bot te responde con voz natural de ElevenLabs.

---

## 📋 Índice

1. [Arquitectura](#-arquitectura)
2. [Requisitos Previos](#-requisitos-previos)
3. [Obtener las Credenciales](#-obtener-las-credenciales)
4. [Instalación](#-instalación)
5. [Configuración Básica](#️-configuración-básica)
6. [Configuración Avanzada de Voz (ElevenLabs)](#️-configuración-avanzada-de-voz-elevenlabs)
7. [Arrancar el Proyecto](#-arrancar-el-proyecto)
8. [Hacer una Llamada](#-hacer-una-llamada)
9. [Endpoints de la API](#-endpoints-de-la-api)
10. [Estructura del Código](#-estructura-del-código)
11. [Troubleshooting](#-troubleshooting)
12. [Despliegue en Producción](#-despliegue-en-producción)

---

## 🏗 Arquitectura

```
┌─────────┐    curl POST     ┌──────────────────┐
│   Tú    │ ──────────────►  │  Tu Servidor     │
│ (curl)  │                  │  (Node.js:3000)  │
└─────────┘                  └────────┬─────────┘
                                      │
                              Twilio API call
                                      │
                                      ▼
                             ┌────────────────┐
                             │    Twilio       │
                             │  (Cloud PBX)    │
                             └───┬────────┬───┘
                                 │        │
                    Te llama     │        │  Pide TwiML a tu servidor
                    al teléfono  │        │  (via ngrok/producción)
                                 │        │
                                 ▼        ▼
                           ┌──────────────────────────────────┐
                           │       Tu Servidor (via ngrok)    │
                           │                                  │
                           │  1. Devuelve TwiML con           │
                           │     ConversationRelay config     │
                           │                                  │
                           │  2. Twilio abre WebSocket (wss)  │
                           │     hacia tu servidor            │
                           │                                  │
                           │  3. Tú hablas → Twilio transcribe│
                           │     → Tu servidor recibe texto   │
                           │                                  │
                           │  4. Tu servidor envía texto      │
                           │     a Botpress (HTTP API)        │
                           │                                  │
                           │  5. Botpress responde (SSE)      │
                           │     → Tu servidor recibe texto   │
                           │                                  │
                           │  6. Tu servidor envía respuesta  │
                           │     por WebSocket a Twilio       │
                           │                                  │
                           │  7. Twilio convierte texto a voz │
                           │     usando ElevenLabs (TTS)      │
                           │     → Tú escuchas la respuesta   │
                           └──────────────────────────────────┘
```

### Flujo resumido

```
Tú hablas → Twilio (STT) → Texto → Tu Servidor → Botpress → Respuesta
                                                                  │
Tú escuchas ← Twilio ← ElevenLabs (TTS) ← Tu Servidor ←─────────┘
```

### Tecnologías

| Componente | Función | Protocolo |
|---|---|---|
| **Twilio** | Llamadas telefónicas + STT (transcripción) | HTTP + WebSocket |
| **Twilio ConversationRelay** | Puente entre llamada y WebSocket | WebSocket (wss) |
| **Botpress** | Lógica del bot / IA conversacional | HTTP REST + SSE |
| **ElevenLabs** | Text-to-Speech (voz natural) | Gestionado por Twilio |
| **ngrok** | Túnel público a tu localhost | HTTPS / WSS |
| **Node.js + Express** | Servidor middleware | HTTP + WebSocket |

---

## ✅ Requisitos Previos

Antes de empezar necesitas tener instalado y/o creada una cuenta en:

### Software

| Software | Versión mínima | Instalación |
|---|---|---|
| **Node.js** | v18+ | [nodejs.org](https://nodejs.org/) |
| **npm** | v9+ | Viene con Node.js |
| **ngrok** | Cualquiera | [ngrok.com/download](https://ngrok.com/download) |

### Cuentas

| Servicio | Para qué | URL |
|---|---|---|
| **Twilio** | Llamadas telefónicas | [twilio.com](https://www.twilio.com/) |
| **Botpress** | Bot de IA | [botpress.com](https://botpress.com/) |
| **ElevenLabs** | Voz TTS | [elevenlabs.io](https://elevenlabs.io/) |
| **ngrok** | Túnel público | [ngrok.com](https://ngrok.com/) |

---

## 🔑 Obtener las Credenciales

### 1. Twilio

1. Ve a [console.twilio.com](https://console.twilio.com/)
2. En el Dashboard, copia:
   - **Account SID** (empieza con `AC...`)
   - **Auth Token**
3. En **Phone Numbers → Manage → Active Numbers**, copia tu número de Twilio (formato `+1XXXXXXXXXX`)

> ⚠️ **Importante**: Tu cuenta de Twilio necesita tener habilitado **ConversationRelay** y el addon de **ElevenLabs**. Si usas una cuenta trial, solo puedes llamar a números verificados.

### 2. ElevenLabs

1. Ve a [elevenlabs.io](https://elevenlabs.io/)
2. En el menú lateral, ve a **Voices**
3. Elige una voz (o clona la tuya) y copia el **Voice ID**
   - Click en la voz → el Voice ID aparece en la URL o en los detalles

> 💡 **Tip**: No necesitas API Key de ElevenLabs porque Twilio se conecta directamente a ElevenLabs usando ConversationRelay. Solo necesitas el Voice ID.

### 3. Botpress

1. Ve a [app.botpress.cloud](https://app.botpress.cloud/)
2. Abre tu bot en **Botpress Studio**
3. Ve a **Integraciones** (panel izquierdo) → busca **Chat** → instálalo si no está
4. En la configuración del Chat integration, copia el **Webhook ID**
   - Es el UUID que aparece en la URL del webhook (formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### 4. ngrok

1. Crea cuenta en [ngrok.com](https://ngrok.com/)
2. Instala ngrok y autentícate:
   ```bash
   ngrok config add-authtoken TU_TOKEN
   ```
3. (Opcional, recomendado) Si tienes plan de pago, configura un dominio fijo:
   ```bash
   ngrok http 3000 --domain=tu-dominio.ngrok-free.dev
   ```

---

## 📦 Instalación

### Opción A: Reutilizar para otro bot (clonar desde GitHub)

Si ya subiste este proyecto a GitHub, simplemente clónalo:

```bash
git clone https://github.com/TU-USUARIO/botpress-elevenlabs-bridge.git
cd botpress-elevenlabs-bridge
npm install
```

Luego crea el `.env` con las credenciales del nuevo bot:

```bash
cp .env.example .env
# Edita .env con las credenciales del nuevo bot
```

### Opción B: Primera vez (ya tienes los archivos)

Si ya tienes la carpeta del proyecto en tu máquina, simplemente instala las dependencias:

```bash
cd botpress-elevenlabs-bridge
npm install
```

### Dependencias que se instalan

| Paquete | Función |
|---|---|
| `express` | Servidor HTTP (endpoints REST) |
| `ws` | Servidor WebSocket (comunicación con Twilio) |
| `twilio` | SDK de Twilio (iniciar llamadas) |
| `dotenv` | Cargar variables de entorno desde `.env` |

---

## ⚙️ Configuración Básica

### 1. Crea el archivo `.env`

```bash
cp .env.example .env
```

### 2. Rellena los valores

Abre `.env` con tu editor y rellena **todos** los campos básicos:

```env
# Puerto del servidor
PORT=3000

# TWILIO
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_FROM=+1XXXXXXXXXX       # Tu número de Twilio
TWILIO_PHONE_TO=+34XXXXXXXXX         # Tu número personal

# ELEVENLABS
ELEVENLABS_VOICE_ID=xxxxxxxxxxxxxxxxxxx

# BOTPRESS
BOTPRESS_WEBHOOK_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# URL PÚBLICA (se rellena después de arrancar ngrok)
SERVER_PUBLIC_URL=wss://tu-dominio.ngrok-free.dev
```

> ⚠️ **La `SERVER_PUBLIC_URL` debe empezar con `wss://`**, no con `https://`. El servidor la convierte automáticamente a `https://` cuando es necesario para los callbacks HTTP.

---

## 🎛️ Configuración Avanzada de Voz (ElevenLabs)

Por defecto, Twilio utiliza el modelo y la velocidad estándar de ElevenLabs asociados a tu `Voice ID`. Sin embargo, puedes personalizar **la velocidad, la estabilidad y la similitud** directamente desde tu archivo `.env`.

> ⚠️ **Importante:** Cualquier ajuste que hagas en la web de ElevenLabs (como la velocidad configurada en un "Agente" o los parámetros movidos en el VoiceLab) **es ignorado** por Twilio en su integración nativa. Twilio requiere que se lo pases en la cadena del ID.

### Cómo cambiar la velocidad y parámetros

Para modificar la velocidad y otros parámetros, debes añadirlos al final de tu `ELEVENLABS_VOICE_ID` separados por un guion y guiones bajos, siguiendo estrictamente este formato y orden:

`[VoiceID]-[velocidad]_[estabilidad]_[similitud]`

*   **Voice ID:** El código de 20 caracteres de tu voz en la sección *Voices* de ElevenLabs (Ej: `ElGl0o9qwShv7sa2jOeA`). **ATENCIÓN: NO uses IDs que empiecen por `agent_`.** Twilio requiere una ID de "Voz", no una de "Agente".
*   **Velocidad:** Rango de `0.7` a `1.2`. (`1.0` es la velocidad normal, `1.2` es lo más rápido).
*   **Estabilidad:** Rango de `0.0` a `1.0`. (Recomendado un punto intermedio, por ejemplo `0.5`).
*   **Similitud:** Rango de `0.0` a `1.0`. (Recomendado un punto intermedio, por ejemplo `0.5`).

### Ejemplo de Configuración en `.env`

Si quieres que la voz hable al máximo de velocidad (1.2), tu línea en el `.env` debe verse exactamente así:

```env
ELEVENLABS_VOICE_ID=ElGl0o9qwShv7sa2jOeA-1.2_0.5_0.5
```

> ❌ **Error común:** No incluyas nombres de modelos o letras extrañas (como `eleven_multilingual_v2`) en medio del texto. Usar un string mal formateado como `ID-modelo_1.2_0.5_0.5` causará un **"Application Error"** en Twilio al iniciar la llamada y se colgará al instante. Usa el formato solo con números tal y como se muestra arriba.

---

## 🚀 Arrancar el Proyecto

Necesitas **2 terminales** abiertas simultáneamente:

### Terminal 1: ngrok (túnel público)

```bash
ngrok http 3000
```

O si tienes un dominio fijo:

```bash
ngrok http 3000 --domain=tu-dominio.ngrok-free.dev
```

Una vez arrancado, ngrok mostrará algo como:

```
Forwarding  https://abc123.ngrok-free.dev -> http://localhost:3000
```

> 📝 Si **no** tienes dominio fijo, la URL cambia cada vez que reinicias ngrok. Tendrás que actualizar `SERVER_PUBLIC_URL` en `.env` con la nueva URL (cambiando `https://` por `wss://`).

### Terminal 2: Servidor Node.js

```bash
node server.js
```

Verás una salida de consola confirmando los endpoints y la configuración.

> ⚠️ **Si ves `⚠️ NO CONFIGURADO`** en alguna línea, falta esa variable en tu `.env`.

### Checklist de arranque

- [ ] ngrok corriendo y mostrando la URL pública
- [ ] `SERVER_PUBLIC_URL` en `.env` coincide con la URL de ngrok (con `wss://`)
- [ ] `node server.js` arrancado sin errores
- [ ] Todas las variables de configuración muestran valores (no `⚠️ NO CONFIGURADO`)

---

## 📞 Hacer una Llamada

Con ambas terminales corriendo (ngrok + servidor), abre una **tercera terminal** y ejecuta:

```bash
curl -X POST http://localhost:3000/make-call
```

### Respuesta esperada

```json
{
  "success": true,
  "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "message": "Llamada iniciada. Contesta el teléfono."
}
```

### ¿Qué pasa a continuación?

1. 📱 Tu teléfono suena (el número configurado en `TWILIO_PHONE_TO`)
2. 📞 Contestas la llamada
3. 🔊 Escuchas la frase de saludo (con voz de ElevenLabs y la velocidad/parámetros de tu configuración).
4. 🎤 Tú hablas — Twilio transcribe tu voz a texto.
5. 🤖 El texto se envía a Botpress — Botpress procesa y responde.
6. 🔊 La respuesta del bot se convierte a voz con ElevenLabs — tú la escuchas.
7. 🔄 El ciclo se repite hasta que cuelgues.

---

## 🌐 Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Health check — verifica que el servidor está activo |
| `POST` | `/make-call` | Inicia una llamada al número configurado en `TWILIO_PHONE_TO` |
| `POST` | `/incoming-call` | Webhook de Twilio — devuelve TwiML con la configuración de ConversationRelay |
| `POST` | `/call-ended` | Callback que Twilio llama cuando termina la sesión |
| `WSS` | `/ws` | WebSocket — comunicación bidireccional con Twilio ConversationRelay |

---

## 🗂 Estructura del Código

```
botpress-elevenlabs-bridge/
├── server.js          # Servidor principal (todo el código está aquí)
├── package.json       # Dependencias del proyecto
├── .env               # Variables de entorno (TUS CREDENCIALES)
├── .env.example       # Plantilla de variables de entorno
├── DOCUMENTACION.md   # Este archivo, guía completa y avanzada
├── README.md          # Guía rápida
├── .gitignore         # Ignora node_modules y .env
└── node_modules/      # Dependencias instaladas
```

### `server.js` — Componentes principales

| Función / Sección | Líneas aproximadas | Descripción |
|---|---|---|
| **Express HTTP Server** | 30-97 | Endpoints `/incoming-call`, `/call-ended`, health check |
| **`/make-call`** | 99-123 | Endpoint para iniciar una llamada vía Twilio API |
| **WebSocket Server** | 125-438 | Maneja la conexión WebSocket de ConversationRelay |
| **`initBotpressSession()`** | 141-206 | Crea usuario + conversación en Botpress vía HTTP |
| **`startSSEListener()`** | 212-290 | Escucha respuestas del bot vía Server-Sent Events |
| **`sendToBotpress()`** | 295-329 | Envía el texto del usuario al bot |
| **`cleanupSession()`** | 334-344 | Limpia la sesión al terminar la llamada |
| **WebSocket handler** | 349-438 | Procesa mensajes: `setup`, `prompt`, `interrupt`, `dtmf`, `error` |

---

## 🔧 Troubleshooting

### "An application error occurred" al contestar la llamada

**Causas comunes**:
1. **Configuración de Voz Inválida:** Tienes letras extrañas o un formato inválido en la variable `ELEVENLABS_VOICE_ID`. (Ej: `agent_...` o texto metido entre medias de los números de configuración).
2. **ngrok no está corriendo** → Arranca ngrok: `ngrok http 3000`
3. **La URL de ngrok cambió** → Actualiza `SERVER_PUBLIC_URL` en `.env` y reinicia el servidor
4. **El servidor Node.js no está corriendo** → Arranca con `node server.js`

**Cómo verificar:** Abre tu URL pública en el navegador:
`https://tu-dominio.ngrok-free.dev/`
Deberías ver: `{"status":"ok","service":"botpress-elevenlabs-bridge",...}`

### El bot llama pero no responde cuando hablo

**Causa**: Error en la conexión con Botpress. Verifica:
1. El `BOTPRESS_WEBHOOK_ID` es correcto.
2. La integración **Chat** está instalada y activa en Botpress Studio.
3. Tu bot tiene flujos configurados para responder.

---

## 🚢 Despliegue en Producción

Para producción, puedes desplegar en **Render**, **Railway**, **Fly.io**, o cualquier servicio que soporte Node.js + WebSocket.

### Ejemplo con Render

1. Sube tu código a un repo de GitHub
2. En [render.com](https://render.com/), crea un nuevo **Web Service**
3. Conecta tu repo
4. Configura:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Añade las variables de entorno (las mismas que `.env`)
6. **Importante**: Actualiza `SERVER_PUBLIC_URL` con la URL de Render:
   `wss://tu-servicio.onrender.com`

> 💡 En producción **no necesitas ngrok** — Render te da una URL pública directamente.
