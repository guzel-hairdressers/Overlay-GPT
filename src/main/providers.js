// ─── Provider Registry ────────────────────────────────────────────────────────

const BUILTIN = {
  deepseek: {
    name: 'DeepSeek',
    color: '#60a5fa',          // blue
    kind: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  gemini: {
    name: 'Gemini',
    color: '#6ee7b7',          // green
    kind: 'gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
  },
  openai: {
    name: 'OpenAI',
    color: '#a78bfa',          // purple
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini', 'o3']
  },
  anthropic: {
    name: 'Anthropic',
    color: '#fb923c',          // orange
    kind: 'anthropic',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5']
  }
};

// ─── Resolve active provider ──────────────────────────────────────────────────

function resolveProvider(config, id) {
  const providerId = id || config.activeProvider;

  // Built-in
  if (config.providers[providerId] && BUILTIN[providerId]) {
    const b = BUILTIN[providerId];
    const p = config.providers[providerId];
    return {
      id: providerId,
      kind: b.kind,
      name: b.name,
      color: b.color,
      endpoint: b.endpoint || null,
      apiKey: p.apiKey,
      model: p.model
    };
  }

  // Custom
  if (config.customProviders[providerId]) {
    const p = config.customProviders[providerId];
    return {
      id: providerId,
      kind: 'openai-compatible',
      name: p.name || providerId,
      color: p.color || '#f472b6',   // pink fallback
      endpoint: p.endpoint,
      apiKey: p.apiKey,
      model: p.model
    };
  }

  return null;
}

// ─── Audio policy ─────────────────────────────────────────────────────────────

function audioPolicy(provider) {
  switch (provider.kind) {
    case 'gemini':
      return { supported: true, note: null };
    case 'anthropic':
      return { supported: false, note: 'Anthropic does not accept audio input. Use /audio off or switch provider.' };
    case 'openai':
    case 'openai-compatible':
      // OpenAI needs gpt-4o-audio-preview for native audio; others may error
      if (provider.id === 'deepseek') {
        return { supported: false, note: 'DeepSeek does not accept audio input. Audio will be omitted.' };
      }
      return { supported: true, note: null };
    default:
      return { supported: false, note: null };
  }
}

// ─── Build multimodal turn ────────────────────────────────────────────────────

function buildTurn(provider, question, imageBase64, audioBase64, audioMimeType) {
  const turn = { text: question || '', image: imageBase64 || null, audio: null };

  if (audioBase64) {
    const pol = audioPolicy(provider);
    if (!pol.supported) {
      // Append note to text but continue without audio
      if (pol.note) {
        turn.text = `[Audio omitted: ${pol.note}]\n\n${turn.text}`;
      }
    } else {
      turn.audio = { data: audioBase64, mimeType: audioMimeType || 'audio/webm' };
    }
  }

  return turn;
}

// ─── History helpers ──────────────────────────────────────────────────────────

function trimHistory(history, maxTurns = 20) {
  while (history.length > maxTurns * 2) {
    history.shift();
    history.shift();
  }
}

function normalizeAnthropicHistory(history) {
  // Anthropic requires alternating user/assistant, starting with user
  const out = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (out.length > 0 && out[out.length - 1].role === role) {
      // Merge consecutive same-role messages
      out[out.length - 1].content += '\n\n' + h.content;
    } else {
      out.push({ role, content: h.content });
    }
  }
  // Ensure it starts with user
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(start of conversation)' });
  }
  return out;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(provider, history, turn) {
  const contents = [];

  // Prior turns (text-only)
  for (const h of history) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    });
  }

  // Current turn with multimedia
  const parts = [];
  if (turn.text) parts.push({ text: turn.text });
  if (turn.image) {
    parts.push({ inlineData: { mimeType: 'image/png', data: turn.image } });
  }
  if (turn.audio) {
    parts.push({ inlineData: { mimeType: turn.audio.mimeType, data: turn.audio.data } });
  }
  contents.push({ role: 'user', parts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`;

  const body = JSON.stringify({
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  const data = await res.json();
  if (data.error) {
    return { error: `Gemini: ${data.error.message || JSON.stringify(data.error)}` };
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { error: 'Gemini returned no text.' };
  return { answer: text };
}

// ─── OpenAI / DeepSeek / Custom (chat completions) ────────────────────────────

async function callChatCompletions(provider, history, turn) {
  const endpoint = provider.endpoint || 'https://api.openai.com/v1';
  const url = endpoint.endsWith('/chat/completions')
    ? endpoint
    : endpoint.replace(/\/$/, '') + '/chat/completions';

  const messages = [];

  // Prior turns (text-only)
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  // Current turn — build content array
  const contentParts = [];

  if (turn.text) {
    contentParts.push({ type: 'text', text: turn.text });
  }

  if (turn.image) {
    contentParts.push({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${turn.image}`,
        detail: 'low'
      }
    });
  }

  if (turn.audio) {
    // OpenAI-compatible audio (wav format expected from renderer)
    contentParts.push({
      type: 'input_audio',
      input_audio: {
        data: turn.audio.data,
        format: turn.audio.mimeType === 'audio/wav' ? 'wav' : 'mp3'
      }
    });
  }

  // If we have multimedia parts, use content array; otherwise plain text
  if (contentParts.length > 1 || turn.image || turn.audio) {
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: turn.text || '' });
  }

  const body = JSON.stringify({
    model: provider.model,
    messages,
    temperature: 0.7,
    max_tokens: 4096
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.apiKey}`
  };

  const res = await fetch(url, { method: 'POST', headers, body });
  const data = await res.json();

  if (data.error) {
    return { error: `${provider.name}: ${data.error.message || JSON.stringify(data.error)}` };
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { error: `${provider.name} returned no text.` };
  return { answer: text };
}

// ─── Anthropic (Messages) ─────────────────────────────────────────────────────

async function callAnthropic(provider, history, turn) {
  const url = 'https://api.anthropic.com/v1/messages';

  const anthropicHistory = normalizeAnthropicHistory(history);

  // Current turn
  const content = [];
  if (turn.text) content.push({ type: 'text', text: turn.text });
  if (turn.image) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: turn.image
      }
    });
  }
  // No audio block type in Anthropic — handled by audioPolicy

  const messages = [...anthropicHistory, { role: 'user', content }];

  const body = JSON.stringify({
    model: provider.model,
    max_tokens: 4096,
    messages
    // No temperature/top_p/top_k — rejected on Sonnet 5 / Opus 5
  });

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': '2023-06-01'
  };

  const res = await fetch(url, { method: 'POST', headers, body });
  const data = await res.json();

  if (data.error) {
    return { error: `Anthropic: ${data.error.message || JSON.stringify(data.error)}` };
  }
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  if (!text) return { error: 'Anthropic returned no text.' };
  return { answer: text };
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

async function callProvider(config, history, question, options = {}) {
  const { imageBase64, audioBase64, audioMimeType } = options;

  const provider = resolveProvider(config);
  if (!provider) {
    return { error: `Unknown active provider "${config.activeProvider}". Use /providers to list.` };
  }
  if (!provider.apiKey) {
    return { error: `No API key for ${provider.name}. Type /key ${provider.id} <key>` };
  }

  const turn = buildTurn(provider, question, imageBase64, audioBase64, audioMimeType);

  let result;
  try {
    if (provider.kind === 'gemini') {
      result = await callGemini(provider, history, turn);
    } else if (provider.kind === 'anthropic') {
      result = await callAnthropic(provider, history, turn);
    } else {
      result = await callChatCompletions(provider, history, turn);
    }
  } catch (err) {
    return { error: `Network error (${provider.name}): ${err.message}` };
  }

  if (result.error) return result;

  // Record in history
  if (question) {
    history.push({ role: 'user', content: question });
  } else {
    history.push({ role: 'user', content: turn.image ? '[screen capture]' : turn.audio ? '[audio recording]' : '[query]' });
  }
  history.push({ role: 'assistant', content: result.answer });
  trimHistory(history);

  return { answer: result.answer, provider: provider.id, model: provider.model };
}

// ─── List models ──────────────────────────────────────────────────────────────

async function fetchModels(config, providerId) {
  const provider = resolveProvider(config, providerId || config.activeProvider);
  if (!provider) return { error: 'Unknown provider.' };

  // Return static list for built-ins we know
  if (BUILTIN[provider.id] && BUILTIN[provider.id].models) {
    return { models: BUILTIN[provider.id].models };
  }

  // For custom, try the /models endpoint
  if (provider.endpoint && provider.apiKey) {
    try {
      const base = provider.endpoint.replace(/\/$/, '');
      const url = base.endsWith('/models') ? base : `${base}/models`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` }
      });
      const data = await res.json();
      const models = (data.data || []).map(m => m.id).sort();
      return { models: models.length ? models : ['(no models returned)'] };
    } catch (e) {
      return { error: `Could not fetch models: ${e.message}` };
    }
  }

  return { models: [] };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  BUILTIN,
  resolveProvider,
  callProvider,
  fetchModels,
  audioPolicy
};
