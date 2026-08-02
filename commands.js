const { resolveProvider, fetchModels } = require('./providers');

// ─── Key masking ───────────────────────────────────────────────────────────────

function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

// ─── Command parser ────────────────────────────────────────────────────────────

function parseCommand(line) {
  if (!line.startsWith('/')) return null;
  const match = line.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: '/' + match[1].toLowerCase(), args: (match[2] || '').trim() };
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

// /key <provider> <key>
// /key custom <name> <endpoint> [key]
function handleKey(ctx, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return { error: 'Usage: /key <provider> <key>  or  /key custom <name> <endpoint> [key]' };
  }

  const target = parts[0].toLowerCase();

  if (target === 'custom') {
    // /key custom <name> <endpoint> [key]
    if (parts.length < 3) {
      return { error: 'Usage: /key custom <name> <endpoint> [key]' };
    }
    const name = parts[1];
    const endpoint = parts[2];
    const key = parts.slice(3).join(' ') || 'ollama';

    // Validate name
    if (!/^[a-z0-9_-]{1,32}$/i.test(name)) {
      return { error: 'Provider name: 1-32 chars, letters/numbers/dashes/underscores.' };
    }
    // Validate endpoint
    if (!/^https?:\/\/.+/.test(endpoint)) {
      return { error: 'Endpoint must start with http:// or https://' };
    }

    if (!ctx.config.customProviders) ctx.config.customProviders = {};
    ctx.config.customProviders[name] = {
      name: name,
      endpoint: endpoint,
      apiKey: key,
      model: ctx.config.customProviders[name]?.model || 'default'
    };
    ctx.saveConfig(ctx.config);
    return { message: `✓ Custom provider "${name}" saved → ${endpoint}` };
  }

  // Built-in provider
  if (!['deepseek', 'gemini', 'openai', 'anthropic'].includes(target)) {
    return { error: `Unknown provider "${target}". Use: deepseek, gemini, openai, anthropic, or /key custom <name> <endpoint> [key]` };
  }

  const key = parts.slice(1).join(' ');
  ctx.config.providers[target].apiKey = key;
  ctx.saveConfig(ctx.config);
  return { message: `✓ ${target} API key set (${maskKey(key)})` };
}

// /provider <name>
function handleProvider(ctx, args) {
  if (!args) return { error: 'Usage: /provider <name>' };

  const name = args.trim().toLowerCase();
  const hasBuiltin = ctx.config.providers[name];
  const hasCustom = ctx.config.customProviders[name];

  if (!hasBuiltin && !hasCustom) {
    const available = [
      ...Object.keys(ctx.config.providers).filter(k => ctx.config.providers[k].apiKey),
      ...Object.keys(ctx.config.customProviders || {})
    ];
    return { error: `Unknown provider "${name}". Configured: ${available.length ? available.join(', ') : 'none — set a key first with /key'}` };
  }

  ctx.config.activeProvider = name;
  ctx.saveConfig(ctx.config);

  const provider = resolveProvider(ctx.config, name);
  return { message: `✓ Active provider: ${provider?.name || name} · ${provider?.model || 'default'}` };
}

// /providers
function handleProviders(ctx, args) {
  const lines = [];
  const active = ctx.config.activeProvider;

  // Built-in
  for (const [id, p] of Object.entries(ctx.config.providers)) {
    const marker = id === active ? '●' : '○';
    const keyStatus = p.apiKey ? 'key ✓' : 'key ✗';
    lines.push(`${marker} ${id}  —  ${p.model}  (${keyStatus})`);
  }

  // Custom
  if (ctx.config.customProviders) {
    for (const [id, p] of Object.entries(ctx.config.customProviders)) {
      const marker = id === active ? '●' : '○';
      lines.push(`${marker} ${id} (custom)  —  ${p.model}  → ${p.endpoint}`);
    }
  }

  if (lines.length === 0) {
    return { message: 'No providers configured. Use /key <provider> <key> to add one.' };
  }

  return { message: '● = active\n\n' + lines.join('\n') };
}

// /model [provider] <model-id>
function handleModel(ctx, args) {
  if (!args) return { error: 'Usage: /model <model-id>  or  /model <provider> <model-id>' };

  const parts = args.split(/\s+/);
  let targetProvider, model;

  if (parts.length >= 2 && ctx.config.providers[parts[0].toLowerCase()]) {
    targetProvider = parts[0].toLowerCase();
    model = parts.slice(1).join(' ');
  } else {
    targetProvider = ctx.config.activeProvider;
    model = args;
  }

  const hasBuiltin = ctx.config.providers[targetProvider];
  const hasCustom = ctx.config.customProviders[targetProvider];

  if (!hasBuiltin && !hasCustom) {
    return { error: `Unknown provider "${targetProvider}".` };
  }

  if (hasBuiltin) {
    ctx.config.providers[targetProvider].model = model;
  } else {
    ctx.config.customProviders[targetProvider].model = model;
  }
  ctx.saveConfig(ctx.config);
  return { message: `✓ ${targetProvider} model set to: ${model}` };
}

// /models — list available models for active provider
async function handleModels(ctx, args) {
  const target = args.trim() || ctx.config.activeProvider;
  const result = await fetchModels(ctx.config, target);
  if (result.error) return { error: result.error };
  if (!result.models || result.models.length === 0) {
    return { message: 'No models found. Try setting a model manually with /model.' };
  }
  return { message: `Models for ${target}:\n${result.models.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}` };
}

// /mute — toggle silent observe
function handleMute(ctx, args) {
  ctx.config.muted = !ctx.config.muted;
  ctx.saveConfig(ctx.config);
  if (ctx.config.muted) {
    // If disabled, un-disable (mute implies active but suppressed)
    if (ctx.config.disabled) {
      ctx.config.disabled = false;
    }
    ctx.broadcastMute(ctx.config.muted);
    ctx.broadcastDisable(false);
    return { message: '🔇 Muted — listening & reading, responses hidden. /mute to unmute.' };
  }
  ctx.broadcastMute(ctx.config.muted);
  return { message: '✓ Unmuted — responses visible.' };
}

// /disable — toggle full disable (no input processing)
function handleDisable(ctx, args) {
  ctx.config.disabled = !ctx.config.disabled;
  ctx.saveConfig(ctx.config);
  if (ctx.config.disabled) {
    // Un-mute if muted
    if (ctx.config.muted) {
      ctx.config.muted = false;
      ctx.broadcastMute(false);
    }
    ctx.broadcastDisable(true);
    return { message: '⏸ Disabled — not processing any input. /disable to resume.' };
  }
  ctx.broadcastDisable(false);
  return { message: '✓ Enabled — processing inputs again.' };
}

// /opacity <0-1>
function handleOpacity(ctx, args) {
  const v = parseFloat(args);
  if (isNaN(v) || v < 0.01 || v > 1) {
    return { error: 'Usage: /opacity <0.01–1.0>. Examples: /opacity 0.15, /opacity 0.3' };
  }
  ctx.config.stealthOpacity = Math.round(v * 100) / 100;
  ctx.saveConfig(ctx.config);
  ctx.broadcastConfig(ctx.config);
  return { message: `✓ Stealth opacity set to ${ctx.config.stealthOpacity}` };
}

// /clear [all]
function handleClear(ctx, args) {
  if (args.trim().toLowerCase() === 'all') {
    Object.keys(ctx.historyByProvider).forEach(k => delete ctx.historyByProvider[k]);
    return { message: '✓ All conversation history cleared.' };
  }
  const active = ctx.config.activeProvider;
  if (ctx.historyByProvider[active]) {
    ctx.historyByProvider[active] = [];
    return { message: `✓ ${active} conversation history cleared.` };
  }
  return { message: 'No history to clear.' };
}

// /audio mic|system|off
function handleAudio(ctx, args) {
  const source = args.trim().toLowerCase();
  if (!['mic', 'system', 'off'].includes(source)) {
    return { error: 'Usage: /audio mic  |  /audio system  |  /audio off' };
  }
  ctx.config.audioSource = source;
  ctx.saveConfig(ctx.config);
  const labels = { mic: 'microphone', system: 'system audio', off: 'disabled' };
  return { message: `✓ Audio source: ${labels[source]}.` };
}

// /help
function handleHelp(ctx, args) {
  return {
    message: [
      '/key <p> <key>        set API key',
      '/key custom <n> <url> [key]  add custom provider',
      '/provider <name>      switch provider',
      '/providers            list configured',
      '/model [p] <model>    change model',
      '/models [p]           list available models',
      '/mute                 suppress responses',
      '/disable              pause all input',
      '/opacity <0.01-1>     stealth opacity',
      '/clear [all]          reset history',
      '/audio mic|system|off audio source',
      '/help                 this list'
    ].join('\n')
  };
}

// ─── Command table ─────────────────────────────────────────────────────────────

const HANDLERS = {
  '/key': handleKey,
  '/provider': handleProvider,
  '/providers': handleProviders,
  '/model': handleModel,
  '/models': handleModels,
  '/mute': handleMute,
  '/disable': handleDisable,
  '/opacity': handleOpacity,
  '/clear': handleClear,
  '/audio': handleAudio,
  '/help': handleHelp
};

// ─── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatchCommand(ctx, line) {
  const cmd = parseCommand(line);
  if (!cmd) return null;

  const handler = HANDLERS[cmd.name];
  if (!handler) {
    return { type: 'command', command: cmd.name, error: `Unknown command "${cmd.name}". Try /help` };
  }

  const result = await handler(ctx, cmd.args);
  return { type: 'command', command: cmd.name, ...result };
}

module.exports = { dispatchCommand, parseCommand };
