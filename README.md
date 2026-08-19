# Singapore AI Chat

A chat application with AI personas that can discuss Singapore-related topics.

## Prerequisites

### 1. Install Node.js

Make sure you have Node.js installed. You can download it from:
- https://nodejs.org/

Verify installation:
```bash
node --version
npm --version
```

### 2. Install Ollama (for local LLM)

**Download Ollama:**
- Visit: https://ollama.com/download
- Download and install the appropriate version for macOS
- Or use Homebrew: `brew install ollama`

**Run Ollama:**
```bash
ollama serve
```

**Pull the required model:**
```bash
ollama pull qwen3.5:9b
```

This model is required for local inference. The model will be downloaded automatically when you first use the local mode.

## Setup

### 1. Install Dependencies

```bash
npm install
npm run personas:generate
```

### 2. Configure Environment

Create a `.env` file in the project root:

```env
# For local mode (Ollama)
MODE=local

# For OpenAI mode
# MODE=openai
# OPENAI_API_KEY=your-api-key-here
```

## Running the Project

### Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000`

### Access the Application

Open your browser and navigate to:
```
http://localhost:3000
```

## Interaction and Memory Lifecycle

A conversation is the persistent chat window. Each window can contain multiple
logical interactions:

1. Chat normally with the selected Persona.
2. Click **End Interaction** when the current interaction is complete.
3. The application first analyzes that interaction into a grounded summary,
   durable Memory candidates, and cited relationship/state-change evidence.
4. A separate model pass receives that validated assessment (not the raw chat)
   and converts only the supported conclusions into the final Persona patch.
5. The application stores Memory, applies the patch, and increments
   `interactionCount` once.
6. Continue in the same window. Earlier messages remain visible, while the next
   model request uses the latest Persona state, recalled Memory, and only the
   messages from the new interaction.

Every completed Interaction writes one episodic summary to long-term Memory so
the Persona can retain conversational continuity, including user-initiated
role-play events. Durable user facts are stored separately and require a
verbatim user message as evidence. Relationship-stage history remains in
Persona State rather than being treated as a user fact.

The host does not decide whether conversational evidence is warm, personal, or
otherwise meaningful. That semantic judgment belongs to the first model pass.
It only validates cited message/Memory IDs and quotes, configured interaction
minimums, one-step relationship order, allowed fields, and consistency between
the evidence assessment and the second-pass patch.

### OpenPersona runtime context

Ordinary chat behavior comes from OpenPersona source material rather than a
host-authored prohibition list. The prompt includes the Constitution except its
evolution-ethics section, the Persona Injection's identity/personality/
self-awareness content, OpenPersona's relationship-stage behavior and Memory
recall/privacy rules, a compact State view, recalled Memory, and the current
Interaction. Body/host-operation instructions, Self-Narrative, Growth, state
write instructions, and relationship-transition mechanics are excluded from
ordinary replies.

The complete OpenPersona growth and Memory rules remain available to the
separate two-pass interaction-settlement process. User-configured numeric
relationship thresholds override OpenPersona's default counts, while its
qualitative relationship criteria still apply.

The Persona details drawer exposes State, current Context, Memory, History, and
Settings. Relationship progression minimums are stored separately for each
user and Persona. Defaults are 1 completed interaction for stranger →
acquaintance and 10 for acquaintance → friend; OpenPersona's qualitative
criteria still apply.

## Changing the Mode

The application supports three modes:

### Local Mode (Ollama)

Set in `.env`:
```env
MODE=local
```

- Uses Ollama running locally on `http://localhost:11434`
- Model: `qwen3.5:9b`
- No API key required
- Runs entirely offline

### OpenAI Mode

Set in `.env`:
```env
MODE=openai
OPENAI_API_KEY=sk-your-api-key-here
```

- Uses OpenAI's API
- Model: `gpt-4o-mini`
- Requires valid OpenAI API key
- Runs online (requires internet)

### DeepSeek Mode

Set in `.env`:

```env
MODE=deepseek
DEEPSEEK_API_KEY=your-api-key-here
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

- Uses DeepSeek's OpenAI-compatible chat completions API.
- The same model is used for chat and the two interaction-settlement passes.
- Runs online (requires internet)

## Available Personas

The application includes several AI personas:

- **grab-uncle** - John Tan, a 64-year-old Grab driver in Singapore
- **singapore-born-lady** - Lim Kwai Lan, a 45-year-old Singaporean who studied in the US
- **french-dude** - Pierre Marchand, a 32-year-old French person living in Singapore

## Project Structure

```
SG-Persona-AI/
├── package.json          # Node.js dependencies and scripts
├── persona.json          # Legacy Persona definitions (no longer loaded)
├── openpersona/
│   ├── configs/          # Source configurations for the three Personas
│   └── templates/        # Generated Persona packs (gitignored)
├── server.js            # Express server with chat logic
├── persona-evolution.js # Interaction settlement and Persona state updates
├── persona-memory.js    # Per-user, per-Persona OpenPersona Memory store
├── persona-settings.js  # Relationship progression settings
├── .env                 # Environment configuration (create this)
├── public/
│   ├── index.html       # Main HTML page
│   ├── script.js        # Frontend JavaScript
│   └── style.css        # Styles
└── README.md            # This file
```

## License

MIT
