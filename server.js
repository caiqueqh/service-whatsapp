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

let sock = null;
let currentQrBase64 = null;
let connectionState = 'DISCONNECTED'; // DISCONNECTED, QRCODE, CONNECTED

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

        const jid = cleanPhone + '@s.whatsapp.net';

        // Valida se o número possui conta de WhatsApp ativa antes de enviar
        const [result] = await sock.onWhatsApp(jid);
        if (!result || !result.exists) {
            return res.status(400).json({ success: false, error: 'Este número de telefone não possui uma conta de WhatsApp ativa.' });
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`✉️ Mensagem enviada com sucesso para ${cleanPhone}`);

        return res.status(200).json({ success: true, jid });
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
