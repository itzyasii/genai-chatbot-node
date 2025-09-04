import express from "express";
import { configDotenv } from "dotenv";
import cors from "cors";
import fetch from "node-fetch"; // If Node <18, otherwise native fetch works
import logger from "./logger.js";

configDotenv();

const app = express();

// ...existing code...

app.use(cors());
app.use(express.json());

// Toggle which backend to use
const USE_OLLAMA = true;

// Store conversation history per session (bounded)
const conversationHistory = {};
const MAX_HISTORY = parseInt(process.env.MAX_CONVERSATION_HISTORY || "20", 10);
// Using Ollama only; no OpenAI fallback

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!message || typeof message !== "string" || message.trim() === "")
    return res.status(400).json({ error: "User message is required" });

  logger.info(`📩 [${sessionId}] Message:`, message);

  // Init session history if new
  if (!conversationHistory[sessionId]) {
    conversationHistory[sessionId] = [];
  }
  conversationHistory[sessionId].push({ role: "user", content: message });
  // Trim history to last MAX_HISTORY entries (keep role order)
  if (conversationHistory[sessionId].length > MAX_HISTORY) {
    conversationHistory[sessionId] = conversationHistory[sessionId].slice(
      -MAX_HISTORY
    );
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  logger.debug(`🔔 [${sessionId}] SSE headers set, starting stream to client`);
  res.flushHeaders?.();

  try {
    if (USE_OLLAMA) {
      // --- OLLAMA STREAMING ---
      logger.debug(
        `👉 [${sessionId}] Sending request to Ollama with ${conversationHistory[sessionId].length} messages`
      );
      const response = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-r1:8b",
          messages: conversationHistory[sessionId],
          stream: true,
        }),
      });

      logger.debug(
        `👈 [${sessionId}] Ollama responded: ${response.status} ${response.statusText}`
      );
      if (!response.ok) {
        const bodyText = await response.text();
        logger.error(
          `❗ [${sessionId}] Ollama returned non-OK: ${response.status} ${response.statusText} - body:`,
          bodyText
        );
        // Notify client of model error and end stream
        res.write(
          `event: error\ndata: ${JSON.stringify(
            "Model error: " + (bodyText || response.statusText)
          )}\n\n`
        );
        res.end();
        return;
      }
      if (!response.body) throw new Error("No response body from Ollama");

      let assistantMessage = "";

      // ✅ Node.js way of streaming
      for await (const chunk of response.body) {
        const raw = chunk.toString("utf8");
        const str = raw.trim();
        logger.debug(
          `🔸 [${sessionId}] Received chunk (bytes=${chunk.length}):`,
          str.slice(0, 200)
        );
        if (!str) continue;

        for (const line of str.split("\n")) {
          if (!line) continue;
          try {
            const json = JSON.parse(line);
            logger.debug(
              `🔎 [${sessionId}] Parsed JSON chunk:`,
              Object.keys(json)
            );

            if (json.message?.content) {
              const part = json.message.content;
              assistantMessage += part;
              logger.debug(
                `✉️  [${sessionId}] Forwarding part to client (len=${part.length})`
              );
              res.write(`data: ${JSON.stringify(part)}\n\n`);
            }

            if (json.done) {
              logger.info(
                `✅ [${sessionId}] Ollama signaled done, total assistant length=${assistantMessage.length}`
              );
              conversationHistory[sessionId].push({
                role: "assistant",
                content: assistantMessage,
              });
              res.write(`data: ${JSON.stringify("[DONE]")}\n\n`);
              res.end();
              return;
            }
          } catch (e) {
            logger.error(
              `❗ [${sessionId}] Ollama JSON parse error for line:`,
              line.slice(0, 200),
              e.message
            );
          }
        }
      }

      // If stream ended without an explicit done flag, finalize
      logger.info(
        `ℹ️  [${sessionId}] Ollama stream ended, finalizing. total assistant length=${assistantMessage.length}`
      );
      conversationHistory[sessionId].push({
        role: "assistant",
        content: assistantMessage,
      });
      res.write(`data: ${JSON.stringify("[DONE]")}\n\n`);
      res.end();
    } else {
      // No other backends configured
      res.write(
        `event: error\ndata: ${JSON.stringify(
          "No model backend available"
        )}\n\n`
      );
      res.end();
    }
  } catch (err) {
    logger.error("❌ Chat error:", err);
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    res.end();
  }
});

app.listen(process.env.PORT || 5000, () => {
  logger.info(`🚀 Server is running on port ${process.env.PORT || 5000}`);
});
