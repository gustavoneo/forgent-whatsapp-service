const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
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
let isReconnecting = false;
let rejectCalls = false;
let rejectMessage =
  "Olá! Este número é exclusivo para avisos e cobranças automáticas e não recebe ligações. Por favor, envie uma mensagem de texto. 🙏";

async function startWhatsApp() {
  if (isReconnecting) return;
  isReconnecting = true;

  // Encerra socket anterior para evitar duplicidade de robôs
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch (e) {}
    sock = null;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    // Busca a versão Web mais recente e oficial aceita pela Meta
    let waVersion = [2, 3000, 1015901307];
    try {
      const { version, isLatest } = await fetchLatestBaileysVersion();
      if (version) {
        waVersion = version;
        console.log(`[WhatsApp] Usando versão Web oficial: ${version.join(".")}, é a mais recente: ${isLatest}`);
      }
    } catch (verErr) {
      console.warn("[WhatsApp] Não foi possível buscar versão remota, usando fallback:", verErr.message);
    }

    sock = makeWASocket({
      version: waVersion,
      auth: state,
      logger: pino({ level: "warn" }),
      printQRInTerminal: false,
      browser: Browsers.macOS("Desktop"),
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    // ==========================================
    // RECONHECIMENTO DE CÓDIGO DE ENTRADA (INBOUND)
    // ==========================================
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (m.key.fromMe) continue;

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          "";

        // Filtra siglas de 3 letras + 5 números (ex: UPL-48291, upl 48291, UPL48291)
        if (!/[A-Za-z]{3}\s*-?\s*\d{5}/i.test(text)) continue;

        const jid = m.key.remoteJid || "";
        if (!jid || jid.includes("@broadcast")) continue;

        let from = jid;
        if (jid.endsWith("@lid")) {
          from = m.key.remoteJidAlt || m.key.senderPn || "";
          if (!from) {
            try {
              from = (await sock.signalRepository?.lidMapping?.getPNForLID?.(jid)) || "";
            } catch (e) {}
          }
          if (!from) {
            console.warn("Não foi possível resolver LID para:", jid);
            continue;
          }
        }

        try {
          const r = await fetch("https://painel.forgent.pro/api/public/v1/phone/inbound", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.API_KEY || API_KEY,
            },
            body: JSON.stringify({ from, text }),
          });

          const j = await r.json();
          if (j.matched && j.reply) {
            await sock.sendMessage(jid, { text: j.reply });
          }
        } catch (e) {
          console.error("Erro no inbound:", e.message);
        }
      }
    });

    // ==========================================
    // STATUS DA CONEXÃO
    // ==========================================
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
        } catch (err) {
          console.error("Erro ao gerar QR Code:", err);
        }
      }

      if (connection === "close") {
        isConnected = false;
        isReconnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WhatsApp] Conexão fechada. Motivo: ${statusCode}. Reconectar: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
        }

        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        }
      } else if (connection === "open") {
        isConnected = true;
        isReconnecting = false;
        qrCodeData = null;
        console.log(`[WhatsApp] Conectado com sucesso como: ${sock?.user?.id || "Desconhecido"}`);
      }
    });

    // ==========================================
    // REJEIÇÃO AUTOMÁTICA DE LIGAÇÕES
    // ==========================================
    sock.ev.on("call", async (calls) => {
      if (!rejectCalls) return;
      for (const call of calls) {
        if (call.status === "offer") {
          try {
            await sock.rejectCall(call.id, call.from);
            if (rejectMessage) {
              await sock.sendMessage(call.from, { text: rejectMessage });
            }
          } catch (e) {
            console.error("Erro ao rejeitar chamada:", e.message);
          }
        }
      }
    });
  } catch (error) {
    console.error("[WhatsApp] Erro fatal ao iniciar socket:", error);
    isReconnecting = false;
    setTimeout(startWhatsApp, 5000);
  }
}

// Inicia o serviço
startWhatsApp();

// ==========================================
// ROTAS DA API
// ==========================================

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    hasQr: !!qrCodeData,
  });
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
          <h2>Gerando QR Code...</h2>
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
        <img src="${qrCodeData}" style="width:300px;height:300px;border-radius:8px;background:#fff;padding:10px;" />
        <p style="color:#888;">Atualiza automaticamente</p>
        <script>setTimeout(() => location.reload(), 20000);</script>
      </div>
    </body></html>
  `);
});

app.post("/restart", (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  isReconnecting = false;
  setTimeout(startWhatsApp, 1000);
  res.json({ ok: true });
});

app.post("/logout", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  isConnected = false;
  isReconnecting = false;
  try {
    if (sock) await sock.logout();
  } catch (e) {}
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
    
    // Consulta a Meta para pegar o JID canônico e ativo do contato
    let targetJid = `${cleanNum}@s.whatsapp.net`;
    try {
      const [lookup] = await sock.onWhatsApp(cleanNum);
      if (lookup && lookup.exists && lookup.jid) {
        targetJid = lookup.jid;
      }
    } catch (e) {
      console.warn("[WhatsApp] onWhatsApp falhou para:", cleanNum, e.message);
    }

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
      result = await sendButtons(sock, targetJid, payload);
    } 
    // 2. Mensagem com Imagem sem Botão: usa imagem nativa do Baileys
    else if (imageBuffer) {
      result = await sock.sendMessage(targetJid, {
        image: imageBuffer,
        caption: String(text),
      });
    } 
    // 3. TEXTO PURO: Baileys 100% nativo
    else {
      result = await sock.sendMessage(targetJid, {
        text: String(text),
      });
    }

    console.log(`[WhatsApp] Mensagem enviada para ${targetJid}, ID: ${result?.key?.id}`);

    return res.json({
      success: true,
      messageId: result?.key?.id || "sent",
    });
  } catch (error) {
    console.error("[WhatsApp] Erro no envio:", error);
    return res.status(500).json({
      error: error?.message || "Erro interno ao enviar mensagem",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
