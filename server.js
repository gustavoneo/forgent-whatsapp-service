const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("baileys");
const { sendButtons } = require("gifted-btns");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "forgent-secret-key";
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Forgent PRO", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrCodeData = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error("Erro ao gerar QR:", e);
      }
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexão fechada. Reconectar?", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        qrCodeData = null;
      }
    } else if (connection === "open") {
      console.log("WhatsApp conectado com sucesso!");
      isConnected = true;
      qrCodeData = null;
    }
  });
}

startWhatsApp();

app.get("/status", (req, res) => {
  res.json({ connected: isConnected });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2 style="color:green;">✅ WhatsApp Conectado!</h2>
        <p>A central Forgent PRO está pronta para enviar mensagens com botões.</p>
      </div>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2>Aguardando QR Code...</h2>
        <p>Recarregue em alguns segundos.</p>
        <script>setTimeout(() => location.reload(), 3000);</script>
      </div>
    `);
  }

  res.send(`
    <div style="font-family:sans-serif;text-align:center;margin-top:40px;">
      <h2>Escanear WhatsApp — Forgent PRO</h2>
      <p>Abra o WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
      <img src="${qrCodeData}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;" />
      <script>setTimeout(() => location.reload(), 20000);</script>
    </div>
  `);
});

app.post("/send", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });

  if (!sock || !isConnected) {
    return res.status(503).json({ error: "WhatsApp desconectado. Acesse /qr para escanear." });
  }

  const { number, text, imageUrl, buttonText, buttonUrl } = req.body;
  if (!number || !text) return res.status(400).json({ error: "number e text são obrigatórios" });

  try {
    const jid = `${number.replace(/\D/g, "")}@s.whatsapp.net`;

    const buttons = [];
    if (buttonText && buttonUrl) {
      buttons.push({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: buttonText,
          url: buttonUrl,
        }),
      });
    }

    const payload = {
      text: text,
      footer: "Forgent PRO",
      buttons: buttons,
    };

    if (imageUrl) {
      payload.image = { url: imageUrl };
    }

    const result = await sendButtons(sock, jid, payload);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Erro ao enviar:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
