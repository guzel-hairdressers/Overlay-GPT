# 👻 Overlay GPT Wrapper (macOS)

A stealthy, screen-capture-invisible AI overlay for macOS. Hidden from screenshots, Zoom, OBS, and screen recordings — it sees everything, but nothing sees it.

Ask questions about your screen, pipe in browser or Zoom audio, and get answers from the LLM of your choice. Quietly observe without responding when you just need to listen.

---

## ✨ Highlights

- **Invisible to capture** — `setContentProtection(true)` keeps it out of screenshots, screen shares, and recordings
- **Multi-provider** — bring your own keys for OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint
- **Multi-model** — switch models on the fly per provider
- **Screen-aware** — capture what's behind the overlay and ask about code, designs, spreadsheets, anything
- **System audio** — listen to browser tabs, Zoom calls, or any system output and pipe the transcript to the LLM
- **Silent observe mode** — keep listening and reading the screen while temporarily suppressing answers
- **Always-on-top** — floats above all windows, including full-screen apps
- **Stealth mode** — dim to near-invisible with click-through; hover or hotkey to surface

---

## 🚀 Quick Start

### 1. Install & Launch

```bash
npm start
```

### 2. Add an API Key (First Time Only)

Press `Cmd + Shift + Space` to focus the overlay, then:

```
/key openai sk-your-key-here
/key anthropic sk-ant-your-key-here
/key gemini YOUR_GEMINI_API_KEY
```

Get keys from:
- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic** — [console.anthropic.com](https://console.anthropic.com)
- **Google Gemini** — [aistudio.google.com](https://aistudio.google.com)

You can store multiple keys at once. Only the active provider's key is used per request.

### 3. Pick a Model

```
/model openai gpt-4o
/model anthropic claude-sonnet-5-20251001
/model gemini gemini-2.5-pro
```

---

## ⌨️ Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd + Shift + Space` | **Activate & Ask** — Show overlay, focus input |
| `Cmd + Shift + S` | **Screen + Ask** — Capture the screen behind the overlay and attach it |
| `Cmd + Shift + A` | **Audio Record** — Press once to start, again to stop & transcribe / answer |
| `Cmd + Shift + M` | **Mute Responses** — Toggle silent-observe: keeps listening & reading, suppresses answers |
| `Cmd + Shift + G` | **Hide / Show** — Toggle overlay visibility |
| `Cmd + Shift + Q` | **Quit** — Close the app completely |
| `Escape` | **Stealth Mode** — Dim to ~8% opacity, enable click-through |

---

## ⚙️ In-App Commands

Type these directly into the prompt box:

### Provider & Key Management

| Command | Description |
|---|---|
| `/key openai <key>` | Set your OpenAI API key |
| `/key anthropic <key>` | Set your Anthropic API key |
| `/key gemini <key>` | Set your Google Gemini API key |
| `/key custom <endpoint> <key>` | Add an OpenAI-compatible provider (e.g. Ollama, Groq, OpenRouter) |
| `/provider <name>` | Switch the active provider |
| `/providers` | List all configured providers |

### Model Selection

| Command | Description |
|---|---|
| `/model <model-id>` | Set the model for the active provider |
| `/model openai gpt-4o` | Set model for a specific provider |
| `/models` | List available models for the active provider |

### Audio

| Command | Description |
|---|---|
| `/audio mic` | Record from microphone |
| `/audio system` | Capture system audio (browser, Zoom, etc.) |
| `/audio off` | Disable audio capture |

---

## 🔇 Silent Observe Mode

Press `Cmd + Shift + M` (or type `/mute`) to toggle **silent observe** mode.

While muted:
- The overlay **continues to listen** to system/mic audio
- Screen captures still work
- The LLM **receives context** but its responses are **suppressed**
- A subtle "muted" indicator shows in the status bar
- Useful for: letting the model follow a meeting without interrupting, passively indexing a lecture, or accumulating context before you ask a question

Press `Cmd + Shift + M` again to unmute — the next answer will have full context of everything observed while muted.

---

## 🖥️ Screen + Code

Press `Cmd + Shift + S` to capture whatever is behind the overlay:

- **Code in your editor** — ask it to explain, debug, or refactor
- **Browser content** — ask about documentation, PRs, dashboards
- **Design mockups** — ask for implementation notes or CSS
- **Terminal output** — ask it to diagnose errors
- **Spreadsheets & slides** — ask for summaries or insights

The screenshot is sent as a multimodal attachment alongside your text prompt. You can also press Enter with an empty prompt to get an uncued description of the screen.

---

## 🎧 Browser & Zoom Audio

Set audio source to system with `/audio system`, then press `Cmd + Shift + A` to record. The overlay captures system audio output — whatever is playing through your speakers:

- **Zoom / Meet / Teams calls** — transcribe and answer questions about the conversation
- **YouTube / tutorials** — ask for summaries or clarification
- **Podcasts** — capture context and ask follow-ups

The audio is transcribed and sent to the LLM along with any screen capture and text prompt.

---

## 🛑 Quit

- Press `Cmd + Shift + Q` anywhere
- Or `Ctrl + C` in the terminal

---

## 🔧 Tips

- **All config is local** — API keys are stored in `~/Library/Application Support/overlay-gpt-wrapper/config.json` and never leave your machine except when calling the provider's API directly
- **Stealth is the default** — the overlay starts dim and click-through so it never gets in your way
- **Multiple keys coexist** — set keys for every provider you use; switch between them with `/provider`
- **Custom endpoints** — Ollama, LM Studio, Groq, OpenRouter, and any OpenAI-compatible API work via `/key custom <url> <key>`
