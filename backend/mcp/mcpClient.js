require("dotenv").config();

const axios = require("axios");
const { getMcpToolsForOpenRouter } = require("./toolRegistry");
const { configureToolHandlers, executeMcpTool } = require("./toolHandlers");
const { summarizeToolResult } = require("./summarizer");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY;
const AI_INTENT_APP_URL = process.env.AI_INTENT_APP_URL || "http://localhost:5173";
const AI_INTENT_APP_NAME = process.env.AI_INTENT_APP_NAME || "Tenant Access";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_CHAIN = [
  process.env.AI_INTENT_MODEL || "nex-agi/nex-n2-pro:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-flash-1.5:free",
  "mistralai/mistral-7b-instruct:free"
].filter((model, index, models) => model && models.indexOf(model) === index);

const MCP_SYSTEM_PROMPT = `
You are a helpful assistant for SAP Integration Suite operations.
Use tools for live tenant questions about packages, artifacts, monitoring logs, JMS queues, JMS messages, resources, exports, downloads, and email actions.
Fill only parameters clearly stated by the user.
Do not guess required queue names, message IDs, target queues, or email addresses.
For action tools with missing required parameters, ask a short clarification question instead of calling a tool.
For greetings and general non-tenant chat, answer normally without a tool.
`.trim();

const configureMcpTools = (dependencies) => {
  configureToolHandlers(dependencies);
};

const callOpenRouterWithTools = async ({ messages, tools, model }) => {
  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      temperature: 0.2,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1000
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": AI_INTENT_APP_URL,
        "X-Title": AI_INTENT_APP_NAME
      },
      timeout: 20000
    }
  );

  return response.data?.choices?.[0]?.message || null;
};

const parseToolArguments = (toolCall) => {
  try {
    return JSON.parse(toolCall?.function?.arguments || "{}");
  } catch {
    return {};
  }
};

const promptHeuristicSaysNoList = (prompt) => {
  const normalized = String(prompt || "").trim().toLowerCase();
  return (
    normalized.includes("present") ||
    normalized.includes("exist") ||
    normalized.includes("there are") ||
    normalized.includes("how many") ||
    normalized.includes("count") ||
    normalized.includes("status of") ||
    normalized.includes("detail of") ||
    /^is\s/i.test(normalized) ||
    /^does\s/i.test(normalized) ||
    /^has\s/i.test(normalized)
  );
};

const runMcpChat = async ({ prompt, tenantContext }) => {
  if (!OPENAI_API_KEY) {
    return {
      message: "AI is not configured. Add OPENAI_API_KEY or AI_INTENT_API_KEY to the backend .env file.",
      items: [],
      actions: []
    };
  }

  const messages = [
    { role: "system", content: MCP_SYSTEM_PROMPT },
    { role: "user", content: prompt }
  ];
  const tools = getMcpToolsForOpenRouter();
  let aiMessage = null;
  let usedModel = null;

  for (const model of MODEL_CHAIN) {
    try {
      aiMessage = await callOpenRouterWithTools({ messages, tools, model });
      usedModel = model;
      if (aiMessage) break;
    } catch (error) {
      console.warn(`MCP model ${model} failed:`, error.response?.data || error.message);
    }
  }

  if (!aiMessage) {
    return {
      message: "I could not reach the AI service. Check the OpenRouter key and model configuration.",
      items: [],
      actions: []
    };
  }

  const toolCall = aiMessage.tool_calls?.[0];
  if (!toolCall) {
    return {
      message: aiMessage.content || "I could not understand that request.",
      items: [],
      actions: [],
      debug: { tool: "none", model: usedModel }
    };
  }

  const toolName = toolCall.function?.name;
  const toolParams = parseToolArguments(toolCall);
  let toolResult;

  try {
    toolResult = await executeMcpTool(toolName, toolParams, tenantContext);
  } catch (error) {
    return {
      message: `Error running ${toolName}: ${error.response?.data?.message || error.message}`,
      items: [],
      actions: [],
      debug: { tool: toolName, model: usedModel, params: toolParams }
    };
  }

  if (toolResult.error || toolResult.needsClarification) {
    return {
      message: toolResult.error || toolResult.message || "Please provide a little more detail.",
      items: toolResult.items || [],
      actions: toolResult.actions || [],
      debug: { tool: toolName, model: usedModel, params: toolParams }
    };
  }

  const summaryResult = await summarizeToolResult({
    prompt,
    toolName,
    rawData: toolResult.rawData
  });

  const showList = summaryResult ? summaryResult.showList : !promptHeuristicSaysNoList(prompt);
  const summaryText = summaryResult ? summaryResult.summary : null;

  return {
    message: summaryText || toolResult.message || `Done: ${toolName}`,
    items: showList ? (toolResult.items || []) : [],
    pendingItems: showList ? (toolResult.pendingItems || []) : [],
    actions: toolResult.actions || [],
    debug: { tool: toolName, model: usedModel, params: toolParams }
  };
};

module.exports = { configureMcpTools, runMcpChat, promptHeuristicSaysNoList };
