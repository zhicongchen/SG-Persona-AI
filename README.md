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
npm run policy:personas
npm run personas:generate
```

`policy:personas` rebuilds the survey-grounded Persona configs from the dataset in
`data/policy_persona_project/`; `personas:generate` expands every config into an
OpenPersona pack. If the dataset is not present, skip the first command: the
committed configs in `openpersona/configs/policy/` are enough to build the packs.

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

The application serves 61 Personas in two families.

### Hand-authored (3)

- **grab-uncle** - John Tan, a 64-year-old Grab driver in Singapore
- **singapore-born-lady** - Lim Kwai Lan, a 45-year-old Singaporean who studied in the US
- **french-dude** - Pierre Marchand, a 32-year-old French person living in Singapore

### Survey-grounded (58)

`policy-p001` through `policy-p058`, each built from one anonymous respondent in a
Singapore political and social attitudes survey. They are listed by a demographic
label rather than a name, for example `P001 - 31F Psychologist in rnd`.

The source dataset lives in `data/policy_persona_project/` and has three parts:

| Path | Contents |
| --- | --- |
| `data/Pxxx.json` | Structured profile: demographics, political engagement, ideology (economic, social values, patriotism), reasoning style (evidence, context sensitivity, principle, certainty), issue salience and policy positions. Every Likert item is on a 1-7 scale. |
| `memory/interview_chunks/Pxxx.jsonl` | Five verbatim interview answers per respondent (immigration, welfare, surveillance, environment, minority rights) with a stance hint and confidence. |
| `memory/dynamic_events/Pxxx.json` | Verbatim personal experiences of policy impact or view change, tagged by affected topic. 65 events across 34 respondents; the other 24 reported none. |

Both the dataset under `data/` and the generated configs in
`openpersona/configs/policy/` are gitignored, so neither is in the repository.
**A fresh clone therefore serves only the 3 hand-authored Personas.** To get the
other 58 back, restore `data/policy_persona_project/` and run the two build
commands below; because generation is deterministic, that reproduces the same 58
configs byte for byte.

**How one is built.** `npm run policy:personas` derives the display name, bio,
personality traits, speaking style and immutable traits from the profile, with no
model call. `npm run personas:generate` then expands each config into a pack and
seeds it with two things:

- `soul/policy-profile.md` - the structured attitudes rendered as labelled
  statements with their raw score, folded into the system prompt by `personas.js`.
- `memory/memories.jsonl` - the interview answers and lived experiences as
  Memory records with `subject: "persona"`, retrieved by topic during chat.

### Design decisions

| Decision | Rationale |
| --- | --- |
| The 58 survey-grounded Personas replaced 73 earlier LLM-generated `survey-*` ones | They are the same people. Every `Pxxx` profile matches a `survey-*` respondent on verbatim free-text answers and demographics, so keeping both would have listed 58 respondents twice under different pseudonyms. |
| 15 respondents were dropped | They have no profile in the curated dataset, so they could only have been built the old way. Keeping them would mean two construction methods and non-uniform grounding in one list. |
| Generation is deterministic, with no LLM in the path | The old pipeline asked a model to invent a pseudonym, bio and personality prose per respondent, which was neither reproducible nor faithful to the data. Every field now traces back to a survey value, re-running produces byte-identical output, and the persona build needs no API key. |
| Personas are labelled `P001 - 31F Psychologist`, not given pseudonyms | Keeps each Persona traceable to its dataset row and avoids layering a fictional identity over a real respondent's attitudes. |
| The structured profile goes in the system prompt, not in Memory | Attitudes are stable identity rather than recalled episodes. In the prompt they cannot drift through evolution or fail to be retrieved. Scores are rendered in words with the raw value alongside, and the Persona is told never to recite them or mention the survey. |
| Interview answers and lived experiences go in Memory | They are topic-specific and should surface only when relevant, which the existing tag-based retrieval in `persona-memory.js` already does. |
| `buildMemoryPrompt` gained an `ownRecollections` bucket | It previously emitted only conversation summaries and memories with `subject: "user"`, so Persona-owned seeds would have been retrieved and then silently dropped from the prompt. |
| `scripts/import-survey-csv.js` and the survey tables were kept | The CSV import remains the provenance record linking respondents to Personas. Dropping the tables would be an unrelated migration. |
| Neither the dataset nor the generated configs are committed | The survey data includes verbatim free-text answers from real respondents, so it stays local. The configs are derived from it and are treated as build output rather than source. The cost is that the Persona set cannot be rebuilt from the repository alone; it needs the dataset. |

## Project Structure

```
SG-Persona-AI/
├── package.json          # Node.js dependencies and scripts
├── persona.json          # Legacy Persona definitions (no longer loaded)
├── openpersona/
│   ├── configs/          # Hand-authored Persona configurations
│   │   └── policy/       # Generated survey-grounded configs (gitignored)
│   └── templates/        # Generated Persona packs (gitignored)
├── scripts/
│   ├── generate-persona-templates.js  # Configs -> OpenPersona packs
│   ├── generate-policy-personas.js    # Dataset -> policy configs
│   ├── import-survey-csv.js           # Raw survey CSV -> SQLite
│   └── lib/
│       ├── policy-persona.js   # Deterministic derivation from survey values
│       └── policy-dataset.js   # Dataset reader and pack seeding
├── data/                # SQLite, session secret, survey dataset (gitignored)
│   └── policy_persona_project/  # Source profiles, interviews, dynamic events
├── server.js            # Express server with chat logic
├── personas.js          # Loads configs and builds each Persona system prompt
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
