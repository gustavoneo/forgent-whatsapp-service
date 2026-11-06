import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  proto
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_KEY = process.env.API_KEY || 'forgent-secret-key';

let sock = null;
let currentQr = null;
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      currentQr = await QRCode.toDataURL(qr);
      console.log('Novo QR Code gerado');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão encerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp conectado com sucesso!');
      isConnected = true;
      currentQr = null;
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

startWhatsApp();

// 1. Tela para escanear o QR Code no navegador
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<h2 style="color:green;font-family:sans-serif;text-align:center;margin-top:50px;">WhatsApp conectado e pronto! ✅</h2>');
  }
  if (!currentQr) {
    return res.send('<h3 style="font-family:sans-serif;text-align:center;margin-top:50px;">Gerando QR Code, aguarde e recarregue a página...</h3><script>setTimeout(()=>location.reload(), 2000)</script>');
  }
  res.send(`
    <div style="font-family:sans-serif;text-align:center;margin-top:40px;">
      <h2>Escanear WhatsApp — Forgent PRO</h2>
      <p>Abra o WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
      <img src="${currentQr}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;" />
      <script>setTimeout(() => location.reload(), 20000);</script>
    </div>
  `);
});

// 2. Status da conexão
app.get('/status', (req, res) => {
  res.json({ connected: isConnected });
});

// 3. Disparo de mensagem com botão nativo cta_url
app.post('/send', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['apikey'];
  if (apiKey !== AUTH_KEY) {
    return res.status(401).json({ error: 'Chave de API não autorizada' });
  }

  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp desconectado. Acesse /qr para escanear.' });
  }

  const { number, text, imageUrl, buttonText, buttonUrl } = req.body;
  if (!number || !text) {
    return res.status(400).json({ error: 'Campos number e text são obrigatórios' });
  }

  const cleanNumber = number.replace(/\D/g, '');
  const jid = `${cleanNumber}@s.whatsapp.net`;

  try {
    const buttons = [];
    if (buttonText && buttonUrl) {
      buttons.push({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: buttonText,
          url: buttonUrl,
          merchant_url: buttonUrl
        })
      });
    }

    const interactiveMessage = {
      body: { text: text },
      footer: { text: 'Central de Gestão • Forgent PRO' },
      header: {
        title: '',
        subtitle: '',
        hasMediaAttachment: !!imageUrl
      },
      nativeFlowMessage: {
        buttons: buttons
      }
    };

    // Anexa imagem se fornecida
    if (imageUrl) {
      interactiveMessage.header.imageMessage = {
        url: imageUrl
      };
    }

    const messageContent = proto.Message.fromObject({
      viewOnceMessage: {
        message: {
          interactiveMessage: interactiveMessage
        }
      }
    });

    const waMessage = generateWAMessageFromContent(jid, messageContent, {
      userJid: sock.user.id
    });

    await sock.relayMessage(jid, waMessage.message, {
      messageId: waMessage.key.id
    });

    res.json({ success: true, messageId: waMessage.key.id });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ error: err.message || 'Falha ao enviar mensagem' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
