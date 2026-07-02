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

        await sock.sendMessage(validJid, { text: message });
        console.log(`✉️ Mensagem enviada com sucesso para ${validJid}`);

        return res.status(200).json({ success: true, jid: validJid });
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
