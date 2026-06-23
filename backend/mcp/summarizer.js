const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY;
const AI_INTENT_APP_URL = process.env.AI_INTENT_APP_URL || "http://localhost:5173";
const AI_INTENT_APP_NAME = process.env.AI_INTENT_APP_NAME || "Tenant Access";
const SUMMARIZER_MODEL =
  process.env.AI_SUMMARIZER_MODEL || process.env.AI_INTENT_MODEL || "nex-agi/nex-n2-pro:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const summarizeToolResult = async ({ prompt, toolName, rawData }) => {
  if (!OPENAI_API_KEY || !rawData) {
    return null;
  }

  try {
    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: SUMMARIZER_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Write one friendly sentence, max 25 words, summarizing only the provided JSON result. Do not invent numbers, names, or actions. No markdown."
          },
          {
            role: "user",
            content: JSON.stringify({
              userAskedFor: prompt,
              toolUsed: toolName,
              result: rawData
            })
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": AI_INTENT_APP_URL,
          "X-Title": AI_INTENT_APP_NAME
        },
        timeout: 10000
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.warn("MCP summarizer failed:", error.response?.data || error.message);
    return null;
  }
};

module.exports = { summarizeToolResult };
