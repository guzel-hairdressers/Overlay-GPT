const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session, clipboard, nativeImage } = require('electron');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const { loadConfig, saveConfig } = require('./config');
const { callProvider, resolveProvider, supportsAudio, supportsVision, transcribeImage } = require('./providers');
const { dispatchCommand, parseCommand } = require('./commands');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let config = null;
let isVisible = true;
let isInteractive = false;
let historyByProvider = {};   // { providerId: [{role, content}, ...] }

// ─── Broadcast helpers ───────────────────────────────────────────────────────

function broadcastMute(muted) {
  if (mainWindow) mainWindow.webContents.send('mute-change', muted);
}

function broadcastDisable(disabled) {
  if (mainWindow) mainWindow.webContents.send('disable-change', disabled);
}

function broadcastConfig(cfg) {
  if (mainWindow) mainWindow.webContents.send('config-change', buildConfigForRenderer(cfg));
}

function buildConfigForRenderer(cfg) {
  const active = resolveProvider(cfg);
  const providers = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    providers[id] = { hasKey: !!p.apiKey, model: p.model };
  }
  const customProviders = Object.entries(cfg.customProviders || {}).map(([id, p]) => ({
    id, name: p.name, endpoint: p.endpoint, model: p.model, hasKey: !!p.apiKey
  }));
  return {
    providers,
    customProviders,
    activeProvider: cfg.activeProvider,
    activeProviderName: active?.name || cfg.activeProvider,
    activeProviderModel: active?.model || '',
    activeProviderKind: active?.kind || '',
    providerColor: active?.color || '#60a5fa',
    muted: cfg.muted,
    disabled: cfg.disabled,
    stealthOpacity: cfg.stealthOpacity,
    activeOpacity: cfg.activeOpacity,
    audioSource: cfg.audioSource,
    autoChunks: cfg.autoChunks !== false,
    maxRecordingSeconds: cfg.maxRecordingSeconds,
    theme: cfg.theme || 'dark'
  };
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const winWidth = 480;
  const winHeight = 520;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 320,
    minHeight: 200,
    x: screenWidth - winWidth - 24,
    y: screenHeight - winHeight - 24,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    focusable: true,
    title: 'Visual Studio Code',
    type: 'panel',
    visualEffectState: 'active',
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisible to screen capture
  mainWindow.setContentProtection(true);

  // Start in stealth mode: click-through
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Don't show in dock on macOS
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Auto-approve media permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'display-capture', 'audioCapture', 'videoCapture', 'speech'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'mediaKeySystem', 'display-capture', 'audioCapture', 'videoCapture', 'speech'];
    return allowed.includes(permission);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Screen Capture ──────────────────────────────────────────────────────────

function getResolutionDimensions(resString) {
  const normalized = (resString || '480p').toLowerCase().trim();
  const presets = {
    '360p':   { width: 640,  height: 360 },
    '480p':   { width: 854,  height: 480 },
    '720p':   { width: 1280, height: 720 },
    '1080p':  { width: 1920, height: 1080 },
    'native': { width: 3840, height: 2160 }
  };
  if (presets[normalized]) return presets[normalized];

  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 200 && num <= 4000) {
    return { width: num, height: Math.round((num * 9) / 16) };
  }
  return presets['480p'];
}

async function captureScreen() {
  try {
    const dims = getResolutionDimensions(config?.screenResolution);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: dims.width, height: dims.height }
    });

    if (sources.length > 0) {
      let image = sources[0].thumbnail;
      const size = image.getSize();

      if (dims.width < 3840 && size.width > dims.width) {
        image = image.resize({ width: dims.width, quality: 'good' });
      }

      const jpegBuffer = image.toJPEG(40);
      console.log(`[captureScreen] [${config?.screenResolution || '480p'}] ${size.width}x${size.height} → ${image.getSize().width}x${image.getSize().height}, ${Math.round(jpegBuffer.length / 1024)}KB`);
      return jpegBuffer.toString('base64');
    }

    return null;
  } catch (err) {
    console.error('Screen capture failed:', err);
    return null;
  }
}

// ─── Whisper transcription ──────────────────────────────────────────────────

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'bin', 'transcribe.py');

// Known Whisper hallucination patterns (YouTube subtitle credits, filler from silence)
const WHISPER_HALLUCINATIONS = [
  /субтитры\s*(создав|делал|сделал|подготовил)/i,
  /subtitles\s*(by|made|created|provided)/i,
  /sous-titres?\s*(par|créés|réalis)/i,
  /untertitel\s*(von|erstellt)/i,
  /подписывайтесь/i,
  /amara\.org/i,
  /thanks\s*for\s*watching/i,
  /please\s*subscribe/i,
  /♪/,
  /^\s*\.+\s*$/,
  /^[\s.…,!?]*$/,
];

function isWhisperHallucination(text) {
  if (!text || text.length < 3) return true;
  const trimmed = text.trim();
  return WHISPER_HALLUCINATIONS.some(re => re.test(trimmed));
}

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'f54a899579ed1e886d054877b141144562b64aa4';

async function transcribeDeepgram(audioBase64) {
  if (!DEEPGRAM_API_KEY) return null;
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&detect_language=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/wav'
      },
      body: audioBuffer
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[Deepgram] API error:', response.status, errText);
      return null;
    }

    const data = await response.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (transcript && !isWhisperHallucination(transcript)) {
      console.log('[Deepgram] Transcribed via Nova-2:', transcript);
      return transcript;
    }
    return null;
  } catch (err) {
    console.error('[Deepgram] Request failed:', err.message);
    return null;
  }
}

function transcribeWhisper(audioBase64, model) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `overlay-audio-${Date.now()}.wav`);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(tmpFile, audioBuffer);

    const targetModel = model || 'turbo';
    const args = [SCRIPT_PATH, tmpFile, '--model', targetModel];

    execFile('python3', args, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe']
    }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
      if (err) {
        console.error('Whisper failed:', err.message);
        return resolve(null);
      }
      const transcript = (stdout || '').trim();
      if (transcript && !transcript.startsWith('ERROR:') && !isWhisperHallucination(transcript)) {
        resolve(transcript);
      } else {
        if (transcript && isWhisperHallucination(transcript)) {
          console.log('[Whisper] Filtered hallucination:', transcript);
        }
        resolve(null);
      }
    });
  });
}

async function transcribeAudio(audioBase64, model) {
  // Transcribe via Deepgram Nova-2 Cloud API (~0.3s latency, high accuracy)
  console.log('[STT] Transcribing via Deepgram Nova-2...');
  let text = await transcribeDeepgram(audioBase64);
  if (text && text.trim()) return text.trim();

  return '';
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function setupIPC() {
  // Toggle interactive mode
  ipcMain.on('set-interactive', (event, interactive) => {
    isInteractive = interactive;
    if (mainWindow) {
      if (interactive) {
        mainWindow.setIgnoreMouseEvents(false);
        mainWindow.focus();
      } else {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
      }
    }
  });

  // Send question -> returns answer or stream updates
  ipcMain.handle('send-question', async (event, payload) => {
    // Reload latest config from disk so config edits take effect immediately
    config = loadConfig(CONFIG_PATH);
    let question, imageBase64, audioBase64, audioMimeType;

    if (typeof payload === 'string') {
      question = payload;
    } else if (payload) {
      question = payload.question || '';
      imageBase64 = payload.imageBase64 || null;
      audioBase64 = payload.audioBase64 || null;
      audioMimeType = payload.audioMimeType || null;
    } else {
      question = '';
    }

    // If disabled, reject everything except /disable command
    if (config.disabled && question) {
      const parsed = parseCommand(question);
      if (!parsed || parsed.name !== '/disable') {
        return { type: 'blocked', message: '⏸ Overlay is disabled. Type /disable or press Cmd+Shift+D to resume.' };
      }
    }

    // ── Command dispatch ──
    const ctx = {
      config,
      saveConfig: (c) => { config = c; saveConfig(CONFIG_PATH, c); },
      historyByProvider,
      broadcastMute,
      broadcastDisable,
      broadcastConfig
    };

    const cmdResult = await dispatchCommand(ctx, question);
    if (cmdResult) {
      if (cmdResult.copyToClipboard) {
        try { clipboard.writeText(cmdResult.copyToClipboard); } catch (e) {}
      }
      // After command, broadcast updated config to renderer
      broadcastConfig(config);
      return cmdResult;
    }

    // ── LLM call ──
    if (!question && !imageBase64 && !audioBase64) {
      return { type: 'error', error: 'No input provided.' };
    }

    // Audio transcription via mlx-whisper for providers without native audio
    let finalQuestion = question;
    let finalAudioBase64 = audioBase64;
    let finalAudioMimeType = audioMimeType;

    if (audioBase64) {
      const provider = resolveProvider(config);
      if (provider && !supportsAudio(provider)) {
        const transcript = await transcribeWhisper(audioBase64);
        if (transcript) {
          finalQuestion = question
            ? question + '\n\n[Transcript]: ' + transcript
            : transcript;
          finalAudioBase64 = null;
          finalAudioMimeType = null;
        } else {
          return { type: 'error', error: '⚠️ Speech transcription failed or no speech detected. Please try speaking again.' };
        }
      }
    }

    const activeId = config.activeProvider;
    const hist = historyByProvider[activeId] || (historyByProvider[activeId] = []);
    const result = await callProvider(config, hist, finalQuestion, {
      imageBase64,
      audioBase64: finalAudioBase64,
      audioMimeType: finalAudioMimeType
    });

    if (result.error) {
      return { type: 'error', error: result.error };
    }

    // Muted — suppress the response
    if (config.muted) {
      return {
        type: 'llm',
        suppressed: true,
        question: question || (imageBase64 ? '[screen]' : '[audio]'),
        provider: result.provider,
        model: result.model
      };
    }

    return {
      type: 'llm',
      answer: result.answer,
      question: question || (imageBase64 ? '[screen]' : '[audio]'),
      provider: result.provider,
      model: result.model
    };
  });

  // Capture screen
  ipcMain.handle('capture-screen', async () => {
    return await captureScreen();
  });

  // Get desktop sources (for system audio)
  ipcMain.handle('get-desktop-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });
      return { sources: sources.map(s => ({ id: s.id, name: s.name })) };
    } catch (err) {
      console.error('Failed to get desktop sources:', err.message);
      return { error: err.message, sources: [] };
    }
  });

  // ── Native ScreenCaptureKit System Audio Capture ──────────────────────────
  let sysAudioProcess = null;
  let sysAudioFile = null;

  ipcMain.handle('start-system-audio-capture', async () => {
    if (sysAudioProcess) {
      try { sysAudioProcess.kill('SIGINT'); } catch (e) {}
      sysAudioProcess = null;
    }

    sysAudioFile = path.join(os.tmpdir(), `sys_audio_${Date.now()}.wav`);
    const scriptPath = path.join(__dirname, '..', '..', 'bin', 'record_sysaudio.swift');

    try {
      console.log('[SysAudio] Spawning swift interpreter:', scriptPath, sysAudioFile);
      sysAudioProcess = spawn('swift', [scriptPath, sysAudioFile, '180']);
      console.log('[SysAudio] spawn() returned, pid:', sysAudioProcess.pid);

      // Stream real-time VOL: dB levels from ScreenCaptureKit to renderer
      if (sysAudioProcess.stdout) {
        console.log('[SysAudio] stdout stream available, attaching data listener');
        let buf = '';
        sysAudioProcess.stdout.on('data', (chunk) => {
          const raw = chunk.toString();
          console.log('[SysAudio] stdout chunk:', raw.trim().substring(0, 80));
          buf += raw;
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('VOL:')) {
              const db = parseInt(line.slice(4), 10);
              console.log('[SysAudio] Parsed VOL db:', db, 'mainWindow exists:', !!mainWindow);
              if (!isNaN(db) && mainWindow) {
                mainWindow.webContents.send('sys-audio-volume', db);
              }
            }
          }
        });
      } else {
        console.error('[SysAudio] WARNING: stdout stream is NULL');
      }

      if (sysAudioProcess.stderr) {
        sysAudioProcess.stderr.on('data', (chunk) => {
          console.error('[SysAudio] stderr:', chunk.toString().trim());
        });
      }

      sysAudioProcess.on('error', (err) => {
        console.error('[SysAudio] Process error:', err);
      });

      sysAudioProcess.on('exit', (code, signal) => {
        console.log('[SysAudio] Process exited, code:', code, 'signal:', signal);
      });

      console.log('[SysAudio] System audio capture process launched:', sysAudioFile);
      return { ok: true };
    } catch (err) {
      console.error('[SysAudio] Failed to launch system audio capture:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('stop-system-audio-capture', async () => {
    if (sysAudioProcess) {
      try { sysAudioProcess.kill('SIGINT'); } catch (e) {}
      sysAudioProcess = null;
      await new Promise(r => setTimeout(r, 500));
    }

    if (sysAudioFile && fs.existsSync(sysAudioFile)) {
      try {
        const audioBuffer = fs.readFileSync(sysAudioFile);
        fs.unlinkSync(sysAudioFile);
        sysAudioFile = null;

        const base64 = audioBuffer.toString('base64');
        const transcript = await transcribeAudio(base64, 'turbo');
        return { transcript: transcript || '' };
      } catch (err) {
        console.error('[ScreenCaptureKit] Read/transcribe error:', err);
        return { error: err.message };
      }
    }

    return { transcript: '' };
  });

  // Raw system audio WAV — stops capture, returns base64 without transcribing (for both-mode mixing)
  ipcMain.handle('stop-system-audio-capture-raw', async () => {
    if (sysAudioProcess) {
      try { sysAudioProcess.kill('SIGINT'); } catch (e) {}
      sysAudioProcess = null;
      await new Promise(r => setTimeout(r, 500));
    }

    if (sysAudioFile && fs.existsSync(sysAudioFile)) {
      try {
        const audioBuffer = fs.readFileSync(sysAudioFile);
        fs.unlinkSync(sysAudioFile);
        sysAudioFile = null;
        return { base64: audioBuffer.toString('base64') };
      } catch (err) {
        console.error('[ScreenCaptureKit] Raw read error:', err);
        return { error: err.message };
      }
    }
    return { base64: null };
  });

  // Real-time chunk transcription (async, non-blocking) — uses turbo model + Deepgram Nova-2 fallback
  ipcMain.handle('transcribe-chunk', async (event, audioBase64) => {
    return await transcribeAudio(audioBase64, 'turbo') || '';
  });

  // Gemini / Groq screenshot transcription
  ipcMain.handle('transcribe-image', async (event, imageBase64) => {
    return await transcribeImage(config, imageBase64);
  });

  // Log history IPC (for renderer errors & client logs)
  ipcMain.handle('log-history', (event, userMsg, assistantMsg) => {
    const activeId = config.activeProvider;
    const hist = historyByProvider[activeId] || (historyByProvider[activeId] = []);
    if (userMsg) hist.push({ role: 'user', content: userMsg });
    if (assistantMsg) hist.push({ role: 'assistant', content: assistantMsg });
    return { ok: true };
  });

  // Clipboard write bridge
  ipcMain.handle('write-clipboard', (event, text) => {
    try {
      if (typeof text === 'string') {
        clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.error('Clipboard write error:', err);
    }
    return false;
  });

  // Toggle fullscreen
  ipcMain.on('toggle-fullscreen', () => {
    if (!mainWindow) return;
    const isFS = mainWindow.isSimpleFullScreen() || mainWindow.isFullScreen();
    mainWindow.setSimpleFullScreen(!isFS);
  });

  // Get config for renderer
  ipcMain.handle('get-config', () => {
    return buildConfigForRenderer(config);
  });
}

// ─── Global Shortcuts ────────────────────────────────────────────────────────

function registerShortcuts() {
  // Toggle overlay visibility & activation
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow) return;
    isVisible = !isVisible;
    if (isVisible) {
      mainWindow.show();
      isInteractive = true;
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.focus();
      mainWindow.webContents.send('visibility-change', true);
      mainWindow.webContents.send('activate-input');
    } else {
      isInteractive = false;
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.webContents.send('deactivate');
      mainWindow.hide();
      mainWindow.webContents.send('visibility-change', false);
    }
  });

  // Cmd+Space — background only: flush audio chunk + capture additional screenshot
  try {
    globalShortcut.register('CommandOrControl+Space', () => {
      if (!mainWindow) return;
      mainWindow.webContents.send('flush-chunk');
      mainWindow.webContents.send('shortcut-space');
    });
  } catch (e) {}

  // Cmd+Shift+Space — toggle active input mode vs stealth mode
  try {
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      if (!mainWindow) return;
      if (isInteractive) {
        isInteractive = false;
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
        mainWindow.webContents.send('deactivate');
      } else {
        if (!isVisible) {
          isVisible = true;
          mainWindow.show();
          mainWindow.webContents.send('visibility-change', true);
        }
        isInteractive = true;
        mainWindow.setIgnoreMouseEvents(false);
        mainWindow.focus();
        mainWindow.webContents.send('activate-input');
      }
    });
  } catch (e) {}

  // Screen capture (Static Screenshot / Submit Screenshot Prompt)
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    if (!mainWindow) return;
    if (config.disabled) return;
    if (!isVisible) {
      isVisible = true;
      mainWindow.show();
      mainWindow.webContents.send('visibility-change', true);
    }
    isInteractive = true;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.focus();
    mainWindow.webContents.send('shortcut-screenshot');
  });

  // Continuous Video Screen Stream Mode
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (!mainWindow) return;
    if (config.disabled) return;
    if (!isVisible) {
      isVisible = true;
      mainWindow.show();
      mainWindow.webContents.send('visibility-change', true);
    }
    isInteractive = true;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.focus();
    mainWindow.webContents.send('toggle-video');
  });

  // Fullscreen toggle
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    if (!mainWindow) return;
    const isFS = mainWindow.isSimpleFullScreen() || mainWindow.isFullScreen();
    mainWindow.setSimpleFullScreen(!isFS);
  });

  // Toggle audio recording
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (!mainWindow) return;
    if (config.disabled) return;
    if (!isVisible) {
      isVisible = true;
      mainWindow.show();
      mainWindow.webContents.send('visibility-change', true);
    }
    isInteractive = true;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.focus();
    mainWindow.webContents.send('toggle-audio');
  });

  // Toggle mute (silent observe)
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (!mainWindow) return;
    config.muted = !config.muted;
    // If muting, un-disable
    if (config.muted && config.disabled) {
      config.disabled = false;
      broadcastDisable(false);
    }
    saveConfig(CONFIG_PATH, config);
    broadcastMute(config.muted);
    // Briefly show overlay to confirm state change
    if (!isVisible) {
      isVisible = true;
      mainWindow.show();
      mainWindow.webContents.send('visibility-change', true);
      setTimeout(() => {
        if (!isInteractive && isVisible) {
          // Stay visible briefly then return to previous state
        }
      }, 1500);
    }
    broadcastConfig(config);
  });

  // Toggle disable (pause all input processing)
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (!mainWindow) return;
    config.disabled = !config.disabled;
    // If disabling, un-mute
    if (config.disabled && config.muted) {
      config.muted = false;
      broadcastMute(false);
    }
    saveConfig(CONFIG_PATH, config);
    broadcastDisable(config.disabled);
    if (!isVisible) {
      isVisible = true;
      mainWindow.show();
      mainWindow.webContents.send('visibility-change', true);
      setTimeout(() => {
        // Brief peek
      }, 1500);
    }
    broadcastConfig(config);
  });

  // Toggle Theme (Light / Dark)
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (!mainWindow) return;
    config.theme = config.theme === 'light' ? 'dark' : 'light';
    saveConfig(CONFIG_PATH, config);
    broadcastConfig(config);
  });

  // Chunk Commit Shortcut (flush current audio chunk & continue recording)
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('flush-chunk');
  });

  // Quit
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit();
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  config = loadConfig(CONFIG_PATH);

  createWindow();
  setupIPC();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
