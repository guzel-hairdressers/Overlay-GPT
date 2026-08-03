const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Questions & Answers ──
  sendQuestion: (payload) => ipcRenderer.invoke('send-question', payload),
  getConfig: () => ipcRenderer.invoke('get-config'),
  transcribeChunk: (audioBase64) => ipcRenderer.invoke('transcribe-chunk', audioBase64),

  // ── Interactive mode ──
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', interactive),

  // ── Screen capture ──
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // ── Window management ──
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),

  // ── Event listeners from main process ──
  onActivateInput: (callback) => {
    ipcRenderer.on('activate-input', () => callback());
  },

  onDeactivate: (callback) => {
    ipcRenderer.on('deactivate', () => callback());
  },

  onVisibilityChange: (callback) => {
    ipcRenderer.on('visibility-change', (_, visible) => callback(visible));
  },

  onScreenCaptured: (callback) => {
    ipcRenderer.on('screen-captured', (_, imageBase64) => callback(imageBase64));
  },

  onToggleAudio: (callback) => {
    ipcRenderer.on('toggle-audio', () => callback());
  },

  onToggleVideo: (callback) => {
    ipcRenderer.on('toggle-video', () => callback());
  },

  onMuteChange: (callback) => {
    ipcRenderer.on('mute-change', (_, muted) => callback(muted));
  },

  onDisableChange: (callback) => {
    ipcRenderer.on('disable-change', (_, disabled) => callback(disabled));
  },

  onConfigChange: (callback) => {
    ipcRenderer.on('config-change', (_, config) => callback(config));
  },

  onFlushChunk: (callback) => {
    ipcRenderer.removeAllListeners('flush-chunk');
    if (callback) {
      ipcRenderer.on('flush-chunk', () => callback());
    }
  }
});
