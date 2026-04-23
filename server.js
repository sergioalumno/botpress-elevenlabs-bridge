// ============================================================
// SERVIDOR MIDDLEWARE: Twilio ConversationRelay + Botpress + ElevenLabs
// ============================================================
// Este servidor actúa como puente entre:
// 1. Twilio (llamadas telefónicas + ConversationRelay)
// 2. Botpress (lógica del bot vía Chat API)
// 3. ElevenLabs (voz TTS, gestionada automáticamente por Twilio ConversationRelay)
//
// Flujo:
// Curl → Twilio llama → Tu servidor devuelve TwiML con ConversationRelay
// → Twilio abre WebSocket → Tu servidor recibe voz transcrita del usuario
// → Tu servidor envía texto a Botpress → Botpress responde
// → Tu servidor envía respuesta por WebSocket → Twilio la convierte a voz ElevenLabs
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

// ============================================================
// CONFIGURACIÓN
// ============================================================
const PORT = process.env.PORT || 3000;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const BOTPRESS_WEBHOOK_ID = process.env.BOTPRESS_WEBHOOK_ID;
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL;

// ============================================================
// SERVIDOR EXPRESS (HTTP)
// ============================================================
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'botpress-elevenlabs-bridge',
    message: 'Servidor middleware activo. Usa /incoming-call como webhook de Twilio.'
  });
});

/**
 * ENDPOINT: /incoming-call
 * 
 * Este endpoint es llamado por Twilio cuando se inicia una llamada.
 * Devuelve TwiML que configura ConversationRelay con:
 * - ElevenLabs como proveedor de TTS
 * - Tu Voice ID de ElevenLabs
 * - WebSocket URL para la comunicación bidireccional
 */
app.post('/incoming-call', (req, res) => {
  console.log('📞 Nueva llamada recibida');
  console.log(`   From: ${req.body.From}`);
  console.log(`   To: ${req.body.To}`);
  console.log(`   CallSid: ${req.body.CallSid}`);

  const response = new VoiceResponse();
  const connect = response.connect({
    action: `${SERVER_PUBLIC_URL.replace('wss://', 'https://')}/call-ended`
  });

  connect.conversationRelay({
    url: `${SERVER_PUBLIC_URL}/ws`,
    ttsProvider: 'ElevenLabs',
    voice: ELEVENLABS_VOICE_ID,
    language: 'es-ES',
    transcriptionLanguage: 'es-ES',
    welcomeGreeting: 'Hola, soy tu asistente de gestión de gastos. ¿En qué puedo ayudarte?',
    interruptible: 'true',
    // ElevenLabs text normalization mejora pronunciación de números, fechas, etc.
    elevenlabsTextNormalization: 'auto'
  });

  const twiml = response.toString();
  console.log('📄 TwiML generado:', twiml);

  res.type('text/xml');
  res.send(twiml);
});

/**
 * ENDPOINT: /call-ended
 * 
 * Llamado por Twilio cuando termina la sesión de ConversationRelay.
 */
app.post('/call-ended', (req, res) => {
  console.log('📴 Llamada terminada');
  const response = new VoiceResponse();
  response.say({ language: 'es-ES' }, 'Hasta luego. Gracias por usar el asistente de gastos.');
  response.hangup();
  res.type('text/xml');
  res.send(response.toString());
});

/**
 * ENDPOINT: /make-call
 * 
 * Endpoint de conveniencia para iniciar una llamada desde el navegador o curl.
 * Sustituye al comando curl que usabas antes.
 */
app.post('/make-call', async (req, res) => {
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const publicHttpUrl = SERVER_PUBLIC_URL.replace('wss://', 'https://');

    const call = await client.calls.create({
      to: process.env.TWILIO_PHONE_TO,
      from: process.env.TWILIO_PHONE_FROM,
      url: `${publicHttpUrl}/incoming-call`
    });

    console.log(`📞 Llamada iniciada: ${call.sid}`);
    res.json({ success: true, callSid: call.sid, message: 'Llamada iniciada. Contesta el teléfono.' });
  } catch (error) {
    console.error('❌ Error al iniciar llamada:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// SERVIDOR HTTP + WEBSOCKET
// ============================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Almacena sesiones activas: callSid → { userKey, userId, conversationId, sseAbort }
const activeSessions = new Map();

// URL base de la Chat API de Botpress
const BOTPRESS_API_URL = `https://chat.botpress.cloud/${BOTPRESS_WEBHOOK_ID}`;

/**
 * Inicializa una sesión de Botpress Chat para una llamada.
 * Usa llamadas HTTP directas (sin SDK) para máxima fiabilidad.
 */
async function initBotpressSession(callSid, ws) {
  console.log(`🤖 [${callSid}] Iniciando sesión de Botpress...`);

  try {
    // 1. Crear usuario
    const userRes = await fetch(`${BOTPRESS_API_URL}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!userRes.ok) {
      throw new Error(`Error creando usuario: ${userRes.status} ${await userRes.text()}`);
    }

    const userData = await userRes.json();
    const userKey = userData.key;
    const userId = userData.user?.id;
    console.log(`🤖 [${callSid}] Usuario creado. ID: ${userId}`);

    // 2. Crear conversación
    const convRes = await fetch(`${BOTPRESS_API_URL}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': userKey
      },
      body: JSON.stringify({})
    });

    if (!convRes.ok) {
      throw new Error(`Error creando conversación: ${convRes.status} ${await convRes.text()}`);
    }

    const convData = await convRes.json();
    const conversationId = convData.conversation?.id;
    console.log(`🤖 [${callSid}] Conversación creada: ${conversationId}`);

    // 3. Iniciar SSE listener para respuestas del bot
    const abortController = new AbortController();
    startSSEListener(callSid, conversationId, userKey, userId, ws, abortController);

    // 4. Guardar sesión
    activeSessions.set(callSid, {
      userKey,
      userId,
      conversationId,
      sseAbort: abortController
    });

    console.log(`✅ [${callSid}] Sesión de Botpress lista`);
    return true;
  } catch (error) {
    console.error(`❌ [${callSid}] Error al iniciar Botpress:`, error.message);

    // Enviar mensaje de error al usuario por voz
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'text',
        token: 'Lo siento, estoy teniendo problemas técnicos. Por favor, inténtalo de nuevo más tarde.',
        last: true
      }));
    }
    return false;
  }
}

/**
 * Escucha respuestas del bot via Server-Sent Events (SSE).
 * Cuando el bot responde, envía el texto a Twilio por WebSocket.
 */
async function startSSEListener(callSid, conversationId, userKey, userId, ws, abortController) {
  try {
    console.log(`📡 [${callSid}] Iniciando SSE listener...`);

    const sseRes = await fetch(
      `${BOTPRESS_API_URL}/conversations/${conversationId}/listen`,
      {
        headers: { 'x-user-key': userKey },
        signal: abortController.signal
      }
    );

    if (!sseRes.ok) {
      console.error(`❌ [${callSid}] Error SSE: ${sseRes.status} ${await sseRes.text()}`);
      return;
    }

    console.log(`📡 [${callSid}] SSE conectado, escuchando respuestas del bot...`);

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`📡 [${callSid}] SSE stream terminado`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Procesar líneas completas del SSE
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // mantener línea incompleta en buffer

      for (const line of lines) {
        // Ignorar líneas vacías, event: prefixes, y comentarios
        if (!line.startsWith('data: ')) continue;

        try {
          const eventData = JSON.parse(line.slice(6));

          // La estructura del evento SSE de Botpress es:
          // { type: "message_created", data: { userId, payload, isBot, ... } }
          // Los datos del mensaje están dentro de eventData.data
          if (eventData.type === 'message_created' && eventData.data) {
            const msgData = eventData.data;

            // Solo procesar mensajes del bot (usando isBot flag)
            if (msgData.isBot || msgData.userId !== userId) {
              const botText = msgData.payload?.text;

              if (botText && ws.readyState === ws.OPEN) {
                console.log(`🤖 [${callSid}] Bot responde: "${botText}"`);
                ws.send(JSON.stringify({
                  type: 'text',
                  token: botText,
                  last: true
                }));
                console.log(`📤 [${callSid}] Texto enviado a Twilio para TTS con ElevenLabs`);
              } else if (botText) {
                console.log(`🤖 [${callSid}] Bot respondió pero WebSocket cerrado: "${botText}"`);
              }
            }
          }
        } catch (parseErr) {
          // Ignorar líneas que no son JSON válido (ping, comments, etc.)
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`📡 [${callSid}] SSE listener detenido (llamada terminada)`);
    } else {
      console.error(`❌ [${callSid}] Error en SSE listener:`, error.message);
    }
  }
}

/**
 * Envía un mensaje del usuario al bot de Botpress via HTTP.
 */
async function sendToBotpress(callSid, userText) {
  const session = activeSessions.get(callSid);
  if (!session) {
    console.error(`❌ [${callSid}] No hay sesión activa de Botpress`);
    return;
  }

  console.log(`📨 [${callSid}] Enviando a Botpress: "${userText}"`);

  try {
    const msgRes = await fetch(`${BOTPRESS_API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': session.userKey
      },
      body: JSON.stringify({
        conversationId: session.conversationId,
        payload: {
          type: 'text',
          text: userText
        }
      })
    });

    if (!msgRes.ok) {
      const errBody = await msgRes.text();
      console.error(`❌ [${callSid}] Error al enviar mensaje: ${msgRes.status} ${errBody}`);
    } else {
      console.log(`📨 [${callSid}] Mensaje enviado a Botpress OK`);
    }
  } catch (error) {
    console.error(`❌ [${callSid}] Error al enviar a Botpress:`, error.message);
  }
}

/**
 * Limpia una sesión cuando la llamada termina.
 */
function cleanupSession(callSid) {
  const session = activeSessions.get(callSid);
  if (session) {
    console.log(`🧹 [${callSid}] Limpiando sesión...`);
    // Abortar el SSE listener
    if (session.sseAbort) {
      session.sseAbort.abort();
    }
    activeSessions.delete(callSid);
  }
}

// ============================================================
// MANEJO DE WEBSOCKET (ConversationRelay)
// ============================================================
wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket conectado desde:', req.url);

  let callSid = null;
  let botpressReady = false;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        // --------------------------------------------------------
        // SETUP: Twilio envía info de la llamada al conectar el WebSocket
        // --------------------------------------------------------
        case 'setup':
          callSid = message.callSid;
          console.log(`\n${'='.repeat(60)}`);
          console.log(`📞 NUEVA SESIÓN DE VOZ`);
          console.log(`   CallSid: ${callSid}`);
          console.log(`   From: ${message.from}`);
          console.log(`   To: ${message.to}`);
          console.log(`   Direction: ${message.direction}`);
          if (message.customParameters) {
            console.log(`   Custom Params:`, message.customParameters);
          }
          console.log(`${'='.repeat(60)}\n`);

          // Iniciar sesión de Botpress
          botpressReady = await initBotpressSession(callSid, ws);
          break;

        // --------------------------------------------------------
        // PROMPT: El usuario ha dicho algo (transcrito por Twilio STT)
        // --------------------------------------------------------
        case 'prompt':
          const userText = message.voicePrompt;
          console.log(`🎤 [${callSid}] Usuario dice: "${userText}"`);

          if (botpressReady && userText && userText.trim().length > 0) {
            await sendToBotpress(callSid, userText);
          } else if (!botpressReady) {
            console.log(`⏳ [${callSid}] Botpress aún no está listo, reintentando...`);
            botpressReady = await initBotpressSession(callSid, ws);
            if (botpressReady) {
              await sendToBotpress(callSid, userText);
            }
          }
          break;

        // --------------------------------------------------------
        // INTERRUPT: El usuario interrumpió al bot mientras hablaba
        // --------------------------------------------------------
        case 'interrupt':
          console.log(`✋ [${callSid}] Usuario interrumpió al bot`);
          console.log(`   Lo dicho hasta la interrupción: "${message.utteranceUntilInterrupt}"`);
          break;

        // --------------------------------------------------------
        // DTMF: El usuario presionó una tecla
        // --------------------------------------------------------
        case 'dtmf':
          console.log(`🔢 [${callSid}] DTMF: ${message.digit}`);
          break;

        // --------------------------------------------------------
        // ERROR: Error en ConversationRelay
        // --------------------------------------------------------
        case 'error':
          console.error(`❌ [${callSid}] Error de ConversationRelay: ${message.description}`);
          break;

        default:
          console.log(`❓ [${callSid}] Mensaje desconocido:`, message);
      }
    } catch (error) {
      console.error('❌ Error procesando mensaje WebSocket:', error.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 [${callSid}] WebSocket cerrado. Code: ${code}, Reason: ${reason}`);
    if (callSid) {
      cleanupSession(callSid);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ [${callSid}] Error WebSocket:`, error.message);
  });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
server.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 SERVIDOR MIDDLEWARE ACTIVO`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   HTTP:      http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`   Endpoints:`);
  console.log(`     POST /incoming-call  → Webhook de Twilio (devuelve TwiML)`);
  console.log(`     POST /make-call      → Iniciar llamada (reemplaza curl)`);
  console.log(`     POST /call-ended     → Callback cuando termina la llamada`);
  console.log(`     GET  /               → Health check`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`   Configuración:`);
  console.log(`     ElevenLabs Voice ID: ${ELEVENLABS_VOICE_ID || '⚠️  NO CONFIGURADO'}`);
  console.log(`     Botpress Webhook:    ${BOTPRESS_WEBHOOK_ID || '⚠️  NO CONFIGURADO'}`);
  console.log(`     URL Pública:         ${SERVER_PUBLIC_URL || '⚠️  NO CONFIGURADO'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!ELEVENLABS_VOICE_ID || !BOTPRESS_WEBHOOK_ID || !SERVER_PUBLIC_URL) {
    console.log('⚠️  ATENCIÓN: Faltan variables de entorno. Copia .env.example a .env y rellena los valores.\n');
  }
});
