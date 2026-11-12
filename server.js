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

    // 1. Se tem botão interativo, usa gifted-btns
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
    // 2. Se tem imagem sem botão, envia mídia nativa com legenda
    else if (imageBuffer) {
      result = await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: String(text),
      });
    } 
    // 3. Se é apenas texto (CÓDIGO OTP / TESTES), envia texto 100% nativo!
    else {
      result = await sock.sendMessage(jid, {
        text: String(text),
      });
    }

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
