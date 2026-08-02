const path = require('path');
const fs = require('fs');

// ─── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  providers: {
    deepseek:  { apiKey: '', model: 'deepseek-chat' },
    gemini:    { apiKey: '', model: 'gemini-2.5-pro' },
    openai:    { apiKey: '', model: 'gpt-4o' },
    anthropic: { apiKey: '', model: 'claude-sonnet-5' }
  },
  customProviders: {},
  activeProvider: 'deepseek',
  muted: false,
  disabled: false,
  stealthOpacity: 0.15,
  activeOpacity: 0.85,
  audioSource: 'mic',            // 'mic' | 'system' | 'off'
  maxRecordingSeconds: 120
};

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

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, deepMerge };
