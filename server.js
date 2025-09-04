import express from "express";
import { configDotenv } from "dotenv";
import cors from "cors";
import fetch from "node-fetch"; // If Node <18, otherwise native fetch works
import logger from "./logger.js";

configDotenv();

const app = express();

app.use(
  cors({
    origin: ["https://chat-my-ai.netlify.app", "http://localhost:5173"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

const USE_OLLAMA = false; // Set to false to test Gemini

const conversationHistory = {};
const MAX_HISTORY = parseInt(process.env.MAX_CONVERSATION_HISTORY || "20", 10);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!message || typeof message !== "string" || message.trim() === "")
    return res.status(400).json({ error: "User message is required" });

  logger.info(`📩 [${sessionId}] Message:`, message);

  if (!conversationHistory[sessionId]) {
    conversationHistory[sessionId] = [];
  }
  conversationHistory[sessionId].push({ role: "user", content: message });
  if (conversationHistory[sessionId].length > MAX_HISTORY) {
    conversationHistory[sessionId] = conversationHistory[sessionId].slice(
      -MAX_HISTORY
    );
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  logger.debug(`🔔 [${sessionId}] SSE headers set, starting stream to client`);
  res.flushHeaders?.();

  try {
    if (USE_OLLAMA) {
      // ... (Ollama code remains unchanged)
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
      // Gemini Setup ===================
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No Gemini API key in env");

      // Helper to convert conversation history to Gemini's format
      const toGeminiFormat = (history) => {
        return history.map((entry) => {
          if (entry.role === "user") {
            return { role: "user", parts: [{ text: entry.content }] };
          } else if (entry.role === "assistant") {
            return { role: "model", parts: [{ text: entry.content }] };
          }
          return entry;
        });
      };

      const GEMINI_MODEL = "gemini-2.5-pro";

      logger.debug(
        `👉 [${sessionId}] Sending request to Gemini with ${conversationHistory[sessionId].length} messages using model: ${GEMINI_MODEL}`
      );

      const geminiContents = toGeminiFormat(conversationHistory[sessionId]);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: geminiContents,
          }),
        }
      );

      logger.debug(
        `👈 [${sessionId}] Gemini responded: ${response.status} ${response.statusText}`
      );
      if (!response.ok) {
        const bodyText = await response.text();
        logger.error(
          `❗ [${sessionId}] Gemini returned non-OK: ${response.status} ${response.statusText} - body:`,
          bodyText
        );
        res.write(
          `event: error\ndata: ${JSON.stringify(
            "Model error: " + (bodyText || response.statusText)
          )}\n\n`
        );
        res.end();
        return;
      }
      if (!response.body) throw new Error("No response body from Gemini");

      let assistantMessage = "";
      let buffer = ""; // Buffer to accumulate partial JSON data

      for await (const chunk of response.body) {
        buffer += chunk.toString("utf8");
        logger.debug(
          `🔸 [${sessionId}] Current buffer content (len=${buffer.length}):`,
          buffer.slice(0, 200)
        );

        // Regular expression to find complete JSON objects in the buffer
        // This pattern looks for an object starting with '{' and ending with '}',
        // ensuring it handles nested structures and doesn't stop prematurely.
        // It's a bit tricky with simple regex, but we'll try to get complete top-level objects.
        // A more robust solution might use a proper streaming JSON parser library.

        // For Google's Generative AI stream, each chunk often contains a *single* complete JSON object.
        // The issue likely comes from `str.split('\n')` assuming too much,
        // or leading/trailing non-JSON characters.

        // Let's simplify and directly try to parse the buffer as a whole if it looks like a complete object.
        // Or, more accurately, handle chunks that might be partial.
        // The typical stream format from Gemini is `{"chunk":...}\n{"chunk2":...}\n`
        // or sometimes just concatenated: `{"chunk":...}{"chunk2":...}`.

        // The simplest and often most effective way for *these* errors is to treat each chunk as a potential full object
        // but handle the case where it might be a partial or concatenated.

        // A common pattern for streaming responses that send discrete JSON objects
        // is to use a custom parser that can identify complete objects.
        // Given the error `Unexpected non-whitespace character after JSON`, it suggests `JSON.parse` is fed a string
        // that looks like `{...}other_stuff`.

        // Let's try to extract JSON objects more carefully.
        // The Google Generative AI streaming generally sends each `GenerateContentResponse` as a separate JSON string,
        // usually separated by newlines, but sometimes they can be concatenated.

        let lastIndex = 0;
        while (true) {
          const startIndex = buffer.indexOf("{", lastIndex);
          if (startIndex === -1) break; // No more potential JSON objects

          let braceCount = 0;
          let inString = false;
          let endIndex = -1;

          for (let i = startIndex; i < buffer.length; i++) {
            const char = buffer[i];
            if (char === '"' && buffer[i - 1] !== "\\") {
              inString = !inString;
            } else if (!inString) {
              if (char === "{") {
                braceCount++;
              } else if (char === "}") {
                braceCount--;
              }
            }

            if (braceCount === 0 && char === "}") {
              endIndex = i;
              break;
            }
          }

          if (endIndex !== -1) {
            const jsonString = buffer.substring(startIndex, endIndex + 1);
            try {
              const json = JSON.parse(jsonString);
              logger.debug(
                `🔎 [${sessionId}] Parsed Gemini JSON chunk:`,
                Object.keys(json)
              );

              if (
                json.candidates &&
                json.candidates[0]?.content?.parts[0]?.text
              ) {
                const part = json.candidates[0].content.parts[0].text;
                assistantMessage += part;
                logger.debug(
                  `✉️  [${sessionId}] Forwarding part to client (len=${part.length})`
                );
                res.write(`data: ${JSON.stringify(part)}\n\n`);
              }
            } catch (e) {
              logger.error(
                `❗ [${sessionId}] Gemini JSON parse error for extracted string:`,
                jsonString.slice(0, 200),
                e.message
              );
            }
            lastIndex = endIndex + 1; // Move past the parsed object
          } else {
            // No complete JSON object found from this start index,
            // or it's incomplete. Break and wait for more data.
            break;
          }
        }
        // Keep the remaining part in the buffer for the next chunk
        buffer = buffer.substring(lastIndex);
      }

      logger.info(
        `✅ [${sessionId}] Gemini stream ended, total assistant length=${assistantMessage.length}`
      );
      conversationHistory[sessionId].push({
        role: "assistant",
        content: assistantMessage,
      });
      res.write(`data: ${JSON.stringify("[DONE]")}\n\n`);
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
