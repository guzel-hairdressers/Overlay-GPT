# Overlay GPT Wrapper (macOS)

A stealthy, screen-capture-invisible AI overlay for macOS. Hidden from screenshots, Zoom, OBS, and screen recordings — it sees everything, but nothing sees it.

Ask questions about your screen, pipe in browser or Zoom audio, and get answers from the LLM of your choice. Quietly observe without responding when you just need to listen.

---

## Highlights

- **Invisible to capture** — `setContentProtection(true)` keeps it out of screenshots, screen shares, and recordings
- **Multi-provider** — bring your own keys for DeepSeek, OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint
- **Multi-model** — switch models on the fly per provider
- **Screen-aware** — capture what's behind the overlay and ask about code, designs, spreadsheets, anything
- **System audio** — listen to browser tabs, Zoom calls, or any system output and pipe the transcript to the LLM
- **Silent observe mode** — keep listening and reading the screen while temporarily suppressing answers
- **Disable mode** — pause all input processing with one shortcut
- **Always-on-top** — floats above all windows, including full-screen apps
- **Stealth mode** — dim to near-invisible with click-through; hover or hotkey to surface

---

## Project Structure

```
src/
├── main/           # Electron main process
│   ├── main.js     # Window, shortcuts, IPC handlers
│   ├── config.js   # Config loading, migration, defaults
│   ├── providers.js # Multi-provider API routing
│   └── commands.js # Slash-command parser and handlers
├── preload/
│   └── preload.js  # Context bridge (IPC to renderer)
└── renderer/
    ├── index.html  # Overlay UI
    ├── renderer.js # UI logic, audio, theming
    ├── markdown.js # DOM-based markdown renderer
    └── styles.css  # Provider themes and styling
```

---

## Quick Start

### 1. Install & Launch

```bash
npm start
```

### 2. Add an API Key (First Time Only)

Press `Cmd + Shift + Space` to focus the overlay, then:

```
/key deepseek sk-your-key-here
/key openai sk-your-key-here
/key anthropic sk-ant-your-key-here
/key gemini YOUR_GEMINI_API_KEY
```

Get keys from:
- **DeepSeek** — [platform.deepseek.com](https://platform.deepseek.com)
- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic** — [console.anthropic.com](https://console.anthropic.com)
- **Google Gemini** — [aistudio.google.com](https://aistudio.google.com)

You can store multiple keys at once. Only the active provider's key is used per request.

### 3. Switch Provider

```
/provider deepseek
/provider openai
/provider gemini
```

The overlay theming changes to match the active provider.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd + Shift + Space` | **Activate & Ask** — Show overlay, focus input |
| `Cmd + Shift + S` | **Screen + Ask** — Capture the screen behind the overlay and attach it |
| `Cmd + Shift + A` | **Audio Record** — Press once to start, again to stop & transcribe / answer |
| `Cmd + Shift + M` | **Mute** — Toggle silent-observe: keeps listening & reading, suppresses answers |
| `Cmd + Shift + D` | **Disable** — Toggle full pause: stops all input processing until re-enabled |
| `Cmd + Shift + G` | **Hide / Show** — Toggle overlay visibility |
| `Cmd + Shift + Q` | **Quit** — Close the app completely |
| `Escape` | **Stealth Mode** — Dim to near-invisible, enable click-through |

---

## In-App Commands

Type these directly into the prompt box:

### Provider & Key Management

| Command | Description |
|---|---|
| `/key <provider> <key>` | Set API key for deepseek, openai, anthropic, or gemini |
| `/key custom <name> <endpoint> [key]` | Add an OpenAI-compatible provider (e.g. Ollama, Groq, OpenRouter) |
| `/provider <name>` | Switch the active provider |
| `/providers` | List all configured providers |

### Model Selection

| Command | Description |
|---|---|
| `/model <model-id>` | Set the model for the active provider |
| `/model <provider> <model-id>` | Set model for a specific provider |
| `/models` | List available models for the active provider |

### Audio

| Command | Description |
|---|---|
| `/audio mic` | Record from microphone |
| `/audio system` | Capture system audio (browser, Zoom, etc.) |
| `/audio off` | Disable audio capture |

### Display & Session

| Command | Description |
|---|---|
| `/mute` | Toggle silent observe — suppresses responses, keeps context |
| `/disable` | Toggle disable — pauses all input processing |
| `/opacity <0.01-1>` | Set stealth mode opacity (default: 0.15) |
| `/clear [all]` | Reset conversation history |
| `/help` | Show all available commands |

---

## Silent Observe Mode

Press `Cmd + Shift + M` (or type `/mute`) to toggle **silent observe** mode.

While muted:
- The overlay **continues to listen** to system/mic audio
- Screen captures still work
- The LLM **receives context** but its responses are **suppressed**
- A "muted" indicator shows in the status bar
- Useful for: letting the model follow a meeting without interrupting, passively indexing a lecture, or accumulating context before you ask a question

Press `Cmd + Shift + M` again to unmute — the next answer will have full context of everything observed while muted.

---

## Disable Mode

Press `Cmd + Shift + D` (or type `/disable`) to toggle **disable** mode. Unlike mute (which still processes input but hides responses), disable mode fully pauses all input processing — no API calls, no screen captures, no audio recording. The overlay sits dormant until re-enabled.

---

## Screen + Code

Press `Cmd + Shift + S` to capture whatever is behind the overlay:

- **Code in your editor** — ask it to explain, debug, or refactor
- **Browser content** — ask about documentation, PRs, dashboards
- **Design mockups** — ask for implementation notes or CSS
- **Terminal output** — ask it to diagnose errors
- **Spreadsheets & slides** — ask for summaries or insights

The screenshot is sent as a multimodal attachment alongside your text prompt. You can also press Enter with an empty prompt to get an uncued description of the screen.

---

## Browser & Zoom Audio

Set audio source to system with `/audio system`, then press `Cmd + Shift + A` to record. The overlay captures system audio output — whatever is playing through your speakers:

- **Zoom / Meet / Teams calls** — transcribe and answer questions about the conversation
- **YouTube / tutorials** — ask for summaries or clarification
- **Podcasts** — capture context and ask follow-ups

Note: audio input is not supported by Anthropic or DeepSeek. Use Gemini or OpenAI for audio features.

---

## Quit

- Press `Cmd + Shift + Q` anywhere
- Or `Ctrl + C` in the terminal

---

## Tips

- **All config is local** — API keys are stored in `~/Library/Application Support/overlay-gpt-wrapper/config.json` and never leave your machine except when calling the provider's API directly
- **Stealth is the default** — the overlay starts dim and click-through so it never gets in your way
- **Multiple keys coexist** — set keys for every provider you use; switch between them with `/provider`
- **Custom endpoints** — Ollama, LM Studio, Groq, OpenRouter, and any OpenAI-compatible API work via `/key custom <name> <endpoint> <key>`
- **Provider theming** — the overlay changes color to match your active provider: DeepSeek (blue), Gemini (green), OpenAI (purple), Anthropic (orange)
