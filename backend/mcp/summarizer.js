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

  const systemPrompt = `
You are an expert system that analyzes a user prompt, the tool called, and the raw tool result (in JSON) to generate a response.
You must output a valid JSON object with the following structure:
{
  "summary": "Friendly sentence, max 25 words, summarizing the result. Do not invent facts. No markdown.",
  "showList": false
}

Rules for "showList":
- Set "showList" to false if the user asked a yes/no question (e.g., "is X present?", "does Y exist?", "is there a Z?"), a count question (e.g., "how many X?"), or a question about a single specific item's status/details/expiry (e.g., "what is the status of lock Y?", "show details of package Z").
- Set "showList" to true only if the user explicitly asked to "list", "show", "get", "find", or "search" multiple items, or requested the collection of items where they expect to browse or choose from them.
`.trim();

  try {
    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: SUMMARIZER_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: JSON.stringify({
              userAskedFor: prompt,
              toolUsed: toolName,
              result: rawData
            })
          }
        ],
        max_tokens: 1000
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

    const content = response.data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    let cleanContent = content;
    if (cleanContent.startsWith("```")) {
      cleanContent = cleanContent.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    try {
      const parsed = JSON.parse(cleanContent);
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
        showList: typeof parsed.showList === "boolean" ? parsed.showList : true
      };
    } catch (e) {
      console.warn("Failed to parse summarizer JSON output:", e.message);
      return {
        summary: cleanContent,
        showList: true
      };
    }
  } catch (error) {
    console.warn("MCP summarizer failed:", error.response?.data || error.message);
    return null;
  }
};

module.exports = { summarizeToolResult };
