const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { sendButtons } = require("gifted-btns");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "forgent-secret-key";
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || "./auth_info");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function startSock() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando Baileys v${version.join(".")}, mais recente: ${isLatest}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: "warn" }),
      auth: state,
      printQRInTerminal: true,
      browser: ["Forgent WhatsApp", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          console.log("Novo QR Code gerado!");
        } catch (err) {
          console.error("Erro ao gerar QR Code:", err);
        }
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Conexão fechada. Motivo: ${statusCode}. Reconectar? ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(startSock, 3000);
        } else {
          console.log("Desconectado permanentemente (logout). Limpando sessão...");
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
          setTimeout(startSock, 3000);
        }
      } else if (connection === "open") {
        isConnected = true;
        qrCodeData = null;
        console.log(" WhatsApp conectado com sucesso!");
      }
    });
  } catch (error) {
    console.error("Erro ao iniciar socket WhatsApp:", error);
    setTimeout(startSock, 5000);
  }
}

startSock();

// Validação de API Key
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Não autorizado: API Key inválida" });
  }
  next();
}

// Rota de status JSON
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    hasQr: !!qrCodeData,
  });
});

// Página HTML com QR Code ou Status
app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>WhatsApp Conectado - Forgent</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            .badge { display: inline-block; background: #10b981; color: #fff; padding: 0.5rem 1rem; border-radius: 9999px; font-weight: bold; margin-bottom: 1rem; }
            h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
            p { color: #94a3b8; font-size: 0.95rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">ONLINE</div>
            <h1>WhatsApp Conectado!</h1>
            <p>Seu serviço de envio de mensagens com botões interativos está funcionando.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (qrCodeData) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Escanear QR Code - Forgent</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            img { width: 280px; height: 280px; border-radius: 0.5rem; background: #fff; padding: 0.5rem; }
            h1 { margin: 0 0 0.5rem; font-size: 1.35rem; }
            p { color: #94a3b8; font-size: 0.9rem; margin: 0.5rem 0 1.5rem; }
            .note { font-size: 0.8rem; color: #64748b; margin-top: 1rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Conectar WhatsApp</h1>
            <p>Abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho e aponte a câmera para o QR Code abaixo:</p>
            <img src="${qrCodeData}" alt="QR Code WhatsApp" />
            <div class="note">A página atualiza automaticamente a cada 15 segundos.</div>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Aguardando QR Code...</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="3">
        <style>
          body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <p>Iniciando WhatsApp e gerando QR Code... aguarde alguns segundos.</p>
        </div>
      </body>
    </html>
  `);
});

// Endpoint de envio de mensagem
app.post("/send", requireApiKey, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ error: "WhatsApp desconectado. Escaneie o QR Code em /qr" });
    }

    const { number, text, imageUrl, imageBase64, buttonText, buttonUrl, footer } = req.body;

    if (!number || !text) {
      return res.status(400).json({ error: "Campos 'number' e 'text' são obrigatórios" });
    }

    const cleanNum = String(number).replace(/\D/g, "");
    const jid = `${cleanNum}@s.whatsapp.net`;

    const payload = {
      text: String(text),
      footer: footer ? String(footer) : undefined,
    };

    // Processamento da imagem (Base64 direto ou URL convertida em Buffer)
    if (imageBase64) {
      try {
        const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        const raw = matches ? matches[2] : imageBase64;
        payload.image = { buffer: Buffer.from(raw, "base64") };
      } catch (err) {
        console.error("Falha ao processar imageBase64:", err);
      }
    } else if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const arrBuf = await imgRes.arrayBuffer();
          payload.image = { buffer: Buffer.from(arrBuf) };
        } else {
          payload.image = { url: imageUrl };
        }
      } catch (err) {
        console.warn("Falha ao baixar imagem por URL, tentando direta:", err);
        payload.image = { url: imageUrl };
      }
    }

    // Botão interativo de ação (CTA URL)
    if (buttonText && buttonUrl) {
      payload.buttons = [
        {
          name: "cta_url",
          buttonParamsJson: JSON.stringify({
            display_text: String(buttonText),
            url: String(buttonUrl),
            merchant_url: String(buttonUrl),
          }),
        },
      ];
    }

    console.log(`Enviando para ${jid} (comImagem: ${!!payload.image}, comBotao: ${!!payload.buttons})`);

    const result = await sendButtons(sock, jid, payload);

    return res.json({
      success: true,
      messageId: result?.key?.id,
    });
  } catch (error) {
    console.error("Erro no envio:", error);
    return res.status(500).json({
      error: error?.message || "Erro interno ao enviar mensagem",
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "Forgent WhatsApp Button Service",
    status: isConnected ? "connected" : "waiting_qr",
    qrUrl: "/qr",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
