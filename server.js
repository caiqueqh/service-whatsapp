import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'url';
import pathModule from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
const AUTH_FOLDER = pathModule.join(__dirname, 'auth_session');

// URL do sistema Qualitas que recebe as mensagens (ex: https://sistema/api/whatsapp/webhook)
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

let sock = null;
let currentQrBase64 = null;
let connectionState = 'DISCONNECTED'; // DISCONNECTED, QRCODE, CONNECTED

// Desembrulha os invólucros que o WhatsApp coloca por fora do conteúdo real:
// mensagens temporárias (ephemeral), ver-uma-vez, e as enviadas por outro
// dispositivo do mesmo usuário. Sem isso o texto fica um nível abaixo e some.
function conteudoReal(message) {
    let m = message;

    for (let i = 0; i < 5 && m; i++) {
        const interno =
            m.ephemeralMessage?.message ||
            m.viewOnceMessage?.message ||
            m.viewOnceMessageV2?.message ||
            m.viewOnceMessageV2Extension?.message ||
            m.documentWithCaptionMessage?.message ||
            m.deviceSentMessage?.message

        if (!interno) break;
        m = interno;
    }

    return m || {};
}

// Extrai o texto de qualquer um dos formatos de mensagem que o Baileys entrega
function extrairTexto(msg) {
    const m = conteudoReal(msg?.message);

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        ''
    );
}

// Envia a mensagem recebida/enviada para o sistema Qualitas.
// Tem retry porque um "OK" perdido some para sempre: o sistema nunca marca o candidato como confirmado.
async function notificarSistema(payload, tentativa = 1) {
    if (!WEBHOOK_URL) {
        console.log('⚠️ WEBHOOK_URL vazia — mensagem NAO repassada ao sistema.');
        return;
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': WEBHOOK_SECRET
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        console.log(`✅ Webhook OK (${res.status}) texto="${payload.texto}"`);
    } catch (err) {
        console.error(`⚠️ Falha ao notificar o sistema (tentativa ${tentativa}):`, err.message);

        if (tentativa < 3) {
            setTimeout(() => notificarSistema(payload, tentativa + 1), tentativa * 2000);
        } else {
            console.error('❌ Webhook descartado após 3 tentativas:', JSON.stringify(payload));
        }
    }
}

async function startWhatsApp() {
    connectionState = 'CONNECTING';
    currentQrBase64 = null;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    console.log(`Iniciando conexão WhatsApp Web com padrões do Baileys`);

    sock = makeWASocket.default ? makeWASocket.default({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    }) : makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    // Repassa para o sistema toda mensagem trocada (recebida e enviada),
    // para montar o histórico da conversa e detectar a confirmação "OK".
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📥 messages.upsert type=${type} qtd=${messages.length}`);

        for (const msg of messages) {
            const jid = msg.key?.remoteJid || '';

            // DIAGNÓSTICO: mostra a key inteira antes de qualquer filtro, para
            // enxergar o formato do JID recebido (ex.: @lid no WhatsApp novo) e
            // se o telefone real vem junto em algum campo.
            console.log(`   🔎 key=${JSON.stringify(msg.key)}`);

            // Ignora grupos, status e broadcasts — só conversa individual.
            // Aceita @s.whatsapp.net (formato antigo) e @lid (novo identificador).
            if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;

            const texto = extrairTexto(msg);
            if (!texto) {
                // Diagnóstico: mensagem recebida que não rendeu texto. Mostra as
                // chaves do conteúdo (para descobrir um formato novo) ou sinaliza
                // 'null' quando msg.message veio vazio (falha de descriptografia).
                if (!msg.key?.fromMe) {
                    const chaves = msg.message
                        ? Object.keys(conteudoReal(msg.message)).join(',')
                        : 'null(descriptografia?)'
                    console.log(`   ❓ recebida sem texto de=${jid.split('@')[0]} conteudo=[${chaves}] stub=${msg.messageStubType ?? '-'}`)
                }
                continue;
            }

            const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

            // 'notify' = mensagem nova ao vivo. 'append' = sincronização (histórico
            // ou mensagens que chegaram durante a reconexão que segue o erro 515).
            // O 'append' só é aceito se for recente, para pegar um "ok" atrasado
            // sem reprocessar o histórico inteiro a cada reconexão.
            const recente = ts > Math.floor(Date.now() / 1000) - 600;

            if (type !== 'notify' && !recente) {
                console.log(`   ⏭️ ignorada (type=${type}, antiga) de=${jid.split('@')[0]}`);
                continue;
            }

            // Telefone real: no formato novo (@lid) o número do JID NÃO é o
            // telefone. O número verdadeiro vem em remoteJidAlt, no formato antigo
            // (ex.: 5515981462845@s.whatsapp.net). No @s.whatsapp.net puro, o
            // próprio JID já é o número.
            const telefone = String(
                msg.key?.remoteJidAlt || msg.key?.senderPn || msg.key?.participantPn || jid
            ).split('@')[0];

            console.log(`   ↳ de=${telefone} (jid=${jid}) fromMe=${!!msg.key?.fromMe} texto="${texto}"`);

            await notificarSistema({
                jid,
                telefone,
                fromMe: !!msg.key?.fromMe,
                texto,
                messageId: msg.key?.id,
                timestamp: ts
            });
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionState = 'QRCODE';
            currentQrBase64 = await QRCode.toDataURL(qr);
            console.log('📱 Novo QR Code gerado. Pronto para escanear.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Conexão fechada devido a:', lastDisconnect?.error, ', Reconectando:', shouldReconnect);
            
            connectionState = 'DISCONNECTED';
            currentQrBase64 = null;

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('❌ Sessão desconectada permanentemente (Logout). Limpando pasta de sessão.');
                if (fs.existsSync(AUTH_FOLDER)) {
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                }
                setTimeout(startWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            connectionState = 'CONNECTED';
            currentQrBase64 = null;
            console.log('✅ WhatsApp Web Conectado com Sucesso!');
        }
    });
}

// Inicializa o cliente na subida do servidor
startWhatsApp();

// 1. Rota de Ping para o UptimeRobot (Evita adormecer no Render Gratuito)
app.get('/', (req, res) => {
    res.status(200).json({ status: 'OK', service: 'Qualitas WhatsApp Web Service Online', state: connectionState });
});

// 2. Rota de Status da Conexão e QR Code
app.get('/status', (req, res) => {
    res.status(200).json({
        state: connectionState,
        qrcode: currentQrBase64
    });
});

// 3. Rota para Disparo de Mensagem
app.post('/send', async (req, res) => {
    try {
        if (connectionState !== 'CONNECTED' || !sock) {
            return res.status(400).json({ success: false, error: 'O WhatsApp não está conectado no momento. Por favor escanear o QR Code.' });
        }

        const { phone, message } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'Parâmetros phone e message são obrigatórios.' });
        }

        // Limpa tudo que não for número
        let cleanPhone = phone.replace(/\D/g, '');

        // Adiciona DDI 55 se não tiver
        if (!cleanPhone.startsWith('55') && cleanPhone.length <= 11) {
            cleanPhone = '55' + cleanPhone;
        }

        let jidsToTest = [cleanPhone + '@s.whatsapp.net'];

        // Lógica para números do Brasil (DDI 55 com DDD de 2 dígitos)
        if (cleanPhone.startsWith('55')) {
            const semDDI = cleanPhone.slice(2);
            if (semDDI.length === 11 && semDDI[2] === '9') {
                // Tem 11 dígitos no formato Brasil (DDD + 9 + 8 dígitos). Testar também sem o 9º dígito.
                const varSemNove = '55' + semDDI.slice(0, 2) + semDDI.slice(3);
                jidsToTest.push(varSemNove + '@s.whatsapp.net');
            } else if (semDDI.length === 10) {
                // Tem 10 dígitos (DDD + 8 dígitos). Testar também com o 9º dígito.
                const varComNove = '55' + semDDI.slice(0, 2) + '9' + semDDI.slice(2);
                jidsToTest.unshift(varComNove + '@s.whatsapp.net'); // Prioriza testar com 9
            }
        }

        let validJid = null;
        for (const jid of jidsToTest) {
            const [result] = await sock.onWhatsApp(jid);
            if (result && result.exists) {
                validJid = result.jid || jid;
                break;
            }
        }

        if (!validJid) {
            return res.status(400).json({ success: false, error: 'Este número de telefone não possui uma conta de WhatsApp ativa no formato verificado.' });
        }

        const sent = await sock.sendMessage(validJid, { text: message });
        console.log(`✉️ Mensagem enviada com sucesso para ${validJid}`);

        return res.status(200).json({ success: true, jid: validJid, messageId: sent?.key?.id || null });
    } catch (err) {
        console.error('Erro no envio:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Forçar logout / desconectar
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        return res.status(200).json({ success: true, message: 'Sessão desconectada.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Microserviço WhatsApp Qualitas rodando na porta ${PORT}`);
});
