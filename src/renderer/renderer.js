// ─── DOM refs ─────────────────────────────────────────────────────────────────

const overlay = document.getElementById('overlay');
const answerContent = document.getElementById('answerContent');
const questionInput = document.getElementById('questionInput');
const inputSpinner = document.getElementById('inputSpinner');
const modelBadge = document.getElementById('modelBadge');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const screenBadge = document.getElementById('screenBadge');
const audioBadge = document.getElementById('audioBadge');
const muteBadge = document.getElementById('muteBadge');
const disableBadge = document.getElementById('disableBadge');

const vadMeterBadge = document.getElementById('vadMeterBadge');
const vadMeterFill = document.getElementById('vadMeterFill');
const vadNoiseFloorMarker = document.getElementById('vadNoiseFloorMarker');
const vadDbText = document.getElementById('vadDbText');
const vadStateTag = document.getElementById('vadStateTag');
const recTimer = document.getElementById('recTimer');
const scrollBottomBtn = document.getElementById('scrollBottomBtn');
const answerArea = document.getElementById('answerArea');

// ─── State ───────────────────────────────────────────────────────────────────

let isActive = false;
let isLoading = false;
let muted = false;
let disabled = false;
let providerId = 'deepseek';
let providerKind = '';
let audioSource = 'mic';
let maxRecordingSeconds = 120;
let autoChunks = true;             // auto-chunk audio on silence (all modes)

// Multimodal attachments
let pendingScreenshot = null;
let pendingAudio = null;

// Audio recording & noise level analyzer (VAD) state
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimerInterval = null;
let interimTimer = null;
let lastTranscript = '';
let silenceCount = 0;
let audioAnalyzer = null;
let vadThresholdDb = 2.5;  // dB above background noise floor
let vadSilenceMs = 1600;    // 1.6s continuous silence triggers auto-submit
let sysAudioDb = -90;       // Real-time system audio dB from ScreenCaptureKit
let sysAudioVolReceived = 0; // Debug counter

// Listen for real-time system audio volume from ScreenCaptureKit
window.api.onSysAudioVolume((db) => {
  sysAudioVolReceived++;
  if (sysAudioVolReceived <= 5 || sysAudioVolReceived % 50 === 0) {
    console.log('[SysAudio Renderer] Received VOL IPC #' + sysAudioVolReceived + ':', db, 'dB');
  }
  sysAudioDb = db;
});

// Audio Chunking & Sequential Queue state
let chunkQueue = [];
let chunkTranscripts = [];
let currentChunkIndex = 0;
let lastSampleOffset = 0;
let isProcessingChunkQueue = false;
let flushChunkHandler = null;  // Single handler reference for cleanup

// Image / Screenshot Chunking state (Gemini Vision Bridge)
let imageQueue = [];
let imageTranscripts = [];
let rawImageBases = [];
let currentImageIndex = 0;
let isProcessingImageQueue = false;



// ─── Init / Hydrate ──────────────────────────────────────────────────────────

async function hydrateUI() {
  try {
    const cfg = await window.api.getConfig();
    providerId = cfg.activeProvider;
    providerKind = cfg.activeProviderKind;
    overlay.dataset.provider = providerId;
    overlay.dataset.theme = cfg.theme || 'dark';
    modelBadge.textContent = cfg.activeProviderName + ' · ' + cfg.activeProviderModel;
    muted = cfg.muted;
    disabled = cfg.disabled;
    overlay.classList.toggle('muted', muted);
    overlay.classList.toggle('disabled', disabled);
    muteBadge.classList.toggle('visible', muted);
    disableBadge.classList.toggle('visible', disabled);
    document.documentElement.style.setProperty('--stealth-opacity', String(cfg.stealthOpacity));
    document.documentElement.style.setProperty('--stealth-hover-opacity',
      String(Math.min(cfg.stealthOpacity * 1.8, 0.4)));
    audioSource = cfg.audioSource;
    maxRecordingSeconds = cfg.maxRecordingSeconds;
    autoChunks = cfg.autoChunks !== false;

    // Show placeholder if no keys at all
    const hasAnyKey = Object.values(cfg.providers).some(p => p.hasKey) ||
                      cfg.customProviders.some(p => p.hasKey);
    if (!hasAnyKey && answerContent.querySelector('.placeholder-text')) {
      answerContent.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'placeholder-text';
      p.innerHTML = [
        '<strong>Welcome! No API keys configured.</strong>',
        '',
        'Get started:',
        '<code>/key groq &lt;key&gt;</code>       → <a href="#">https://console.groq.com/keys</a>  (free tier)',
        '<code>/key openai &lt;key&gt;</code>     → <a href="#">https://platform.openai.com/api-keys</a>',
        '<code>/key gemini &lt;key&gt;</code>     → <a href="#">https://aistudio.google.com</a>  (free tier)',
        '<code>/key deepseek &lt;key&gt;</code>   → <a href="#">https://platform.deepseek.com</a>',
        '<code>/key anthropic &lt;key&gt;</code>  → <a href="#">https://console.anthropic.com</a>',
        '',
        'Then:  <code>/provider &lt;name&gt;</code>   to switch',
        '       <code>/mode setup &lt;name&gt;</code> to save your setup',
      ].join('<br>');
      answerContent.appendChild(p);
    }
  } catch (e) {
    console.error('hydrateUI failed:', e);
  }
}

async function init() {
  await hydrateUI();
}

init();

// ─── Activate / Deactivate ──────────────────────────────────────────────────

function activate() {
  if (disabled) return; // blocked in disabled mode
  isActive = true;
  overlay.classList.remove('stealth');
  overlay.classList.add('active');
  statusText.textContent = 'active';
  questionInput.focus();
  window.api.setInteractive(true);
}

function deactivate() {
  isActive = false;
  overlay.classList.remove('active');
  overlay.classList.add('stealth');
  statusText.textContent = disabled ? 'disabled' : muted ? 'muted' : 'stealth';
  questionInput.blur();
  questionInput.value = '';
  clearPendingAttachments();
  window.api.setInteractive(false);
}

function clearPendingAttachments() {
  pendingScreenshot = null;
  pendingAudio = null;
  resetImageChunkState();
  questionInput.placeholder = disabled ? 'disabled — /disable to resume' : 'ask anything...';
}

// ─── Image Chunking Queue (Gemini Vision Bridge) ────────────────────────────

async function enqueueImageChunk(imageBase64) {
  if (!imageBase64) return;
  const index = currentImageIndex++;
  imageQueue.push({ index, base64: imageBase64 });
  rawImageBases[index] = imageBase64;

  if (screenBadge) {
    screenBadge.classList.add('visible');
    const badgeSpan = screenBadge.querySelector('span');
    if (badgeSpan) badgeSpan.textContent = `${currentImageIndex} image${currentImageIndex > 1 ? 's' : ''}`;
  }

  processImageQueue();
}

async function processImageQueue() {
  if (isProcessingImageQueue) return;
  isProcessingImageQueue = true;

  while (imageQueue.length > 0) {
    const item = imageQueue.shift();
    try {
      if (statusText) {
        statusText.textContent = `${currentImageIndex} screenshot${currentImageIndex > 1 ? 's' : ''} transcribing...`;
      }
      const res = await window.api.transcribeImage(item.base64);
      if (res && res.transcript) {
        imageTranscripts[item.index] = res.transcript.trim();
        if (statusText) {
          statusText.textContent = `${currentImageIndex} screenshot${currentImageIndex > 1 ? 's' : ''} ready`;
        }
      }
    } catch (err) {
      console.warn(`Image ${item.index} error:`, err);
    }
  }

  isProcessingImageQueue = false;
}

function hasStagedImageChunks() {
  return currentImageIndex > 0 || imageQueue.length > 0 || isProcessingImageQueue;
}

function resetImageChunkState() {
  imageQueue = [];
  imageTranscripts = [];
  rawImageBases = [];
  currentImageIndex = 0;
  isProcessingImageQueue = false;
  if (screenBadge) {
    screenBadge.classList.remove('visible');
    const badgeSpan = screenBadge.querySelector('span');
    if (badgeSpan) badgeSpan.textContent = 'screen';
  }
}

// ─── IPC Listeners ──────────────────────────────────────────────────────────

window.api.onActivateInput(() => {
  activate();
});

window.api.onShortcutScreenshot(async () => {
  if (disabled || isLoading) return;
  activate();

  if (hasStagedImageChunks()) {
    // Second press (or subsequent) → submit with all staged screenshots
    await submitQuestion();
  } else {
    // First press → capture screenshot and start background transcription
    if (statusText) statusText.textContent = 'capturing screenshot...';
    const base64 = await window.api.captureScreen();
    if (base64) {
      await enqueueImageChunk(base64);
      questionInput.placeholder = 'type question... Cmd+Space for more, Cmd+Shift+S or Enter to submit';
      questionInput.focus();
    }
  }
});

window.api.onShortcutSpace(async () => {
  if (disabled || isLoading) return;

  if (hasStagedImageChunks()) {
    // Capture additional screenshot — background only, no stealth exit
    const base64 = await window.api.captureScreen();
    if (base64) {
      await enqueueImageChunk(base64);
    }
  }
});

window.api.onDeactivate(() => {
  if (isRecording) stopRecording(true);
  deactivate();
});

window.api.onVisibilityChange((visible) => {
  if (!visible) {
    if (isRecording) stopRecording(true);
    deactivate();
  }
});

window.api.onScreenCaptured(async (imageBase64) => {
  if (disabled) return;
  activate();
  await enqueueImageChunk(imageBase64);
  questionInput.placeholder = 'ask about screen(s)... (press Cmd+Shift+S or Enter to submit)';
  questionInput.focus();
});

window.api.onToggleAudio(() => {
  if (disabled) return;
  if (isRecording) {
    stopRecording(false);
  } else {
    startRecording();
  }
});



window.api.onMuteChange((m) => {
  muted = m;
  overlay.classList.toggle('muted', m);
  muteBadge.classList.toggle('visible', m);
  if (!isActive) {
    statusText.textContent = m ? 'muted' : disabled ? 'disabled' : 'stealth';
  }
});

window.api.onDisableChange((d) => {
  disabled = d;
  overlay.classList.toggle('disabled', d);
  disableBadge.classList.toggle('visible', d);
  statusText.textContent = d ? 'disabled' : muted ? 'muted' : isActive ? 'active' : 'stealth';
  questionInput.placeholder = d ? 'disabled — /disable to resume' : 'ask anything...';
  if (d && isActive) {
    deactivate();
  }
});

window.api.onConfigChange((cfg) => {
  providerId = cfg.activeProvider;
  overlay.dataset.provider = providerId;
  overlay.dataset.theme = cfg.theme || 'dark';
  modelBadge.textContent = cfg.activeProviderName + ' · ' + cfg.activeProviderModel;
  document.documentElement.style.setProperty('--stealth-opacity', String(cfg.stealthOpacity));
  document.documentElement.style.setProperty('--stealth-hover-opacity',
    String(Math.min(cfg.stealthOpacity * 1.8, 0.4)));
});

// ─── Keyboard Handling ──────────────────────────────────────────────────────

// ─── Slash Command Autocomplete ──────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/provider', args: '<name>', desc: 'switch provider (deepseek, groq, openrouter, gemma...)' },
  { cmd: '/providers', args: '', desc: 'list configured providers & keys' },
  { cmd: '/model', args: '[provider] <model>', desc: 'change model for provider' },
  { cmd: '/models', args: '[provider]', desc: 'list available models' },
  { cmd: '/key', args: '<provider> <key>', desc: 'set API key or custom endpoint' },
  { cmd: '/export', args: '[path]', desc: 'export chat transcript to Desktop file' },
  { cmd: '/copy', args: '', desc: 'copy chat transcript to clipboard' },
  { cmd: '/audio', args: 'mic|system|both|off', desc: 'select audio recording source' },
  { cmd: '/setting', args: '[key] [value]', desc: 'view/change settings: resolution, audio, opacity, theme, auto-chunks' },
  { cmd: '/clear', args: '[all]', desc: 'clear conversation history' },
  { cmd: '/mute', args: '', desc: 'suppress response output' },
  { cmd: '/disable', args: '', desc: 'pause all input processing' },
  { cmd: '/prompt', args: 'system|audio|image', desc: 'view or edit system, audio, or image prompts' },
  { cmd: '/mode', args: 'setup|save|delete|<name>', desc: 'manage named presets of prompts & settings' },
  { cmd: '/help', args: '', desc: 'show command reference manual' }
];

const SETTING_KEYS = [
  { key: 'resolution', vals: '360p|480p|720p|1080p|native', desc: 'screenshot capture resolution' },
  { key: 'audio', vals: 'mic|system|both|off', desc: 'audio recording source' },
  { key: 'opacity', vals: '0.01–1.0', desc: 'stealth mode opacity' },
  { key: 'theme', vals: 'light|dark', desc: 'color theme' },
  { key: 'auto-chunks', vals: 'true|false', desc: 'auto-chunk audio on silence (all modes)' },
  { key: 'max-recording', vals: '<seconds>', desc: 'max recording duration before auto-stop (default 120)' },
];

const autocompletePopup = document.getElementById('autocompletePopup');
const autocompleteList = document.getElementById('autocompleteList');
let autocompleteMatches = [];
let autocompleteIndex = 0;
let autocompleteMode = 'command'; // 'command' | 'setting-key' | 'setting-value'
let autocompleteSettingKey = null;

function updateAutocomplete() {
  const val = questionInput.value;
  if (!val.startsWith('/')) {
    hideAutocomplete();
    return;
  }

  const spaceIdx = val.indexOf(' ');
  const hasSpace = spaceIdx !== -1;
  const cmdName = (hasSpace ? val.slice(0, spaceIdx) : val).toLowerCase();
  const afterCmd = hasSpace ? val.slice(spaceIdx + 1) : '';

  // ── Stage 1: completing command name (no space) ──
  if (!hasSpace) {
    autocompleteMode = 'command';
    const query = val.toLowerCase();
    autocompleteMatches = SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query));
    if (autocompleteMatches.length === 0) { hideAutocomplete(); return; }
    if (autocompleteIndex >= autocompleteMatches.length) autocompleteIndex = 0;
    renderAutocomplete();
    showAutocomplete();
    return;
  }

  // ── Stage 2 & 3: nested /setting autocomplete ──
  if (cmdName === '/setting') {
    const argParts = afterCmd.split(/\s+/);
    const typedKey = argParts[0] || '';
    const typedVal = argParts.slice(1).join(' ');
    const endsWithSpace = afterCmd.endsWith(' ');

    // Stage 2: completing setting key name (e.g., "/setting au")
    if (!endsWithSpace && argParts.length === 1) {
      autocompleteMode = 'setting-key';
      autocompleteSettingKey = null;
      const query = typedKey.toLowerCase();
      autocompleteMatches = SETTING_KEYS
        .filter(s => s.key.startsWith(query))
        .map(s => ({ cmd: s.key, args: s.vals, desc: s.desc }));
    }
    // Stage 3: completing setting value (e.g., "/setting auto-chunks ")
    else if (endsWithSpace || argParts.length >= 2) {
      const key = typedKey.toLowerCase();
      const setting = SETTING_KEYS.find(s => s.key === key);
      if (setting && setting.vals && !setting.vals.startsWith('0.01')) {
        autocompleteMode = 'setting-value';
        autocompleteSettingKey = key;
        const query = typedVal.toLowerCase();
        const values = setting.vals.split('|');
        autocompleteMatches = values
          .filter(v => v.startsWith(query))
          .map(v => ({ cmd: v, args: '', desc: '' }));
      } else {
        hideAutocomplete();
        return;
      }
    } else {
      hideAutocomplete();
      return;
    }

    if (autocompleteMatches.length === 0) { hideAutocomplete(); return; }
    if (autocompleteIndex >= autocompleteMatches.length) autocompleteIndex = 0;
    renderAutocomplete();
    showAutocomplete();
    return;
  }

  // ── Stage 2: /prompt sub-options ──
  if (cmdName === '/prompt') {
    const query = afterCmd.trim().toLowerCase();
    const PROMPT_TYPES = [
      { cmd: 'system', args: '', desc: 'main system prompt for the AI assistant' },
      { cmd: 'audio', args: '', desc: 'prompt used for audio transcription' },
      { cmd: 'image', args: '', desc: 'prompt used for image/OCR transcription' }
    ];
    autocompleteMode = 'prompt-type';
    autocompleteMatches = PROMPT_TYPES.filter(p => p.cmd.startsWith(query));
    if (autocompleteMatches.length === 0) { hideAutocomplete(); return; }
    if (autocompleteIndex >= autocompleteMatches.length) autocompleteIndex = 0;
    renderAutocomplete();
    showAutocomplete();
    return;
  }

  // ── Stage 2: /mode sub-options ──
  if (cmdName === '/mode') {
    const query = afterCmd.trim().toLowerCase();
    const MODE_SUBS = [
      { cmd: 'setup', args: '<name>', desc: 'create new mode with default settings' },
      { cmd: 'save', args: '', desc: 'save current settings to active mode' },
      { cmd: 'delete', args: '<name>', desc: 'delete a saved mode' },
      { cmd: 'list', args: '', desc: 'list all saved modes' }
    ];
    autocompleteMode = 'mode-sub';
    autocompleteMatches = MODE_SUBS.filter(s => s.cmd.startsWith(query));
    if (autocompleteMatches.length === 0) { hideAutocomplete(); return; }
    if (autocompleteIndex >= autocompleteMatches.length) autocompleteIndex = 0;
    renderAutocomplete();
    showAutocomplete();
    return;
  }

  // Commands other than /setting, /prompt, /mode with args — hide popup
  hideAutocomplete();
}

function renderAutocomplete() {
  if (!autocompleteList) return;
  autocompleteList.innerHTML = '';
  autocompleteMatches.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = `autocomplete-item${index === autocompleteIndex ? ' selected' : ''}`;
    const prefix = autocompleteMode === 'command' ? '' : '  ';
    el.innerHTML = `
      <div class="cmd-left">
        <span class="cmd-name">${prefix}${item.cmd}</span>
        ${item.args ? `<span class="cmd-args">${item.args}</span>` : ''}
      </div>
      <span class="cmd-desc">${item.desc}</span>
    `;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyAutocomplete(item);
    });
    autocompleteList.appendChild(el);
  });
  ensureAutocompleteVisible();
}

function ensureAutocompleteVisible() {
  if (!autocompleteList) return;
  const selectedEl = autocompleteList.children[autocompleteIndex];
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function applyAutocomplete(item) {
  const selected = item || autocompleteMatches[autocompleteIndex];
  if (!selected) return;

  if (autocompleteMode === 'command') {
    // Complete command name: "/sett" + Tab → "/setting "
    questionInput.value = selected.cmd + ' ';
  } else if (autocompleteMode === 'prompt-type') {
    // Complete prompt type: "/prompt s" + Tab → "/prompt system "
    questionInput.value = '/prompt ' + selected.cmd + ' ';
  } else if (autocompleteMode === 'mode-sub') {
    // Complete mode sub-command: "/mode set" + Tab → "/mode setup "
    questionInput.value = '/mode ' + selected.cmd + (selected.args ? ' ' : '');
  } else if (autocompleteMode === 'setting-key') {
    // Complete setting key: "/setting au" + Tab → "/setting auto-chunks "
    questionInput.value = '/setting ' + selected.cmd + ' ';
    autocompleteMode = 'setting-value';
    autocompleteSettingKey = selected.cmd;
  } else if (autocompleteMode === 'setting-value') {
    // Complete setting value: "/setting auto-chunks tr" + Tab → "/setting auto-chunks true"
    const prefix = '/setting ' + autocompleteSettingKey;
    questionInput.value = prefix + ' ' + selected.cmd;
  }

  hideAutocomplete();
  questionInput.focus();

  // Trigger fresh autocomplete for the next stage
  setTimeout(() => updateAutocomplete(), 0);
}

function showAutocomplete() {
  if (autocompletePopup) autocompletePopup.classList.add('visible');
}

function hideAutocomplete() {
  if (autocompletePopup) autocompletePopup.classList.remove('visible');
  autocompleteMatches = [];
  autocompleteIndex = 0;
  autocompleteMode = 'command';
  autocompleteSettingKey = null;
}

// ─── Keyboard Handling ──────────────────────────────────────────────────────

questionInput.addEventListener('input', () => {
  updateAutocomplete();
});

questionInput.addEventListener('keydown', async (e) => {
  const isPopupOpen = autocompletePopup && autocompletePopup.classList.contains('visible');

  if (isPopupOpen) {
    if (e.key === 'Tab') {
      e.preventDefault();
      applyAutocomplete();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteIndex = (autocompleteIndex + 1) % autocompleteMatches.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteIndex = (autocompleteIndex - 1 + autocompleteMatches.length) % autocompleteMatches.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideAutocomplete();
      return;
    }
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (isRecording) stopRecording(true);
    deactivate();
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (disabled) return;

    if (isRecording) {
      stopRecording(false);
      return;
    }

    const question = questionInput.value.trim();
    if ((!question && !pendingScreenshot && !pendingAudio && !hasStagedImageChunks()) || isLoading) return;

    hideAutocomplete();
    await submitQuestion(question);
  }
});

// Capture phase key listener: Enter during audio recording ALWAYS triggers prompt submission
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && isRecording) {
    e.preventDefault();
    e.stopPropagation();
    stopRecording(false);
    return;
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isActive) {
    e.preventDefault();
    if (isRecording) stopRecording(true);
    deactivate();
  }
});

// ─── Audio Recording ────────────────────────────────────────────────────────

async function getAudioStream(sourceType) {
  const getMicStream = () => navigator.mediaDevices.getUserMedia({ audio: true });

  const getSystemStream = async () => {
    try {
      const res = await window.api.getDesktopSources();
      const sources = (res && res.sources) || (Array.isArray(res) ? res : []);
      if (res && res.error) {
        throw new Error('macOS blocked screen capture: ' + res.error);
      }
      console.log('[getAudioStream] Desktop sources:', sources.map(s => s.name));
      const source = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      if (!source) {
        throw new Error('Screen Recording permission is disabled for Overlay GPT / Electron in macOS System Settings.');
      }

      console.log('[getSystemStream] Acquiring system audio for source:', source.id, source.name);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        }
      });

      // Keep ScreenCaptureKit video sink active in background via video-only MediaStream so macOS loopback stays connected without muting audio
      const dummyVideo = document.createElement('video');
      dummyVideo.style.display = 'none';
      dummyVideo.muted = true;
      dummyVideo.srcObject = new MediaStream(stream.getVideoTracks());
      document.body.appendChild(dummyVideo);
      dummyVideo.play().catch(() => {});

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks captured. Ensure System Audio & Screen Recording permission is allowed.');
      }
      console.log('[getAudioStream] System audio stream acquired cleanly with active video sink, audio tracks:', audioTracks.length);

      const audioOnlyStream = new MediaStream(audioTracks);
      audioOnlyStream._sourceTracks = stream.getTracks();
      audioOnlyStream._dummyVideo = dummyVideo;
      return audioOnlyStream;
    } catch (e) {
      console.error('[getAudioStream] System audio capture FAILED:', e.message);
      throw new Error('System audio capture failed: ' + e.message + '. Ensure Screen Recording permission is allowed in System Settings > Privacy & Security.');
    }
  };

  if (sourceType === 'system') {
    return await getSystemStream();
  }

  if (sourceType === 'both' || sourceType === 'mic+system') {
    // System audio is captured via native ScreenCaptureKit (Swift), not Chromium
    // which returns silent audio on macOS. Only return mic stream here.
    console.log('[getAudioStream] both mode: returning mic-only stream (system audio via ScreenCaptureKit)');
    return await getMicStream();
  }

  return await getMicStream();
}

async function startRecording() {
  if (audioSource === 'off') {
    showError('Audio is disabled. Use /audio mic, /audio system, or /audio both to enable.');
    return;
  }

  // ── System-only mode: delegate to native ScreenCaptureKit path ──
  if (audioSource === 'system') {
    return startSystemAudioRecording();
  }

  try {

    // Start native ScreenCaptureKit system audio capture for dual mode
    if (audioSource === 'both' || audioSource === 'mic+system') {
      try {
        const result = await window.api.startSystemAudioCapture();
        if (result && result.error) console.warn('[SysAudio] Start warning:', result.error);
        else console.log('[startRecording] Native ScreenCaptureKit system audio started for both mode');
      } catch (e) { console.warn('[SysAudio] Failed to start system audio:', e); }
    }

    const stream = await getAudioStream(audioSource);

    audioChunks = [];
    chunkQueue = [];
    chunkTranscripts = [];
    currentChunkIndex = 0;
    lastSampleOffset = 0;
    isProcessingChunkQueue = false;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    const enqueueCurrentChunk = async () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.requestData(); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
      }
      if (audioChunks.length === 0) return;

      // Keep all WebM chunks from start of recording so EBML header is ALWAYS present
      const fullBlob = new Blob([...audioChunks], { type: 'audio/webm' });
      const index = currentChunkIndex++;
      chunkQueue.push({ index, blob: fullBlob });

      processChunkQueue();
    };

    const processChunkQueue = async () => {
      if (isProcessingChunkQueue) return;
      isProcessingChunkQueue = true;

      while (chunkQueue.length > 0) {
        const item = chunkQueue.shift();
        try {
          if (statusText && isRecording) {
            statusText.textContent = `transcribing chunk #${item.index + 1}...`;
          }

          const { mono, sampleRate } = await decodeWebmToMonoPcm(item.blob);
          const startSample = Math.min(lastSampleOffset, mono.length);
          const endSample = mono.length;
          lastSampleOffset = endSample;

          const chunkSamples = mono.subarray(startSample, endSample);
          // Only transcribe if we have at least 0.2s of audio (3200 samples at 16kHz)
          if (chunkSamples.length >= 3200) {
            const wavBlob = pcmToWavBlob(chunkSamples, sampleRate);
            const arrayBuffer = await wavBlob.arrayBuffer();
            const base64 = btoa(
              new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
            const text = await window.api.transcribeChunk(base64);
            if (text && text.trim()) {
              chunkTranscripts[item.index] = text.trim();
              if (statusText && isRecording) {
                statusText.textContent = `chunk #${item.index + 1} ready ("${text.trim().slice(0, 30)}...")`;
              }
            }
          }
        } catch (err) {
          console.warn(`Chunk ${item.index} transcription error:`, err);
        }
      }

      isProcessingChunkQueue = false;
    };

    // Register flush handler ONCE, clean up old one first
    if (flushChunkHandler) {
      window.api.onFlushChunk(null);
    }
    flushChunkHandler = async () => {
      if (!isRecording) return;
      statusText.textContent = 'committing chunk...';
      await enqueueCurrentChunk();
    };
    window.api.onFlushChunk(flushChunkHandler);

    mediaRecorder.onstop = async () => {
      if (stream._dummyVideo) {
        try {
          stream._dummyVideo.pause();
          stream._dummyVideo.srcObject = null;
          stream._dummyVideo.remove();
        } catch (e) {}
      }
      if (stream._sourceTracks) {
        stream._sourceTracks.forEach(t => t.stop());
      }
      stream.getTracks().forEach(t => t.stop());
      if (stream._audioCtx) {
        try { stream._audioCtx.close(); } catch (e) {}
      }

      let finalQuestion = questionInput.value.trim();
      const isDualMode = audioSource === 'both' || audioSource === 'mic+system';

      if (isDualMode) {
        // ── Both mode: mix mic + system audio waveforms, transcribe together ──
        statusText.textContent = 'mixing audio...';
        try {
          // Flush any remaining buffered data before building the blob
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            try { mediaRecorder.requestData(); } catch (e) {}
            await new Promise(r => setTimeout(r, 50));
          }

          // 1. Convert all mic WebM chunks → PCM Float32 (16kHz mono)
          console.log('[both] audioChunks count:', audioChunks.length,
                      'sizes:', audioChunks.map(c => c.size).join(', '));
          const micBlob = new Blob(audioChunks, { type: 'audio/webm' });
          console.log('[both] micBlob size:', micBlob.size, 'bytes');
          const { mono: micPcm } = await decodeWebmToMonoPcm(micBlob);
          console.log('[both] micPCM decoded:', micPcm.length, 'samples (', (micPcm.length/16000).toFixed(1), 's)');

          // 2. Get system audio WAV raw from Swift (no transcription)
          const sysResult = await window.api.stopSystemAudioCaptureRaw();
          const sysBase64 = (sysResult && sysResult.base64) || null;

          // 3. Mix: align lengths, sum with simple averaging (transparent, no artifacts)
          let mixed = micPcm;
          if (sysBase64) {
            const sysPcm = wavBase64ToPcm(sysBase64);
            const maxLen = Math.max(micPcm.length, sysPcm.length);
            mixed = new Float32Array(maxLen);
            for (let i = 0; i < maxLen; i++) {
              const micSample = i < micPcm.length ? micPcm[i] : 0;
              const sysSample = i < sysPcm.length ? sysPcm[i] : 0;
              mixed[i] = (micSample + sysSample) / 2;
            }
            console.log('[both] Mixed mic', micPcm.length, 'samples + sys', sysPcm.length, 'samples →', maxLen);
          }

          // 4. Encode mixed PCM → WAV → base64
          const mixedWav = pcmToWavBlob(mixed, 16000);
          const arrayBuffer = await mixedWav.arrayBuffer();
          const mixedBase64 = btoa(
            new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
          );

          // 5. Transcribe the mixed audio
          statusText.textContent = 'transcribing mixed audio...';
          const transcript = await window.api.transcribeChunk(mixedBase64);

          if (transcript) {
            finalQuestion = finalQuestion
              ? finalQuestion + '\n\n[Audio]: ' + transcript
              : transcript;
            console.log('[both] Mixed transcript:', transcript.slice(0, 100));
          }
        } catch (e) {
          console.error('[both] Audio mixing failed:', e);
        }
      } else if (!finalQuestion) {
        // ── Mic-only: existing chunk transcription pipeline ──
        await enqueueCurrentChunk();

        if (isProcessingChunkQueue || chunkQueue.length > 0) {
          statusText.textContent = 'finishing transcription of all chunks...';
          while (isProcessingChunkQueue || chunkQueue.length > 0) {
            await new Promise(r => setTimeout(r, 100));
          }
        }

        finalQuestion = chunkTranscripts.filter(Boolean).join(' ');
      }

      // Reset chunk state for next session
      chunkQueue = [];
      chunkTranscripts = [];
      currentChunkIndex = 0;
      lastSampleOffset = 0;
      audioChunks = [];

      if (!finalQuestion) {
        showError('No speech detected in audio recording.');
        if (statusText) statusText.textContent = 'no speech detected';
        return;
      }

      await submitQuestion(finalQuestion);
    };

    mediaRecorder.start(1000);
    isRecording = true;
    lastTranscript = '';
    silenceCount = 0;

    // Real-time Audio Noise Level Analyzer & VAD (silence auto-submit)
    if (typeof AudioNoiseAnalyzer !== 'undefined') {
      audioAnalyzer = new AudioNoiseAnalyzer(stream, {
        onsetThresholdDb: 8.0,
        offsetThresholdDb: 3.5,
        silenceMs: 1000,
        onSpeechStart: () => {
          if (isRecording) {
            statusText.textContent = 'speaking...';
          }
        },
        onSilence: () => {
          if (isRecording && autoChunks) {
            statusText.textContent = 'chunking audio...';
            enqueueCurrentChunk();
          }
        },
        onVolumeChange: (data) => {
          if (vadMeterBadge && isRecording) {
            vadMeterBadge.classList.add('visible');

            if (audioSource === 'both' || audioSource === 'mic+system') {
              vadDbText.textContent = `MIC ${data.currentDb}dB / SYS ${sysAudioDb}dB`;
            } else {
              vadDbText.textContent = `${data.currentDb}dB (flr:${data.noiseFloorDb})`;
            }

            const normVol = Math.max(0, Math.min(100, ((data.currentDb + 90) / 90) * 100));
            const normFloor = Math.max(0, Math.min(100, (((data.noiseFloorDb + data.onsetThresholdDb) + 90) / 90) * 100));

            vadMeterFill.style.width = normVol + '%';
            vadNoiseFloorMarker.style.left = normFloor + '%';

            if (data.isCalibrating) {
              vadMeterBadge.classList.remove('speaking', 'silence');
              vadStateTag.textContent = `CALIB ${data.calibrationRemainingSec}s`;
              statusText.textContent = `calibrating noise... ${data.calibrationRemainingSec}s`;
            } else if (data.isSpeech) {
              vadMeterBadge.classList.add('speaking');
              vadMeterBadge.classList.remove('silence');
              vadStateTag.textContent = 'SPEECH';
            } else if (data.hasSpoken && data.silenceElapsedMs > 0) {
              vadMeterBadge.classList.remove('speaking');
              vadMeterBadge.classList.add('silence');
              const remSec = Math.max(0, (data.silenceMs - data.silenceElapsedMs) / 1000).toFixed(1);
              vadStateTag.textContent = `WAIT ${remSec}s`;
            } else {
              vadMeterBadge.classList.remove('speaking', 'silence');
              vadStateTag.textContent = 'QUIET';
            }
          }
        }
      });
    }


    activate();
    audioBadge.classList.add('visible');
    vadMeterBadge.classList.add('visible');
    statusDot.classList.add('recording');
    statusText.textContent = 'listening...';
    questionInput.placeholder = 'listening... stop talking to submit, or press enter';

    recordingStartTime = Date.now();
    recTimer.textContent = '0:00';
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      recTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      if (elapsed >= maxRecordingSeconds) {
        stopRecording(false);
      }
    }, 1000);

  } catch (err) {
    console.error('Failed to start recording:', err);
    showError(`Recording failed: ${err.message}. Check microphone permissions in System Settings.`);
  }
}

async function stopRecording(discard) {
  if (!isRecording) return;

  const wasSystemMode = audioSource === 'system';
  const wasBothMode = audioSource === 'both' || audioSource === 'mic+system';

  isRecording = false;
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;

  if (vadMeterBadge) {
    vadMeterBadge.classList.remove('visible', 'speaking', 'silence');
  }

  if (audioAnalyzer) {
    audioAnalyzer.stop();
    audioAnalyzer = null;
  }

  // Immediately stop mediaRecorder stream tracks so mic hardware turns off instantly
  if (mediaRecorder && mediaRecorder.stream) {
    try { mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }

  // Clean up system-only VAD interval
  if (window._sysVadInterval) {
    clearInterval(window._sysVadInterval);
    window._sysVadInterval = null;
  }

  if (discard) {
    // Stop system audio capture (discard) for system/both modes
    if (wasSystemMode || wasBothMode) {
      try { await window.api.stopSystemAudioCapture(); } catch (e) {}
    }

    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = () => {
        mediaRecorder.stream?.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.stop();
    }
    audioBadge.classList.remove('visible');
    statusDot.classList.remove('recording');
    statusText.textContent = isActive ? 'active' : disabled ? 'disabled' : muted ? 'muted' : 'stealth';
    questionInput.placeholder = 'ask anything...';
    audioChunks = [];
    chunkQueue = [];
    chunkTranscripts = [];
    currentChunkIndex = 0;
    isProcessingChunkQueue = false;
    return;
  }

  // ── System-only mode: stop Swift capture, get transcript, submit ──
  if (wasSystemMode) {
    audioBadge.classList.remove('visible');
    statusDot.classList.remove('recording');
    statusText.textContent = 'transcribing system audio...';

    try {
      const result = await window.api.stopSystemAudioCapture();
      const transcript = (result && result.transcript) || '';

      if (!transcript) {
        showError('No speech detected in system audio.');
        if (statusText) statusText.textContent = 'no speech detected';
        return;
      }

      await submitQuestion(transcript);
    } catch (err) {
      console.error('[SysAudio] Stop/transcribe error:', err);
      showError('System audio transcription failed: ' + err.message);
    }
    return;
  }

  // ── Mic / Both modes: stop MediaRecorder ──
  // (mediaRecorder.onstop handles both-mode system audio mixing & transcription)
  audioBadge.classList.remove('visible');
  statusDot.classList.remove('recording');
  statusText.textContent = 'transcribing...';
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Flush any buffered audio before stopping so all chunks are in audioChunks
    try { mediaRecorder.requestData(); } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
    try { mediaRecorder.stop(); } catch (e) {}
  }
}



// ─── System-Only Audio Recording (native ScreenCaptureKit via Swift) ──────────

async function startSystemAudioRecording() {
  try {
    audioChunks = [];
    chunkQueue = [];
    chunkTranscripts = [];
    currentChunkIndex = 0;
    lastSampleOffset = 0;
    isProcessingChunkQueue = false;

    // Start native ScreenCaptureKit system audio capture
    const result = await window.api.startSystemAudioCapture();
    if (result && result.error) {
      throw new Error('System audio capture failed: ' + result.error);
    }
    console.log('[startSystemAudioRecording] Native ScreenCaptureKit system audio started');

    // ── System VAD meter with running noise-floor calibration ──
    const sysDbHistory = [];
    const calibrationDurationMs = 2000;
    const calibrationStart = Date.now();
    let sysNoiseFloor = -60;
    let sysCalibrated = false;
    let sysSilenceStart = null;       // timestamp when silence began
    const sysSilenceMs = 2000;        // 2s sustained silence shown in VAD

    window._sysVadInterval = setInterval(() => {
      if (!isRecording || !vadMeterBadge) return;
      vadMeterBadge.classList.add('visible');
      vadDbText.textContent = `SYS ${sysAudioDb}dB`;

      const elapsed = Date.now() - calibrationStart;

      if (!sysCalibrated && elapsed < calibrationDurationMs) {
        // Calibration: collect dB samples to estimate noise floor
        sysDbHistory.push(sysAudioDb);
        const normVol = Math.max(0, Math.min(100, ((sysAudioDb + 90) / 90) * 100));
        vadMeterFill.style.width = normVol + '%';
        vadNoiseFloorMarker.style.left = '8%';
        vadMeterBadge.classList.remove('speaking', 'silence');
        const remaining = Math.ceil((calibrationDurationMs - elapsed) / 1000);
        vadStateTag.textContent = `CALIB ${remaining}s`;
        statusText.textContent = `calibrating system audio... ${remaining}s`;
      } else {
        if (!sysCalibrated) {
          // Finish calibration: noise floor = average of quietest 30%
          sysDbHistory.sort((a, b) => a - b);
          const quietCount = Math.max(1, Math.floor(sysDbHistory.length * 0.3));
          sysNoiseFloor = sysDbHistory.slice(0, quietCount).reduce((a, b) => a + b, 0) / quietCount;
          sysCalibrated = true;
          console.log('[sysVAD] Calibrated noise floor:', sysNoiseFloor.toFixed(1), 'dB');
        }

        const normVol = Math.max(0, Math.min(100, ((sysAudioDb + 90) / 90) * 100));
        const normFloor = Math.max(2, Math.min(95, ((sysNoiseFloor + 90) / 90) * 100));
        vadMeterFill.style.width = normVol + '%';
        vadNoiseFloorMarker.style.left = normFloor + '%';

        const threshold = sysNoiseFloor + 8; // 8dB above noise floor
        if (sysAudioDb > threshold) {
          vadMeterBadge.classList.add('speaking');
          vadMeterBadge.classList.remove('silence');
          vadStateTag.textContent = 'SPEECH';
          sysSilenceStart = null;
        } else {
          vadMeterBadge.classList.remove('speaking');
          // Track silence duration for visual VAD (never auto-stop)
          if (autoChunks) {
            if (!sysSilenceStart) sysSilenceStart = Date.now();
            const silenceElapsed = Date.now() - sysSilenceStart;
            if (silenceElapsed >= sysSilenceMs) {
              vadMeterBadge.classList.add('silence');
              vadStateTag.textContent = 'SILENT';
            } else {
              const remaining = Math.max(0, (sysSilenceMs - silenceElapsed) / 1000).toFixed(1);
              vadStateTag.textContent = `WAIT ${remaining}s`;
            }
          } else {
            vadMeterBadge.classList.remove('silence');
            vadStateTag.textContent = 'QUIET';
          }
        }
      }
    }, 100);

    isRecording = true;
    lastTranscript = '';
    silenceCount = 0;

    activate();
    audioBadge.classList.add('visible');
    vadMeterBadge.classList.add('visible');
    statusDot.classList.add('recording');
    statusText.textContent = 'system audio listening...';
    questionInput.placeholder = 'capturing system audio... press enter to stop';

    recordingStartTime = Date.now();
    recTimer.textContent = '0:00';
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      recTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      if (elapsed >= maxRecordingSeconds) {
        stopRecording(false);
      }
    }, 1000);

  } catch (err) {
    console.error('Failed to start system audio recording:', err);
    showError(`System audio recording failed: ${err.message}. Ensure Screen Recording permission is allowed in System Settings > Privacy & Security.`);
  }
}

// ─── WAV base64 → PCM Float32 decoder ──────────────────────────────────────

function wavBase64ToPcm(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  // Walk RIFF chunks to find 'data'
  let offset = 12; // skip RIFF header
  while (offset < bytes.length - 8) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      const dataStart = offset + 8;
      const numSamples = chunkSize / 2; // Int16 = 2 bytes
      const pcm = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        pcm[i] = view.getInt16(dataStart + i * 2, true) / 32768.0;
      }
      return pcm;
    }
    offset += 8 + chunkSize;
  }
  return new Float32Array(0);
}

// ─── WebM → WAV transcode & PCM slicing ───────────────────────────────────

async function decodeWebmToMonoPcm(webmBlob) {
  const arrayBuffer = await webmBlob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  const mono = decoded.numberOfChannels > 1
    ? mixToMono(decoded)
    : decoded.getChannelData(0);
  const sampleRate = decoded.sampleRate;
  audioCtx.close();
  return { mono, sampleRate };
}

function pcmToWavBlob(mono, sampleRate) {
  const numSamples = mono.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function webmToWav(webmBlob) {
  const { mono, sampleRate } = await decodeWebmToMonoPcm(webmBlob);
  return pcmToWavBlob(mono, sampleRate);
}

function mixToMono(audioBuffer) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const mono = new Float32Array(audioBuffer.length);
  for (let i = 0; i < audioBuffer.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── Submit Question ────────────────────────────────────────────────────────

async function submitQuestion(question) {
  isLoading = true;
  const userTyped = question !== undefined ? question : questionInput.value.trim();
  questionInput.value = '';
  inputSpinner.classList.add('visible');

  // Wait for all pending image transcriptions to finish (same pattern as audio chunks)
  if (isProcessingImageQueue || imageQueue.length > 0) {
    if (statusText) statusText.textContent = 'waiting for screenshot transcriptions...';
    while (isProcessingImageQueue || imageQueue.length > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }


  const totalScreenshots = Math.max(currentImageIndex, rawImageBases.length);
  if (totalScreenshots > 0 && statusText) {
    statusText.textContent = `${totalScreenshots} screenshot${totalScreenshots > 1 ? 's' : ''} sent`;
  }

  // Separate native vision vs background text transcripts
  const realTextTranscripts = imageTranscripts.filter(t => t && !t.includes('[Native Vision Model'));

  let finalPromptText = userTyped;

  if (realTextTranscripts.length > 0) {
    // Primary model is text-only (e.g. DeepSeek): concatenate background OCR/vision transcripts
    const screenshotContext = realTextTranscripts
      .map((t, idx) => `[Screenshot ${idx + 1} Description/Transcript]:\n${t}`)
      .join('\n\n');

    finalPromptText = userTyped
      ? `${screenshotContext}\n\n[User Question]: ${userTyped}\n\n[Instruction]: Use the screen context above to answer the user's question directly, solve any visible code or problems, and provide a clear, actionable response.`
      : `${screenshotContext}\n\n[Instruction]: Analyze the transcribed screen context above. If any code, errors, exercises, questions, or problems are visible on screen, solve them directly and provide a complete, clear answer.`;

    // Clear raw image base64 so base64 isn't attached to text models
    pendingScreenshot = null;
  } else if (pendingScreenshot || rawImageBases.length > 0 || currentImageIndex > 0) {
    // Primary model is native vision (e.g. Gemini, OpenAI, Anthropic): attach raw image directly!
    if (!pendingScreenshot && rawImageBases.length > 0) {
      pendingScreenshot = rawImageBases[rawImageBases.length - 1];
    }
  }

  const payload = { question: finalPromptText || userTyped || '' };
  if (pendingScreenshot) {
    payload.imageBase64 = pendingScreenshot;
  }
  if (pendingAudio) {
    payload.audioBase64 = pendingAudio.base64;
    payload.audioMimeType = pendingAudio.mimeType;
  }

  const hasScreen = !!pendingScreenshot || realTextTranscripts.length > 0 || totalScreenshots > 0;
  const hasAudio = !!pendingAudio;

  clearPendingAttachments();

  // Clear placeholder on first use
  const isFirstQuestion = answerContent.querySelector('.placeholder-text');
  if (isFirstQuestion) {
    answerContent.innerHTML = '';
  } else {
    answerContent.appendChild(document.createElement('hr'));
  }

  // Context tags
  if (hasScreen || hasAudio) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'context-tags';
    if (hasScreen) {
      const count = realTextTranscripts.length || totalScreenshots;
      tagsEl.innerHTML += `<span class="context-tag screen">+ ${count > 0 ? count + ' screenshot' + (count > 1 ? 's' : '') : 'screen'}</span>`;
    }
    if (hasAudio) tagsEl.innerHTML += '<span class="context-tag audio">+ audio</span>';
    answerContent.appendChild(tagsEl);
  }

  // Question echo
  const displayQuestion = userTyped || (hasScreen ? `[${realTextTranscripts.length || totalScreenshots || 1} screenshot(s)]` : hasAudio ? '[audio recording]' : '');
  const questionEcho = document.createElement('div');
  questionEcho.className = 'question-echo';
  questionEcho.textContent = displayQuestion;
  answerContent.appendChild(questionEcho);

  // Loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.className = 'answer-loading';
  loadingEl.innerHTML = '<span></span><span></span><span></span>';
  answerContent.appendChild(loadingEl);

  // Scroll to top of new question
  questionEcho.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const result = await window.api.sendQuestion(payload);
    loadingEl.remove();

    if (result.type === 'blocked') {
      const blockedEl = document.createElement('div');
      blockedEl.className = 'answer-text command-result muted-chip';
      blockedEl.textContent = result.message;
      answerContent.appendChild(blockedEl);
    } else if (result.type === 'error') {
      const errorEl = document.createElement('div');
      errorEl.className = 'answer-error';
      errorEl.textContent = result.error;
      answerContent.appendChild(errorEl);
    } else if (result.type === 'command') {
      const cmdEl = document.createElement('div');
      cmdEl.className = 'answer-text command-result';
      cmdEl.textContent = result.message || result.error || '';
      answerContent.appendChild(cmdEl);
      await hydrateUI();
    } else if (result.type === 'prompt-proposal') {
      const proposalEl = document.createElement('div');
      proposalEl.className = 'answer-text command-result';
      proposalEl.textContent = result.message || '';
      answerContent.appendChild(proposalEl);
      await hydrateUI();
    } else if (result.type === 'llm' && result.suppressed) {
      if (result.warning) {
        const warnEl = document.createElement('div');
        warnEl.className = 'answer-text muted-chip';
        warnEl.textContent = '⚠️ ' + result.warning;
        answerContent.appendChild(warnEl);
      }
      const chipEl = document.createElement('div');
      chipEl.className = 'answer-text muted-chip';
      chipEl.textContent = '🔇 muted — response not shown (context kept)';
      answerContent.appendChild(chipEl);
    } else if (result.type === 'llm') {
      if (result.warning) {
        const warnEl = document.createElement('div');
        warnEl.className = 'answer-text muted-chip';
        warnEl.textContent = '⚠️ ' + result.warning;
        answerContent.appendChild(warnEl);
      }
      const answerEl = document.createElement('div');
      answerEl.className = 'answer-text';
      answerEl.appendChild(formatAnswer(result.answer));
      answerContent.appendChild(answerEl);
    }

    // Keep view aligned to top of question & beginning of answer
    questionEcho.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    loadingEl.remove();
    showError(`Error: ${err.message}`);
  }

  isLoading = false;
  inputSpinner.classList.remove('visible');
  statusText.textContent = isActive ? 'active' : disabled ? 'disabled' : muted ? 'muted' : 'stealth';

  if (isActive && !disabled) {
    questionInput.focus();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function showError(message) {
  const errorEl = document.createElement('div');
  errorEl.className = 'answer-error';
  errorEl.textContent = message;
  answerContent.appendChild(errorEl);

  if (window.api && window.api.logHistory) {
    window.api.logHistory('[System Event]', message).catch(() => {});
  }
}

// ─── Scroll-to-bottom button ────────────────────────────────────────────────

answerArea.addEventListener('scroll', () => {
  const nearBottom = answerArea.scrollTop + answerArea.clientHeight >= answerArea.scrollHeight - 80;
  scrollBottomBtn.classList.toggle('visible', !nearBottom);
});

scrollBottomBtn.addEventListener('click', () => {
  answerArea.scrollTo({ top: answerArea.scrollHeight, behavior: 'smooth' });
});

// ─── Click handling ─────────────────────────────────────────────────────────

overlay.addEventListener('mousedown', (e) => {
  if (isActive && !e.target.closest('.input-wrapper')) {
    if (!e.target.closest('.answer-area') && !e.target.closest('.scroll-bottom')) {
      if (isRecording) stopRecording(true);
      deactivate();
    }
  }
});
