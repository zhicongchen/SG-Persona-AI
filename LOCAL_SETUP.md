# SG Persona AI — Local Setup Guide

This package contains the current SG Persona AI Web interface together with the
OpenPersona Persona packs used by the application.

## 1. Requirements

- macOS, Linux, or Windows
- Node.js 20 or 22 LTS
- npm
- Internet access when using an API-based model

Check that Node.js and npm are available:

```bash
node --version
npm --version
```

## 2. Install and Run

Open a terminal in the extracted project directory and run:

```bash
npm ci
npm start
```

Then open:

```text
http://localhost:3000
```

On first use, select **Create one** on the login page and register a local
account. There is no preset account; use any valid email address and a password
of at least eight characters. The application creates its SQLite database
automatically in `data/`.

The three generated OpenPersona Persona packs are already included in this
handoff package, so no additional Persona generation step is required.

## 3. Model Configuration

The handoff package includes a `.env.local` file that is currently configured
for DeepSeek. It also contains the API key used for the present research build,
so the application should be ready for an initial local test after the npm
dependencies have been installed.

The active settings have the following form:

```env
MODE=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

To use another DeepSeek key or model, edit `.env.local` and restart the server.

The application also supports OpenAI-compatible and local Ollama modes. See
`.env.example` and `README.md` for the corresponding settings.

## 4. Important Note About Local Models

A local model can be used for basic chat, but the complete workflow asks the
model to perform more than ordinary response generation. When an Interaction
ends, the application also runs model calls for:

1. producing a grounded session summary;
2. extracting durable Memory;
3. evaluating possible Persona State and relationship changes; and
4. returning machine-readable JSON for the resulting update.

Smaller local models may produce malformed or inconsistent JSON during these
steps. This can make Memory extraction or State evolution unreliable even when
the visible chat response looks reasonable. For stable end-to-end testing, a
capable API model is therefore recommended.

## 5. Optional Ollama Setup

To try a fully local model, install and start Ollama, then pull a model:

```bash
ollama serve
ollama pull qwen3.5:9b
```

Change `.env.local` to:

```env
MODE=local
OLLAMA_MODEL=qwen3.5:9b
```

Restart `npm start` after changing the configuration. Basic conversation may
work, but the structured Interaction settlement described above may be less
stable than with the API configuration.

## 6. Useful Commands

```bash
# Start the application
npm start

# Run the existing automated checks
npm test

# Regenerate all Persona packs from openpersona/configs/
npm run personas:generate
```

Regenerating the Persona packs may download the OpenPersona CLI through `npx`.
It is not necessary for normal use of this handoff package.

## 7. Local Data

Runtime data is created locally and is not included in the source package:

- user accounts and chat history;
- completed Interaction records;
- per-user Persona State and Memory;
- session data.

The SQLite database and related local files are stored under `data/`.
