import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const MODE = process.env.MODE || 'openai';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
  .replace(/\/$/, '');

export async function callModel(messages, { json = false } = {}) {
  switch (MODE) {
    case 'openai':
      return callOpenAICompatible({
        provider: 'OpenAI',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: process.env.OPENAI_API_KEY,
        model: OPENAI_MODEL,
        messages,
        json
      });
    case 'deepseek':
      return callOpenAICompatible({
        provider: 'DeepSeek',
        endpoint: `${DEEPSEEK_BASE_URL}/chat/completions`,
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: DEEPSEEK_MODEL,
        messages,
        json
      });
    case 'ollama':
    case 'local':
      return callOllama(messages, json);
    default:
      throw new Error(`Unsupported LLM MODE: ${MODE}`);
  }
}

async function callOpenAICompatible({
  provider,
  endpoint,
  apiKey,
  model,
  messages,
  json
}) {
  if (!apiKey) throw new Error(`${provider} API key is not configured.`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });

  const data = await response.json();
  if (!response.ok || !data.choices?.[0]?.message?.content) {
    throw new Error(`${provider} error: ${JSON.stringify(data)}`);
  }

  return data.choices[0].message.content;
}

async function callOllama(messages, json) {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      messages,
      ...(json ? { format: 'json' } : {})
    })
  });

  const data = await response.json();
  if (!response.ok || !data.message?.content) {
    throw new Error(`Ollama error: ${JSON.stringify(data)}`);
  }

  return data.message.content;
}
