// ============================================================
// SERVIDOR MIDDLEWARE: Twilio ConversationRelay + Botpress + ElevenLabs
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
    welcomeGreeting: "'Hi, I'm the Sevilla Walking Tour assistant. How can I help you? Hola, soy el asistente de Sevilla Walking Tour. ¿En qué puedo ayudarte?'",
    interruptible: 'true',
    elevenlabsTextNormalization: 'auto'
  });

  const twiml = response.toString();
  console.log('📄 TwiML generado:', twiml);

  res.type('text/xml');
  res.send(twiml);
});

app.post('/call-ended', (req, res) => {
  console.log('📴 Llamada terminada');
  const response = new VoiceResponse();
  response.say({ language: 'es-ES' }, 'Hasta luego. Gracias por usar el asistente de gastos.');
  response.hangup();
  res.type('text/xml');
  res.send(response.toString());
});

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

const activeSessions = new Map();

const BOTPRESS_API_URL = `https://chat.botpress.cloud/${BOTPRESS_WEBHOOK_ID}`;

// ✅ Añadidos fromNumber y toNumber como parámetros
async function initBotpressSession(callSid, ws, fromNumber, toNumber) {
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

    // 3. Iniciar SSE listener
    const abortController = new AbortController();
    startSSEListener(callSid, conversationId, userKey, userId, ws, abortController);

    // 4. ✅ Guardar sesión con el número de teléfono
    activeSessions.set(callSid, {
      userKey,
      userId,
      conversationId,
      sseAbort: abortController,
      lastMessageWords: 0,
      from: fromNumber,  // ✅ Número de quien llama
      to: toNumber       // ✅ Tu número Twilio
    });

    console.log(`✅ [${callSid}] Sesión de Botpress lista`);

    // 5. Enviar palabra clave de canal
    // 5. Enviar palabra clave de canal y número de teléfono
    console.log(`🔑 [${callSid}] Enviando contexto inicial al bot...`);
    const secretRes = await fetch(`${BOTPRESS_API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-key': userKey
      },
      body: JSON.stringify({
        conversationId,
        payload: {
          type: 'text',
          // Adjuntamos el número separado por dos puntos
          text: `CANAL_VOZ: ${fromNumber}`
        }
      })
    });
    if (secretRes.ok) {
      console.log(`🔑 [${callSid}] Palabra clave CANAL_VOZ enviada al bot`);
    } else {
      console.warn(`⚠️ [${callSid}] No se pudo enviar la palabra clave: ${secretRes.status}`);
    }

    return true;
  } catch (error) {
    console.error(`❌ [${callSid}] Error al iniciar Botpress:`, error.message);

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

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        try {
          const eventData = JSON.parse(line.slice(6));

          if (eventData.type === 'message_created' && eventData.data) {
            const msgData = eventData.data;

            if (msgData.isBot || msgData.userId !== userId) {
              const botText = msgData.payload?.text;

              if (botText && botText.trim() === 'CANAL_VOZ') {
                console.log(`🔕 [${callSid}] Eco de CANAL_VOZ ignorado (no se reproduce)`);
                continue;
              }

              if (botText && ws.readyState === ws.OPEN) {
                console.log(`🤖 [${callSid}] Bot responde: "${botText}"`);

                const isHangup = botText.includes('[COLGAR]');
                const cleanText = botText.replace(/\[COLGAR\]/g, '').trim();

                const session = activeSessions.get(callSid);

                if (cleanText) {
                  ws.send(JSON.stringify({
                    type: 'text',
                    token: cleanText,
                    last: true
                  }));
                  console.log(`📤 [${callSid}] Texto enviado a Twilio para TTS con ElevenLabs`);

                  if (session) {
                    session.lastMessageWords = cleanText.split(/\s+/).length;
                  }
                }

                if (isHangup) {
                  console.log(`🔌 [${callSid}] Bot solicitó colgar la llamada. Programando fin...`);

                  let numeroDePalabras = cleanText ? cleanText.split(/\s+/).length : (session?.lastMessageWords || 1);
                  const tiempoDeEsperaMs = (numeroDePalabras / 2.5) * 1000 + 3000;
                  console.log(`⏳ Basado en ${numeroDePalabras} palabras. Esperando dinámicamente ${tiempoDeEsperaMs / 1000}s antes de cortar...`);

                  setTimeout(async () => {
                    try {
                      const session = activeSessions.get(callSid);

                      // ✅ LOG DEL NÚMERO AL COLGAR
                      console.log(`📞 [${callSid}] Número de quien llamó: ${session?.from}`);

                      const twilio = require('twilio');
                      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                      await client.calls(callSid).update({ status: 'completed' });
                      console.log(`✅ [${callSid}] Llamada terminada exitosamente vía API.`);
                    } catch (err) {
                      console.error(`❌ [${callSid}] Error al colgar la llamada:`, err.message);
                    }
                  }, tiempoDeEsperaMs);
                }
              } else if (botText) {
                console.log(`🤖 [${callSid}] Bot respondió pero WebSocket cerrado: "${botText}"`);
              }
            }
          }
        } catch (parseErr) {
          // Ignorar líneas que no son JSON válido
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

function cleanupSession(callSid) {
  const session = activeSessions.get(callSid);
  if (session) {
    console.log(`🧹 [${callSid}] Limpiando sesión...`);
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
        case 'setup':
          callSid = message.callSid;

          // ✅ CAPTURAR EL NÚMERO AQUÍ
          const fromNumber = message.from;
          const toNumber = message.to;

          console.log(`\n${'='.repeat(60)}`);
          console.log(`📞 NUEVA SESIÓN DE VOZ`);
          console.log(`   CallSid:   ${callSid}`);
          console.log(`   From:      ${fromNumber}`);
          console.log(`   To:        ${toNumber}`);
          console.log(`   Direction: ${message.direction}`);
          if (message.customParameters) {
            console.log(`   Custom Params:`, message.customParameters);
          }
          console.log(`${'='.repeat(60)}\n`);

          // ✅ LOG DESTACADO DEL NÚMERO
          console.log(`📱 NÚMERO DE QUIEN LLAMA: ${fromNumber}`);

          // ✅ Pasar el número a initBotpressSession
          botpressReady = await initBotpressSession(callSid, ws, fromNumber, toNumber);
          break;

        case 'prompt':
          const userText = message.voicePrompt;
          console.log(`🎤 [${callSid}] Usuario dice: "${userText}"`);

          if (botpressReady && userText && userText.trim().length > 0) {
            await sendToBotpress(callSid, userText);
          } else if (!botpressReady) {
            console.log(`⏳ [${callSid}] Botpress aún no está listo, reintentando...`);
            const session = activeSessions.get(callSid);
            botpressReady = await initBotpressSession(callSid, ws, session?.from, session?.to);
            if (botpressReady) {
              await sendToBotpress(callSid, userText);
            }
          }
          break;

        case 'interrupt':
          console.log(`✋ [${callSid}] Usuario interrumpió al bot`);
          console.log(`   Lo dicho hasta la interrupción: "${message.utteranceUntilInterrupt}"`);
          break;

        case 'dtmf':
          console.log(`🔢 [${callSid}] DTMF: ${message.digit}`);
          break;

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