// ─── Provider Registry ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a real-time Zoom meeting assistant and screen observer.
Important Context: The incoming prompts may contain transcribed text from audio speech-to-text or screen OCR/vision transcriptions. Transcribed text may occasionally contain minor phonetic or OCR formatting artifacts. Please deduce the user's intended prompt, make sense of the transcribed context, and solve any visible code, errors, exercises, questions, or problems directly. Provide concise, clear, and actionable answers.`;

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
    models: ['gemini-2.5-flash', 'gemini-2.5-pro']
  },
  openai: {
    name: 'OpenAI',
    color: '#a78bfa',          // purple
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-4o', 'o4-mini']
  },
  anthropic: {
    name: 'Anthropic',
    color: '#fb923c',          // orange
    kind: 'anthropic',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5']
  },
  groq: {
    name: 'Groq',
    color: '#f97316',          // bright orange
    kind: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1',
    models: ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
  },
  openrouter: {
    name: 'OpenRouter',
    color: '#6366f1',          // indigo
    kind: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1',
    models: ['qwen/qwen-2.5-vl-72b-instruct:free', 'google/gemini-2.0-flash-exp:free', 'deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free']
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
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: turn.image } });
  }
  if (turn.audio) {
    parts.push({ inlineData: { mimeType: turn.audio.mimeType, data: turn.audio.data } });
  }
  contents.push({ role: 'user', parts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`;

  const body = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

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
        url: `data:image/jpeg;base64,${turn.image}`,
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

  // For Groq or text-only models, wrap image data into text string prompt to prevent 400 errors
  if (provider.id === 'groq' || (!turn.image && !turn.audio)) {
    let textPrompt = turn.text || '';
    if (turn.image && !textPrompt.includes('data:image')) {
      textPrompt = textPrompt
        ? `[Screenshot Image Attached (Base64 JPEG)]:\ndata:image/jpeg;base64,${turn.image}\n\n[User Question]: ${textPrompt}`
        : `[Screenshot Image Attached (Base64 JPEG)]:\ndata:image/jpeg;base64,${turn.image}\n\nPlease analyze and explain this screenshot in detail.`;
    }
    messages.push({ role: 'user', content: textPrompt || '[query]' });
  } else if (contentParts.length > 0) {
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
        media_type: 'image/jpeg',
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

  if (result.error) {
    const userMsg = question || (turn.image ? '[screen capture]' : turn.audio ? '[audio recording]' : '[query]');
    history.push({ role: 'user', content: userMsg });
    history.push({ role: 'assistant', content: `[Error] ${result.error}` });
    trimHistory(history);
    return result;
  }

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

// ─── Audio transcription bridge ──────────────────────────────────────────────

function supportsAudio(provider) {
  return provider && (provider.kind === 'gemini' || provider.kind === 'openai');
}

async function transcribeAudio(config, audioBase64, audioMimeType) {
  // Use Gemini for transcription since it supports audio natively
  const geminiProvider = resolveProvider(config, 'gemini');
  if (!geminiProvider || !geminiProvider.apiKey) {
    return { error: 'No Gemini API key configured. Set one with /key gemini <key> to enable audio transcription for this provider.' };
  }

  const model = 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiProvider.apiKey}`;

  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe this audio recording word-for-word. Return ONLY the transcript, no other text.' },
        { inlineData: { mimeType: audioMimeType || 'audio/webm', data: audioBase64 } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 }
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const data = await res.json();
    if (data.error) {
      return { error: `Gemini transcription failed: ${data.error.message || JSON.stringify(data.error)}` };
    }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { error: 'Gemini transcription returned no text.' };
    return { transcript: text.trim() };
  } catch (err) {
    return { error: `Transcription network error: ${err.message}` };
  }
}

// ─── Image / Screenshot transcription bridge (OpenRouter Qwen-VL / Gemini / Groq) ──

async function transcribeImageWithOpenRouter(provider, imageBase64) {
  const models = [
    'google/gemma-4-26b-a4b-it:free',
    'openrouter/free'
  ];

  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'You are a verbatim OCR and screen reader. Transcribe ALL visible text, code, numbers, UI labels, buttons, headers, error messages, and visual structure in this screenshot comprehensively and verbatim. Preserve code indentation, symbols, line numbers, and full questions exactly as shown on screen.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } }
            ]
          }],
          temperature: 0.1,
          max_tokens: 2048
        })
      });
      const data = await res.json();
      if (res.ok && data?.choices?.[0]?.message?.content) {
        return { transcript: data.choices[0].message.content.trim() };
      }
      if (data && data.error) {
        console.warn(`OpenRouter Vision (${model}) error:`, data.error.message || JSON.stringify(data.error));
      }
    } catch (e) {}
  }
  return null;
}

async function transcribeImageWithGemini(geminiProvider, imageBase64) {
  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiProvider.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: 'You are a verbatim OCR and screen reader. Transcribe ALL visible text, code, numbers, UI labels, buttons, headers, error messages, and visual structure in this screenshot comprehensively and verbatim. Preserve code indentation, symbols, line numbers, and full questions exactly as shown on screen.' },
              { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (res.ok && text) return { transcript: text.trim() };
    } catch (e) {}
  }
  return null;
}

async function transcribeImageWithGroq(groqProvider, imageBase64) {
  const model = groqProvider.model || 'qwen/qwen3.6-27b';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqProvider.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'You are a verbatim OCR and screen reader. Transcribe ALL visible text, code, numbers, UI labels, buttons, headers, error messages, and visual structure in this screenshot comprehensively and verbatim. Preserve code indentation, symbols, line numbers, and full questions exactly as shown on screen.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 2048
      })
    });

    const data = await res.json();
    if (res.ok && data?.choices?.[0]?.message?.content) {
      return { transcript: data.choices[0].message.content.trim() };
    }
    if (data && data.error) {
      return { error: `Groq (${model}): ${data.error.message || JSON.stringify(data.error)}` };
    }
  } catch (e) {
    return { error: `Groq Network Error: ${e.message}` };
  }
  return null;
}

function supportsVision(provider) {
  if (!provider) return false;
  const id = (provider.id || '').toLowerCase();
  if (['gemini', 'openai', 'anthropic'].includes(id)) return true;
  if (id === 'openrouter' && (provider.model || '').toLowerCase().includes('vl')) return true;
  return false;
}

async function transcribeImage(config, imageBase64) {
  // If active primary provider supports vision natively, skip background transcription!
  const active = resolveProvider(config);
  if (active && supportsVision(active)) {
    return { transcript: '[Native Vision Model - raw image attached directly]' };
  }

  // 1. Groq Qwen (qwen/qwen3.6-27b) FIRST — fast ultra-low-latency LPU transcription
  const groqProvider = resolveProvider(config, 'groq');
  if (groqProvider && groqProvider.apiKey) {
    const res = await transcribeImageWithGroq(groqProvider, imageBase64);
    if (res && res.transcript) return res;
    if (res && res.error) console.warn('Groq transcription failed:', res.error);
  }

  // 2. OpenRouter (google/gemma-4-26b-a4b-it:free) SECOND (fallback)
  const openrouterProvider = resolveProvider(config, 'openrouter');
  if (openrouterProvider && openrouterProvider.apiKey) {
    const res = await transcribeImageWithOpenRouter(openrouterProvider, imageBase64);
    if (res && res.transcript) return res;
    if (res && res.error) console.warn('OpenRouter transcription failed:', res.error);
  }

  return { error: '⚠️ Vision transcription failed. Please set a Groq key (/key groq <key>) or OpenRouter key (/key openrouter <key>).' };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  BUILTIN,
  resolveProvider,
  callProvider,
  fetchModels,
  audioPolicy,
  supportsAudio,
  supportsVision,
  transcribeAudio,
  transcribeImage
};
