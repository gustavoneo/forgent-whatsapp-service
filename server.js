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
const CONFIG_FILE = path.join(AUTH_DIR, "..", "forgent-config.json");

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let config = { rejectCalls: false, rejectMessage: "" };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch {}

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function startSock() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      logger: pino({ level: "warn" }),
      auth: state,
      printQRInTerminal: false,
      browser: ["Forgent WhatsApp", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        try { qrCodeData = await QRCode.toDataURL(qr); } catch (e) { console.error("Erro QR:", e); }
      }
      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
        }
        setTimeout(startSock, 3000);
      } else if (connection === "open") {
        isConnected = true;
        qrCodeData = null;
        console.log("WhatsApp conectado!");
      }
    });

    // Recusa ligações automaticamente quando ativado na Central
    sock.ev.on("call", async (calls) => {
      if (!config.rejectCalls) return;
      for (const call of calls) {
        if (call.status !== "offer") continue;
        try {
          await sock.rejectCall(call.id, call.from);
          if (config.rejectMessage) await sock.sendMessage(call.from, { text: config.rejectMessage });
        } catch (e) { console.error("Erro ao recusar ligação:", e); }
      }
    });
  } catch (error) {
    console.error("Erro ao iniciar WhatsApp:", error);
    setTimeout(startSock, 5000);
  }
}

startSock();

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: "Não autorizado" });
  next();
}

app.get("/status", (req, res) => res.json({ connected: isConnected, hasQr: !!qrCodeData }));

// Usado pela Central: status, QR Code e número conectado
app.get("/info", requireApiKey, (req, res) => {
  const id = sock?.user?.id || "";
  res.json({
    connected: isConnected,
    qr: isConnected ? null : qrCodeData,
    number: isConnected ? id.split(":")[0].split("@")[0] : null,
    name: isConnected ? sock?.user?.name || null : null,
    rejectCalls: config.rejectCalls,
  });
});

app.post("/logout", requireApiKey, async (req, res) => {
  try { await sock?.logout(); } catch {}
  isConnected = false;
  res.json({ ok: true });
});

app.post("/restart", requireApiKey, async (req, res) => {
  try { sock?.end(new Error("restart")); } catch {}
  res.json({ ok: true });
});

app.post("/config", requireApiKey, (req, res) => {
  config = { rejectCalls: !!req.body.rejectCalls, rejectMessage: String(req.body.rejectMessage || "").slice(0, 1000) };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch (e) { console.error(e); }
  res.json({ ok: true });
});

app.get("/qr", (req, res) => {
  const page = (body, refresh) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>WhatsApp - Forgent</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#f8fafc}.card{background:#1e293b;padding:2rem;border-radius:1rem;text-align:center;max-width:420px}img{width:280px;height:280px;border-radius:.5rem;background:#fff;padding:.5rem}p{color:#94a3b8}</style></head><body><div class="card">${body}</div></body></html>`;
  if (isConnected) return res.send(page(`<h1>WhatsApp Conectado!</h1><p>Serviço funcionando.</p>`));
  if (qrCodeData) return res.send(page(`<h1>Conectar WhatsApp</h1><p>WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho</p><img src="${qrCodeData}" alt="QR Code WhatsApp" />`, 15));
  res.send(page(`<p>Gerando QR Code… aguarde.</p>`, 3));
});

app.post("/send", requireApiKey, async (req, res) => {
  try {
    if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp desconectado" });
    const { number, text, imageUrl, imageBase64, buttonText, buttonUrl, footer } = req.body;
    if (!number || !text) return res.status(400).json({ error: "Campos 'number' e 'text' são obrigatórios" });
    const jid = `${String(number).replace(/\D/g, "")}@s.whatsapp.net`;
    const payload = { text: String(text), footer: footer ? String(footer) : undefined };

    if (imageBase64) {
      const m = String(imageBase64).match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      payload.image = { buffer: Buffer.from(m ? m[2] : imageBase64, "base64") };
    } else if (imageUrl) {
      try {
        const r = await fetch(imageUrl);
        payload.image = r.ok ? { buffer: Buffer.from(await r.arrayBuffer()) } : { url: imageUrl };
      } catch { payload.image = { url: imageUrl }; }
    }

    if (buttonText && buttonUrl) {
      payload.buttons = [{
        name: "cta_url",
        buttonParamsJson: JSON.stringify({ display_text: String(buttonText), url: String(buttonUrl), merchant_url: String(buttonUrl) }),
      }];
    }

    let result;
    if (payload.buttons) {
      result = await sendButtons(sock, jid, payload);
    } else if (payload.image) {
      // Mensagem simples sem botão: foto + legenda
      result = await sock.sendMessage(jid, { image: payload.image.buffer ?? payload.image, caption: payload.text });
    } else {
      // Mensagem simples sem botão: só texto
      result = await sock.sendMessage(jid, { text: payload.text });
    }
    res.json({ success: true, messageId: result?.key?.id });
  } catch (error) {
    console.error("Erro no envio:", error);
    res.status(500).json({ error: error?.message || "Erro interno" });
  }
});

app.get("/", (req, res) => res.json({ name: "Forgent WhatsApp Button Service", status: isConnected ? "connected" : "waiting_qr" }));

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
