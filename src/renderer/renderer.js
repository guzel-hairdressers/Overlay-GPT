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

// Multimodal attachments
let pendingScreenshot = null;
let pendingAudio = null;

// Audio recording state
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimerInterval = null;

// ─── Init / Hydrate ──────────────────────────────────────────────────────────

async function hydrateUI() {
  try {
    const cfg = await window.api.getConfig();
    providerId = cfg.activeProvider;
    providerKind = cfg.activeProviderKind;
    overlay.dataset.provider = providerId;
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

    // Show placeholder if no keys at all
    const hasAnyKey = Object.values(cfg.providers).some(p => p.hasKey) ||
                      cfg.customProviders.some(p => p.hasKey);
    if (!hasAnyKey && answerContent.querySelector('.placeholder-text')) {
      answerContent.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'placeholder-text';
      p.innerHTML = 'No API key set.<br><br>Press <strong>Cmd+Shift+Space</strong> and type:<br><code>/key deepseek &lt;your-key&gt;</code><br><br>Also: <code>/key openai &lt;key&gt;</code>  <code>/key gemini &lt;key&gt;</code>';
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
  screenBadge.classList.remove('visible');
  questionInput.placeholder = disabled ? 'disabled — /disable to resume' : 'ask anything...';
}

// ─── IPC Listeners ──────────────────────────────────────────────────────────

window.api.onActivateInput(() => {
  activate();
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

window.api.onScreenCaptured((imageBase64) => {
  if (disabled) return;
  pendingScreenshot = imageBase64;
  screenBadge.classList.add('visible');
  activate();
  questionInput.placeholder = 'ask about the screen... (or press enter)';
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
  modelBadge.textContent = cfg.activeProviderName + ' · ' + cfg.activeProviderModel;
  document.documentElement.style.setProperty('--stealth-opacity', String(cfg.stealthOpacity));
  document.documentElement.style.setProperty('--stealth-hover-opacity',
    String(Math.min(cfg.stealthOpacity * 1.8, 0.4)));
});

// ─── Keyboard Handling ──────────────────────────────────────────────────────

questionInput.addEventListener('keydown', async (e) => {
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
    if ((!question && !pendingScreenshot && !pendingAudio) || isLoading) return;

    await submitQuestion(question);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isActive) {
    e.preventDefault();
    if (isRecording) stopRecording(true);
    deactivate();
  }
});

// ─── Audio Recording ────────────────────────────────────────────────────────

async function startRecording() {
  if (audioSource === 'off') {
    showError('Audio is disabled. Use /audio mic or /audio system to enable.');
    return;
  }

  try {
    let stream;

    if (audioSource === 'system') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              minWidth: 1, maxWidth: 1,
              minHeight: 1, maxHeight: 1
            }
          }
        });
        stream.getVideoTracks().forEach(t => t.stop());
        stream = new MediaStream(stream.getAudioTracks());
      } catch (err) {
        console.warn('System audio capture failed, falling back to mic:', err);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());

      if (audioChunks.length === 0) return;

      const blob = new Blob(audioChunks, { type: 'audio/webm' });

      // Transcode webm → wav for providers that need it (OpenAI)
      let finalBlob = blob;
      let finalMimeType = 'audio/webm';

      if (providerKind === 'openai') {
        try {
          finalBlob = await webmToWav(blob);
          finalMimeType = 'audio/wav';
        } catch (e) {
          console.warn('WAV transcode failed, sending webm:', e);
        }
      }

      const arrayBuffer = await finalBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      pendingAudio = { base64, mimeType: finalMimeType };
      audioBadge.classList.remove('visible');
      statusDot.classList.remove('recording');

      const question = questionInput.value.trim() || '';
      await submitQuestion(question);
    };

    mediaRecorder.start(1000);
    isRecording = true;

    activate();
    audioBadge.classList.add('visible');
    statusDot.classList.add('recording');
    statusText.textContent = 'recording';
    questionInput.placeholder = 'recording... press enter or ⌘⇧A to stop';

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

function stopRecording(discard) {
  if (!mediaRecorder || !isRecording) return;

  isRecording = false;
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;

  if (discard) {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = () => {
      mediaRecorder.stream?.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.stop();
    audioBadge.classList.remove('visible');
    statusDot.classList.remove('recording');
    statusText.textContent = isActive ? 'active' : disabled ? 'disabled' : muted ? 'muted' : 'stealth';
    questionInput.placeholder = 'ask anything...';
    audioChunks = [];
    return;
  }

  statusText.textContent = 'processing';
  mediaRecorder.stop();
}

// ─── WebM → WAV transcode ──────────────────────────────────────────────────

async function webmToWav(webmBlob) {
  const arrayBuffer = await webmBlob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  const mono = decoded.numberOfChannels > 1
    ? mixToMono(decoded)
    : decoded.getChannelData(0);

  const sampleRate = decoded.sampleRate;
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

  audioCtx.close();
  return new Blob([buffer], { type: 'audio/wav' });
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
  questionInput.value = '';
  inputSpinner.classList.add('visible');

  const payload = { question: question || '' };
  if (pendingScreenshot) payload.imageBase64 = pendingScreenshot;
  if (pendingAudio) {
    payload.audioBase64 = pendingAudio.base64;
    payload.audioMimeType = pendingAudio.mimeType;
  }

  const hasScreen = !!pendingScreenshot;
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
    if (hasScreen) tagsEl.innerHTML += '<span class="context-tag screen">+ screen</span>';
    if (hasAudio) tagsEl.innerHTML += '<span class="context-tag audio">+ audio</span>';
    answerContent.appendChild(tagsEl);
  }

  // Question echo
  const displayQuestion = question || (hasScreen ? '[screen capture]' : hasAudio ? '[audio recording]' : '');
  const questionEcho = document.createElement('div');
  questionEcho.className = 'question-echo';
  questionEcho.textContent = displayQuestion;
  answerContent.appendChild(questionEcho);

  // Loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.className = 'answer-loading';
  loadingEl.innerHTML = '<span></span><span></span><span></span>';
  answerContent.appendChild(loadingEl);

  answerArea.scrollTop = answerArea.scrollHeight;

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
    } else if (result.type === 'llm' && result.suppressed) {
      const chipEl = document.createElement('div');
      chipEl.className = 'answer-text muted-chip';
      chipEl.textContent = '🔇 muted — response not shown (context kept)';
      answerContent.appendChild(chipEl);
    } else if (result.type === 'llm') {
      const answerEl = document.createElement('div');
      answerEl.className = 'answer-text';
      answerEl.appendChild(formatAnswer(result.answer));
      answerContent.appendChild(answerEl);
    }

    answerArea.scrollTop = answerArea.scrollHeight;

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
