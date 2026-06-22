import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize GoogleGenAI SDK with server-safe key
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// API endpoint: Standard Chat
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, model, systemInstruction } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const selectedModel = model || "gemini-3.5-flash";
    let actualModel = "gemini-3.5-flash";

    // Use gemini-3.5-flash as the fallback high-speed model
    if (selectedModel.toLowerCase().includes("pro")) {
      actualModel = "gemini-3.5-flash"; 
    }

    // Convert messages to GenAI SDK contents format (user -> user, assistant -> model)
    const contents = messages.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }],
    }));

    const response = await ai.models.generateContent({
      model: actualModel,
      contents,
      config: {
        systemInstruction:
          systemInstruction ||
          "You are Pi AI, a highly intelligent engineering session assistant. Help the user build projects, configure environments, structure code, and manage engineering workflows.",
        temperature: 0.7,
      },
    });

    res.json({
      role: "assistant",
      content: response.text || "Hello! I am ready to assist with this session.",
    });
  } catch (error: any) {
    console.error("AI Chat Error:", error);
    res.status(500).json({
      error: error.message || "Failed to generate AI response. Make sure GEMINI_API_KEY is configured.",
    });
  }
});

// API endpoint: Live Code / Git Diff Generator
app.post("/api/generate-diff", async (req, res) => {
  try {
    const { messages, sessionName } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array are required for context" });
    }

    const chatContext = messages
      .slice(-6) // take last 6 messages to stay fast and descriptive
      .map((m: any) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n");

    const prompt = `Given the active coding session titled "${sessionName || "Active Dev Session"}" and the following dialogue:

${chatContext}

Generate a beautiful, clean, valid Unified Git Diff (.patch syntax) of changes that we can showcase to the user under their 'Git Diff' tab. 
Make sure it features actual changes discussed or a helpful, highly detailed snippet block associated with the topic of discussion.
Write code files that look realistic (e.g. index.tsx, server.ts, utils/helpers.ts) with proper insertion headers + / - indicators.

Return ONLY the raw git diff text. DO NOT start or wrap it with markdown markers like \`\`\`diff or \`\`\`. Start directly with 'diff --git a/src/...'.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are a master Git version control generator. Output ONLY realistic raw unified git diffs.",
        temperature: 0.2,
      },
    });

    res.json({ diff: response.text || "No diff generated yet for this session." });
  } catch (error: any) {
    console.error("Git Diff Generation Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate session diff." });
  }
});

// API endpoint: Smart Session Metadata Analyzer
app.post("/api/analyze-session", async (req, res) => {
  try {
    const { messages, sessionName } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const chatContext = messages
      .slice(-8)
      .map((m: any) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n");

    const prompt = `Analyze the following chat context for the session titled "${sessionName || "Active Dev Session"}":

${chatContext}

Extract:
1. A concise description (2-3 sentences) of the current development status and priorities.
2. An estimated completion/progress percentage (from 0 to 100).
3. A list of 3-4 key milestones or core tasks being tracked.
4. An authoritative responsible role or name for this session (e.g., Lead Architect, Junior Engineer, security lead).

Return a valid JSON object matching the requested schema description.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            progressPercentage: { type: Type.INTEGER },
            keyTasks: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            suggestedResponsible: { type: Type.STRING },
          },
          required: ["description", "progressPercentage", "keyTasks", "suggestedResponsible"],
        },
        temperature: 0.3,
      },
    });

    const parsedData = JSON.parse(response.text || "{}");
    res.json(parsedData);
  } catch (error: any) {
    console.error("Session analysis error:", error);
    res.status(500).json({ error: error.message || "Failed to analyze chat sessions." });
  }
});

// Setup Vite & Dynamic Router & WebSocket Server
async function startServer() {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");

    ws.on("message", async (data) => {
      try {
        const payload = JSON.parse(data.toString());

        if (payload.type === "chat") {
          const { messages, model, systemInstruction } = payload;
          if (!messages || !Array.isArray(messages)) {
            ws.send(JSON.stringify({ type: "error", message: "messages array is required" }));
            return;
          }

          const selectedModel = model || "gemini-3.5-flash";
          let actualModel = "gemini-3.5-flash";

          if (selectedModel.toLowerCase().includes("pro")) {
            actualModel = "gemini-3.1-pro-preview"; // Use 3.1 pro for pro requests or fall back nicely
          }

          // Convert messages to GenAI SDK contents format (user -> user, assistant -> model)
          const contents = messages.map((m: any) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content || "" }],
          }));

          const responseStream = await ai.models.generateContentStream({
            model: actualModel,
            contents,
            config: {
              systemInstruction:
                systemInstruction ||
                "You are Pi AI, a highly intelligent engineering session assistant. Help the user build projects, configure environments, structure code, and manage engineering workflows.",
              temperature: 0.7,
            },
          });

          let fullText = "";
          for await (const chunk of responseStream) {
            const text = chunk.text || "";
            fullText += text;
            ws.send(JSON.stringify({ type: "chunk", text }));
          }

          ws.send(JSON.stringify({ type: "done", fullText }));
        }
      } catch (error: any) {
        console.error("WS streaming error:", error);
        ws.send(JSON.stringify({ type: "error", message: error.message || "Failed to generate AI stream response." }));
      }
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/api/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Pi Session Manager server with WebSocket streaming running on http://localhost:${PORT}`);
  });
}

startServer();
