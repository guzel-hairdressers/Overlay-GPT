# Overlay GPT Wrapper (macOS)

A stealthy, screen-capture-invisible AI overlay for macOS. Hidden from screenshots, Zoom, OBS, and screen recordings — it sees everything, but nothing sees it.

Ask questions about your screen, pipe in audio, and get answers from the LLM of your choice. Built for Apple Silicon.

---

## Highlights

- **Invisible to capture** — `setContentProtection(true)` keeps it out of screenshots, screen shares, and recordings
- **Multi-provider** — DeepSeek, OpenAI, Anthropic, Google Gemini, plus any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter, etc.)
- **Multi-model** — switch models on the fly per provider
- **Screen-aware** — capture what's behind the overlay and ask about code, designs, spreadsheets, anything
- **Audio transcription** — on-device whisper (Apple Silicon) with dual-model: fast tiny for live preview, accurate small for final
- **Silent observe** — keep listening while suppressing responses; context accumulates until you unmute
- **Disable mode** — full pause of all input processing, re-enable with one shortcut
- **Always-on-top** — floats above all windows, including full-screen apps
- **Stealth mode** — dim to configurable opacity with click-through; subtle edge glow so you can find it
- **KaTeX math** — auto-detects bare LaTeX (`\frac`, `\sqrt`, `\cdot`, `\pm`, `b^2`, etc.), `$...$`, `\(...\)`, `\[...\]`, `$$...$$`
- **Provider theming** — overlay color changes to match active provider

---

## Project Structure

```
src/
├── main/                # Electron main process
│   ├── main.js          # Window, shortcuts, IPC handlers, whisper bridge
│   ├── config.js        # Config loading, legacy migration, defaults
│   ├── providers.js     # Multi-provider API routing (DeepSeek, Gemini, OpenAI, Anthropic, custom)
│   └── commands.js      # Slash-command parser and 11 handlers
├── preload/
│   └── preload.js       # Context bridge (IPC to renderer)
└── renderer/
    ├── index.html       # Overlay UI
    ├── renderer.js      # UI logic, audio recording, transcription, theming
    ├── markdown.js      # DOM-based markdown + KaTeX math renderer
    └── styles.css       # Provider themes, stealth effects, styling
bin/
└── transcribe.py        # mlx-whisper wrapper (offline, Apple Neural Engine)
```

---

## Quick Start

### 1. Install & Launch

```bash
npm install
npm start
```

### 2. Add an API Key

Press `Cmd + Shift + Space` to focus the overlay, then:

```
/key deepseek sk-your-key-here
/key openai sk-your-key-here
/key anthropic sk-ant-your-key-here
/key gemini YOUR_GEMINI_API_KEY
/key custom ollama http://localhost:11434/v1 ollama
```

Get keys from:
- **DeepSeek** — [platform.deepseek.com](https://platform.deepseek.com)
- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic** — [console.anthropic.com](https://console.anthropic.com)
- **Google Gemini** — [aistudio.google.com](https://aistudio.google.com)

Keys are stored locally in `~/Library/Application Support/overlay-gpt-wrapper/config.json` and never leave your machine (except when calling the provider's API).

### 3. Switch Provider

```
/provider deepseek
/provider openai
/provider gemini
/provider anthropic
```

The overlay theming changes to match. Default provider is DeepSeek.

### 4. Default Models

| Provider  | Default Model      | Notes                                    |
|-----------|--------------------|------------------------------------------|
| DeepSeek  | `deepseek-chat`    | Fast, capable, supports image input      |
| OpenAI    | `gpt-5.6-luna`     | Cheapest GPT-5.6 tier ($0.20/$1.20 per M)|
| Gemini    | `gemini-3.6-flash` | Latest fast Gemini ($1.50/$7.50 per M)   |
| Anthropic | `claude-sonnet-5`  | Balanced fast + capable                  |

Change per provider: `/model openai gpt-5.6-sol`

---

## Keyboard Shortcuts

| Shortcut             | Action                                                       |
|----------------------|--------------------------------------------------------------|
| `Cmd + Shift + Space`| **Activate & Ask** — Show overlay, focus input               |
| `Cmd + Shift + S`    | **Screen + Ask** — Capture screen behind overlay, attach it  |
| `Cmd + Shift + A`    | **Audio Record** — Start/stop recording with transcription   |
| `Cmd + Shift + M`    | **Mute** — Suppress responses, keep listening (context kept) |
| `Cmd + Shift + D`    | **Disable** — Full pause of all input processing             |
| `Cmd + Shift + G`    | **Hide / Show** — Toggle overlay visibility                  |
| `Cmd + Shift + Q`    | **Quit**                                                     |
| `Escape`             | **Stealth Mode** — Dim, click-through                        |

---

## Audio Recording & Transcription

### How it works

1. Press `Cmd + Shift + A` to start recording
2. Every 3 seconds, `whisper-tiny` transcribes the audio — live text appears in the input field
3. After 3 seconds of silence, recording auto-stops and the question is submitted
4. Before reaching the LLM, `whisper-small` re-transcribes the final audio for accuracy
5. Or press `Cmd + Shift + A` / `Enter` to stop and submit manually

### Provider audio support

| Provider   | Audio Support                                     |
|------------|---------------------------------------------------|
| DeepSeek   | Offline whisper transcription (tiny → small)      |
| Anthropic  | Offline whisper transcription (tiny → small)      |
| OpenAI     | Native multimodal audio (if using audio-capable model) |
| Gemini     | Native multimodal audio                            |

Transcription uses Apple's MLX framework on the Neural Engine — fully offline, no API keys needed. The `whisper-tiny` model (~150MB) provides fast live previews. The `whisper-small` model (~500MB) provides accurate final transcription for English, Russian, German, and 96 other languages.

### Audio sources

```
/audio mic       # Microphone (default)
/audio system    # System audio (browser, Zoom, etc.)
/audio off       # Disable audio capture
```

---

## In-App Commands

### Provider & Key Management

| Command                                    | Description                                        |
|--------------------------------------------|----------------------------------------------------|
| `/key <provider> <key>`                   | Set API key for deepseek, openai, anthropic, gemini |
| `/key custom <name> <endpoint> [key]`     | Add an OpenAI-compatible provider                  |
| `/provider <name>`                        | Switch active provider                              |
| `/providers`                              | List all configured providers                       |

### Model Selection

| Command                           | Description                               |
|-----------------------------------|-------------------------------------------|
| `/model <model-id>`              | Set model for active provider             |
| `/model <provider> <model-id>`   | Set model for specific provider           |
| `/models [provider]`             | List available models                     |

### Audio

| Command       | Description                               |
|---------------|-------------------------------------------|
| `/audio mic`  | Record from microphone                    |
| `/audio system`| Capture system audio (browser, Zoom)     |
| `/audio off`  | Disable audio                             |

### Display & Session

| Command              | Description                                        |
|----------------------|----------------------------------------------------|
| `/mute`              | Toggle silent observe — suppresses responses       |
| `/disable`           | Toggle full pause of all input                      |
| `/opacity <0.01-1>`  | Set stealth mode opacity (default: 0.15)           |
| `/clear [all]`       | Reset conversation history for active provider      |
| `/help`              | Show all available commands                         |

---

## Modes

### Stealth (Escape)
Overlay dims to configurable opacity. A subtle accent-colored edge glow keeps it findable. Click-through enabled. Hover to surface slightly. Default opacity: 0.15.

### Mute (`Cmd + Shift + M`)
LLM calls still fire and context accumulates, but responses are hidden. A "muted" badge shows in the status bar. Useful for passively following a meeting or lecture without interruption. Unmute to continue with full context.

### Disable (`Cmd + Shift + D`)
Full pause. No API calls, no screen capture, no audio processing. The overlay sits dormant. Only `/disable` command and `Cmd + Shift + D` shortcut work. Distinct from mute: mute still processes, disable does nothing.

---

## Screen + Code

Press `Cmd + Shift + S` to capture whatever is behind the overlay. The screenshot is sent as a multimodal attachment. All providers support image input.

---

## Math Rendering

KaTeX renders LaTeX math automatically. All of these formats work:

- **Bare LaTeX**: `\frac{a}{b}`, `\sqrt{x}`, `\cdot`, `\pm`, `\alpha`, `\sum`
- **Superscripts/subscripts**: `b^2`, `x_i`, `x^{n+1}`, `x_{i+1}`
- **Inline delimiters**: `$...$`, `\(...\)`
- **Display delimiters**: `$$...$$`, `\[...\]` (centered, can span multiple lines)

---

## Provider Theming

The overlay accent color changes to match the active provider:

| Provider  | Color  |
|-----------|--------|
| DeepSeek  | Blue   |
| Gemini    | Green  |
| OpenAI    | Purple |
| Anthropic | Orange |
| Custom    | Pink   |

---

## Custom Providers

Any OpenAI-compatible API works:

```
/key custom ollama http://localhost:11434/v1 ollama
/key custom groq https://api.groq.com/openai/v1 gsk-...
/key custom openrouter https://openrouter.ai/api/v1 sk-or-...
```

Then `/provider ollama` to switch.

---

## What's Implemented

- [x] Multi-provider API routing (DeepSeek, Gemini, OpenAI, Anthropic, custom)
- [x] Screen capture with multimodal image input
- [x] Audio recording with on-device whisper transcription (tiny + small dual-model)
- [x] Live interim transcription during recording
- [x] Silence detection (3s) with auto-submit
- [x] Mute mode (suppress responses, keep context)
- [x] Disable mode (full processing pause)
- [x] Stealth mode with configurable opacity and edge indicator
- [x] KaTeX math rendering with bare LaTeX auto-detection
- [x] Provider-based UI theming
- [x] Slash commands for all settings
- [x] Conversation history per provider
- [x] Config persistence and legacy migration
- [x] WebM to WAV audio transcoding
- [x] System audio capture (mic or system output)
- [x] Screen-capture invisible (`setContentProtection`)
- [x] Markdown rendering with code copy buttons

## What's Still Planned

- [ ] **Voice conversation mode** — like GPT-4o voice or Gemini Live: continuous two-way audio conversation with auto turn-taking. Requires an OpenAI or Gemini API key (DeepSeek does not offer an audio API). Currently blocked on the user obtaining an audio-capable provider key.
- [ ] **More stable real-time transcription** — whisper-tiny is fast but jittery; explore chunked incremental transcription or streaming ASR services
- [ ] **Better silence detection** — current threshold-based approach is simplistic; could use VAD (voice activity detection) or energy-based detection
- [ ] **Streaming LLM responses** — show tokens as they arrive instead of waiting for the full response
- [ ] **Persistent conversation history across restarts** — currently in-memory only, lost on quit
- [ ] **Window resize and reposition** — overlay is fixed size/position; could be draggable
- [ ] **Multiple overlay instances** — prevent stacking from multiple launches (single-instance lock)
- [ ] **Hotkey customization** — configurable keyboard shortcuts
- [ ] **Export conversation** — save chat history to file
- [ ] **Plug-in system for tools** — calculator, web search, file reading via model tool-use
