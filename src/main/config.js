const path = require('path');
const fs = require('fs');

// ─── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  providers: {
    deepseek:  { apiKey: '', model: 'deepseek-chat' },
    gemini:     { apiKey: '', model: 'gemini-2.0-flash' },
    openai:     { apiKey: '', model: 'gpt-5.6-luna' },
    anthropic:  { apiKey: '', model: 'claude-sonnet-5' },
    groq:       { apiKey: '', model: 'qwen/qwen3.6-27b' },
    openrouter: { apiKey: '', model: 'google/gemma-4-26b-a4b-it:free' }
  },
  customProviders: {
    gemma: {
      name: 'Local Gemma 4 E2B',
      endpoint: 'http://localhost:9379/v1',
      apiKey: 'local',
      model: 'gemma-4-e2b-it'
    }
  },
  activeProvider: 'groq',
  muted: false,
  disabled: false,
  stealthOpacity: 0.15,
  activeOpacity: 0.85,
  audioSource: 'mic',            // 'mic' | 'system' | 'both' | 'off'
  autoChunks: true,              // auto-stop system recording on sustained silence
  maxRecordingSeconds: 120,
  theme: 'dark',                // 'dark' | 'light'
  screenResolution: '480p',     // '360p' | '480p' | '720p' | '1080p' | 'native'
  email: 'fazulzyanov.nf65@gmail.com',
  modes: {},
  activeMode: null,
  prompts: {
    system: 'You are a real-time Zoom meeting assistant and screen observer.\nImportant Context: The incoming prompts may contain transcribed text from audio speech-to-text or screen OCR/vision transcriptions. Transcribed text may occasionally contain minor phonetic or OCR formatting artifacts. Please deduce the user\'s intended prompt, make sense of the transcribed context, and solve any visible code, errors, exercises, questions, or problems directly. Provide concise, clear, and actionable answers.',
    audio: 'Transcribe this audio recording word-for-word. Return ONLY the transcript, no other text.',
    image: 'You are a verbatim OCR and screen reader. Transcribe ALL visible text, code, numbers, UI labels, buttons, headers, error messages, and visual structure in this screenshot comprehensively and verbatim. Preserve code indentation, symbols, line numbers, and full questions exactly as shown on screen.'
  }
};

// ─── Mode defaults ─────────────────────────────────────────────────────────────

function getModeDefaults() {
  return {
    prompts: {
      system: DEFAULT_CONFIG.prompts.system,
      audio: DEFAULT_CONFIG.prompts.audio,
      image: DEFAULT_CONFIG.prompts.image
    },
    settings: {
      screenResolution: DEFAULT_CONFIG.screenResolution,
      audioSource: DEFAULT_CONFIG.audioSource,
      autoChunks: DEFAULT_CONFIG.autoChunks,
      maxRecordingSeconds: DEFAULT_CONFIG.maxRecordingSeconds,
      stealthOpacity: DEFAULT_CONFIG.stealthOpacity,
      theme: DEFAULT_CONFIG.theme,
      activeProvider: DEFAULT_CONFIG.activeProvider
    },
    providerModels: {}
  };
}

// ─── Deep merge ────────────────────────────────────────────────────────────────

function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key]) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], patch[key]);
    } else {
      out[key] = patch[key];
    }
  }
  return out;
}

// ─── Migration ─────────────────────────────────────────────────────────────────

function migrateLegacy(raw) {
  // Legacy: top-level geminiApiKey and model → providers.gemini
  if (raw.geminiApiKey !== undefined || (raw.model && !raw.providers)) {
    if (!raw.providers) raw.providers = {};
    if (!raw.providers.gemini) raw.providers.gemini = {};
    if (raw.geminiApiKey !== undefined) {
      raw.providers.gemini.apiKey = raw.geminiApiKey || raw.providers.gemini.apiKey;
      delete raw.geminiApiKey;
    }
    if (raw.model && !raw.providers.gemini.model) {
      raw.providers.gemini.model = raw.model;
      delete raw.model;
    }
    // If the user was using Gemini, keep it as active
    if (!raw.activeProvider) raw.activeProvider = 'gemini';
    raw._migrated = true;
  }
  return raw;
}

// ─── Load / Save ───────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const migrated = migrateLegacy(raw);
      // Merge with defaults so new fields appear for existing users
      const merged = deepMerge(DEFAULT_CONFIG, migrated);
      // If we migrated, write the new shape back
      if (migrated._migrated) {
        delete merged._migrated;
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
      }
      return merged;
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(configPath, config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, deepMerge, getModeDefaults };
