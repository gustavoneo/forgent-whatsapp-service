const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const { sendButtons } = require("gifted-btns");

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "forgent-secret-key";
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || "./auth_info");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let isConnected = false;
let rejectCalls = false;
let rejectMessage = "Olá! Este número é exclusivo para avisos e cobranças automáticas e não recebe ligações. Por favor, envie uma mensagem de texto. 🙏";

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "warn" }),
      printQRInTerminal: false,
      browser: ["Forgent Central", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
  if (type !== "notify") return;
  for (const m of messages) {
    if (m.key.fromMe) continue;
    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || "";
    if (!/[A-Za-z]{3}\d{5}/.test(text)) continue;
    const jid = m.key.remoteJid || "";
    const from = jid.endsWith("@lid") ? (m.key.remoteJidAlt || m.key.senderPn || "") : jid;
    try {
      const r = await fetch("https://painel.forgent.pro/api/public/v1/phone/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.API_KEY },
        body: JSON.stringify({ from, text }),
      });
      const j = await r.json();
      if (j.matched && j.reply) await sock.sendMessage(jid, { text: j.reply });
    } catch (e) { console.error("inbound", e.message); }
  }
});


    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
        } catch (e) {
          qrCodeData = null;
        }
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("Conexão fechada. Reconectar?", shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        } else {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          qrCodeData = null;
          setTimeout(startWhatsApp, 3000);
        }
      } else if (connection === "open") {
        isConnected = true;
        qrCodeData = null;
        console.log("WhatsApp Conectado com Sucesso!");
      }
    });

    sock.ev.on("call", async (calls) => {
      if (!rejectCalls) return;
      for (const c of calls) {
        if (c.status === "offer") {
          try {
            await sock.rejectCall(c.id, c.from);
            if (rejectMessage) {
              await sock.sendMessage(c.from, { text: rejectMessage });
            }
          } catch (e) {
            console.error("Erro ao rejeitar chamada:", e);
          }
        }
      }
    });
  } catch (err) {
    console.error("Erro ao iniciar WhatsApp:", err);
    setTimeout(startWhatsApp, 5000);
  }
}

startWhatsApp();

app.get("/status", (req, res) => {
  res.json({ connected: isConnected, hasQr: !!qrCodeData });
});

app.get("/info", (req, res) => {
  res.json({
    connected: isConnected,
    qr: qrCodeData,
    number: sock?.user?.id ? sock.user.id.split(":")[0].replace(/\D/g, "") : null,
    name: sock?.user?.name || "Forgent PRO",
    rejectCalls,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
        <div style="text-align:center;">
          <h2 style="color:#22c55e;">✅ WhatsApp Conectado!</h2>
          <p>O serviço de envio está online e operante.</p>
        </div>
      </body></html>
    `);
  }
  if (!qrCodeData) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
        <div style="text-align:center;">
          <h2>Iniciando sessão do WhatsApp...</h2>
          <p>Aguarde alguns segundos e recarregue a página.</p>
          <script>setTimeout(() => location.reload(), 3000);</script>
        </div>
      </body></html>
    `);
  }
  res.send(`
    <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
      <div style="text-align:center;">
        <h2>Escaneie o QR Code</h2>
        <p>Abra o WhatsApp > Aparelhos Conectados > Conectar Aparelho</p>
        <img src="${qrCodeData}" style="border: 8px solid white; border-radius: 12px; width: 280px; height: 280px;" />
        <script>setTimeout(() => location.reload(), 15000);</script>
      </div>
    </body></html>
  `);
});

app.post("/restart", (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (sock) sock.end();
  } catch (e) {}
  isConnected = false;
  setTimeout(startWhatsApp, 1000);
  res.json({ ok: true });
});

app.post("/logout", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (sock) await sock.logout();
  } catch (e) {}
  isConnected = false;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}
  setTimeout(startWhatsApp, 2000);
  res.json({ ok: true });
});

app.post("/config", (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (req.body?.rejectCalls !== undefined) rejectCalls = !!req.body.rejectCalls;
  if (req.body?.rejectMessage !== undefined) rejectMessage = String(req.body.rejectMessage);
  res.json({ ok: true });
});

app.post("/send", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });

  if (!sock || !isConnected) {
    return res.status(503).json({ error: "WhatsApp desconectado. Acesse /qr para escanear." });
  }

  const { number, text, imageUrl, imageBase64, buttonText, buttonUrl, footer } = req.body;
  if (!number || !text) {
    return res.status(400).json({ error: "Campos 'number' e 'text' são obrigatórios" });
  }

  try {
    const cleanNum = String(number).replace(/\D/g, "");
    const jid = `${cleanNum}@s.whatsapp.net`;

    let imageBuffer = null;
    if (imageBase64) {
      try {
        const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        const raw = matches ? matches[2] : imageBase64;
        imageBuffer = Buffer.from(raw, "base64");
      } catch (err) {
        console.error("Falha ao processar imageBase64:", err);
      }
    } else if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const arrBuf = await imgRes.arrayBuffer();
          imageBuffer = Buffer.from(arrBuf);
        }
      } catch (err) {
        console.warn("Falha ao baixar imagem:", err);
      }
    }

    let result;

    // 1. Mensagem com Botão de Ação: usa gifted-btns
    if (buttonText && buttonUrl) {
      const payload = {
        text: String(text),
        footer: footer ? String(footer) : "Forgent PRO",
        buttons: [
          {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
              display_text: String(buttonText),
              url: String(buttonUrl),
              merchant_url: String(buttonUrl),
            }),
          },
        ],
      };
      if (imageBuffer) payload.image = { buffer: imageBuffer };
      result = await sendButtons(sock, jid, payload);
    } 
    // 2. Mensagem com Imagem sem Botão: usa imagem nativa do Baileys
    else if (imageBuffer) {
      result = await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: String(text),
      });
    } 
    // 3. TEXTO PURO (CÓDIGO DE CONFIRMAÇÃO / TESTE): Baileys 100% nativo!
    else {
      result = await sock.sendMessage(jid, {
        text: String(text),
      });
    }

    return res.json({
      success: true,
      messageId: result?.key?.id || "sent",
    });
  } catch (error) {
    console.error("Erro no envio:", error);
    return res.status(500).json({
      error: error?.message || "Erro interno ao enviar mensagem",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
