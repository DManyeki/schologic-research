# Higher-Ed Institutional Profile Verification Console

A high-density dark research operations console designed first to triage and resolve institutional profiles left **unresolved** by a pre-existing Python verification script. Researchers import the Python pipeline's JSON or CSV output, isolate unresolved or flagged cases, dispatch a live AI-grounded research agent with the prior failure context, and review side-by-side diffs with source citations before exporting clean merged or delta datasets.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> Revised per your feedback: the primary workflow now centers on **resolving unresolved cases from your pre-existing Python verification run first**, rather than re-verifying already-clean records from scratch. Please confirm if this prioritization matches your pipeline output.

- **Confirmed Decision 1 (Unresolved-First Triage & Flexible Schema)**: Import JSON or CSV outputs from the Python verification script, map institutional attributes *plus* prior verification status/error columns (`status`, `unresolved_fields`, `error_note`, etc.), and automatically surface unresolved cases at the top of the queue.
- **Confirmed Decision 2 (Targeted Multi-Source Escalation)**: Feed the Python script's unresolved reason/context into a server-side Gemini agent equipped with live Google Search, official website/catalog URL inspection, and accreditation/government registry cross-checking to crack edge cases (e.g., blocked/JS-rendered sites, institution rebrands/mergers, branch campuses, or missing registry IDs).
- **Confirmed Decision 3 (Side-by-Side Diff & Delta/Merged Export)**: Review `Database Value` vs. `Prior Python Note` vs. `Agent-Verified Value` with per-field Approve, Keep, or Manual Edit controls, then export either the **full merged dataset** or a **delta patch of newly resolved records**.
- **Confirmed Decision 4 (Visual Aesthetic)**: High-density research operations console (dark) built with flat single-elevation surfaces, tabular numerals, and strict anti-clutter typography.

---

## 1. Overview & Core Concept

- **What It Does**: Acts as an interactive human-in-the-loop escalation workbench sitting directly downstream of your automated Python verification script. When the Python script leaves records unresolved (due to bot blocks, changed domains, institution mergers, ambiguous campus names, or missing registry matches), this console isolates those cases, lets the Gemini research agent investigate them using live web search and URL inspection, and presents verifiable diffs with clickable source URLs.
- **Target Audience / Persona**: Higher-education data researchers and database engineers resolving the "long tail" of difficult institutional profiles that deterministic Python scrapers/scripts could not settle automatically.
- **Key Value**: Avoids wasting time or API calls on already-verified records while turning cryptic Python script failures into cited, reviewable field resolutions.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Import Python Script Output & Map Unresolved Rules**:
   - Users drop/upload a `.json` or `.csv` file (or paste raw output) from the Python verification run, or click **Load Sample Python Output** to test with realistic unresolved higher-ed cases immediately.
   - In the **Schema & Unresolved Rules Mapper**, the console auto-detects columns/keys and lets the user designate:
     - **Institution Identifiers** (Name, Official URL, Country/State, Registry ID).
     - **Prior Python Verification Columns** (e.g., `verification_status`, `unresolved_fields`, `script_notes` / `failure_reason`).
     - **Unresolved Trigger Rule**: Choose which records enter the priority queue (e.g., records where prior status matches `unresolved`, `ambiguous`, `failed`, `timeout`, or any record with blank/null mapped fields).
     - **Target Attributes**: Toggle which institutional fields to verify and optionally attach field-level research instructions.
2. **Unresolved Queue & Targeted Escalation**:
   - The left Queue Rail defaults to the **Unresolved** filter (`Unresolved`, `In Review`, `Discrepancies`, `Resolved / Clean`, `All`) and shows each institution alongside the Python script's unresolved reason or count of unresolved fields.
   - Users can click **Investigate Case** on a single unresolved institution, run **Investigate Unresolved Queue** sequentially with Pause/Stop controls, or supply an optional **Researcher Hint** (e.g., *"Institution merged with State Tech in 2024"* or a candidate URL) and re-run a stubborn case.
3. **Side-by-Side Diff & Evidence Inspection**:
   - The main Diff Table displays every mapped field across 5 clear columns: `Field`, `Current Value`, `Python Script Note`, `Agent-Verified Value`, and `Status / Decision` (`Accept Verified`, `Keep Current`, `Edit Manually`).
   - Unresolved fields are surfaced first inside the institution diff view so researchers don't have to hunt through clean rows.
   - Clicking any field row opens the **Evidence & Citations Pane** on the right, showing why the prior value was flagged or unconfirmed, exact evidence quotes from official catalogs or accreditation registries, and clickable source links returned by Google Search and URL Context.
4. **Merged or Delta Export**:
   - Once unresolved cases are approved or edited, researchers click **Export Data** and choose:
     - **Full Merged Dataset (JSON / CSV)**: Original dataset with previously clean records preserved untouched and newly approved resolutions merged in place.
     - **Resolved Delta Only (JSON / CSV)**: Only the records/fields resolved in this session, ready to feed back into your Python pipeline or database patch script.
     - **Audit & Citations Log (JSON)**: Field-level provenance with timestamps, prior Python notes, and source URLs.

### Visual Identity & Theme

- **Aesthetic Direction**: High-density research operations console (dark mode) built for focused triage—utilitarian clarity, hairline borders, and zero decorative clutter.
- **Color Palette & Mood** (60-30-10 dark slate distribution):
  - *60% Dominant Neutral Canvas*: Deep obsidian slate (`#0B0F17`) for the main workspace background.
  - *30% Structural Surfaces*: Cool dark slate (`#111827` and `#161F30`) with subtle `1px solid #1F2937` hairline borders and zero nested box shadows.
  - *10% Semantic & Action Accents*: Crisp sky-blue (`#38BDF8`) / cobalt (`#2563EB`) strictly for primary actions and active selections; semantic states paired with explicit text labels and icons: Emerald (`#16A34A`) for `Verified / Approved`, Amber (`#D97706`) for `Unresolved / Discrepancy`, and Crimson (`#DC2626`) for `Conflict / Failed`.
- **Typography & Hierarchy** (2+1 font discipline):
  - *Display & Headings*: `Plus Jakarta Sans` (weights 600–700) with optical compensation for dark surfaces.
  - *Body & Dense UI*: `DM Sans` (13px–14px for table cells, prior script notes, and evidence prose).
  - *Data & Tabular Telemetry*: `JetBrains Mono` with `font-variant-numeric: tabular-nums` for counts, IDs, tuition/enrollment figures, timestamps, and diff values.
- **Component Styling & Layout**:
  - Top bar strictly follows the single-row 3-zone contract: concise wordmark on the left, concise workspace navigation (`Triage & Diff`, `Import & Schema`, `Export`) in the center, and primary action (`Export Data`) on the right.
  - Flat single-elevation surfaces, compact `40px` table rows, unboxed inline metadata with `·` separators (zero pill badges or status dots on static labels), and no fake telemetry tickers or arbitrary scores.
- **Interactive Feedback & States**:
  - Fast `150ms` hover and selection transitions.
  - Explicit Empty State (import dropzone + sample Python output loader), Skeleton Loading rows during active agent investigation, and inline Error Banners with retry actions.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Unresolved-First Queue Partitioning**
  - *Chosen Approach*: Partition imported records at load time using configurable Python status/null-field rules so unresolved records appear immediately in the active triage queue while previously verified records remain untouched unless explicitly re-queued.
  - *Why*: Matches the exact operational reality of rescuing stuck Python-script cases without redundant API calls or accidental overwrites of clean data.
  - *Alternatives Considered*: Treating every imported record as pending verification (rejected because it wastes time and quota on records the Python script already resolved).

- **Decision 2: Context-Aware Grounded Escalation (`gemini-4-hydrogen` + `googleSearch` + `urlContext`)**
  - *Chosen Approach*: An Express backend route (`/api/verify-institution`) invokes `@google/genai` with `gemini-4-hydrogen` using both `{ googleSearch: {} }` and `{ urlContext: {} }`, passing the institution's current fields, prior Python script status/error notes, and optional researcher hints.
  - *Why*: Knowing *why* the Python script failed (e.g., `HTTP 403`, `ambiguous campus`, `domain redirect`, `missing accreditor`) lets the agent target alternative official pages, institutional name changes, and government/accreditation registries directly, while returning real `groundingMetadata.groundingChunks` URLs.
  - *Alternatives Considered*: Generic single-shot verification without prior failure context (rejected because the agent would repeat the same dead-end assumptions as the Python script).

- **Decision 3: Non-Destructive Schema Preservation & Delta Export**
  - *Chosen Approach*: Keep the original raw JSON/CSV object intact inside each record envelope, overlay only approved/edited field resolutions, and offer both Full Merged and Delta-Only exports.
  - *Why*: Allows seamless round-tripping back into existing Python scripts and production databases without breaking custom column names or nested fields.
  - *Alternatives Considered*: Flattening or renaming fields into a fixed schema (rejected because it breaks downstream compatibility).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Browser Client (React + Tailwind CSS Dark Operations Console)             │
│                                                                           │
│  ┌──────────────────────┐   ┌──────────────────────────────────────────┐  │
│  │ Triage Store         │   │ Primary Views                            │  │
│  │ (React State +       │──▶│  1. Import & Python-Output Schema Mapper │  │
│  │  localStorage Sync)  │   │  2. Unresolved Queue Rail (Filter/Batch) │  │
│  │                      │   │  3. Side-by-Side Diff + Prior Note Table │  │
│  │ - rawRecords[]       │   │  4. Evidence, Citations & Hint Re-run    │  │
│  │ - unresolvedRules    │   │  5. Merged / Delta CSV & JSON Exporter   │  │
│  │ - resolutionsMap     │   └────────────────────┬─────────────────────┘  │
│  └──────────────────────┘                        │                        │
└──────────────────────────────────────────────────┼────────────────────────┘
                                                   │ POST /api/verify-institution
                                                   │ (Record + Unresolved Context + Hint)
┌──────────────────────────────────────────────────▼────────────────────────┐
│ Node.js / Express Server (Port 3000 + Vite Middleware)                    │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Escalation Research Agent                                           │  │
│  │ - Reads prior Python status/error & target unresolved fields        │  │
│  │ - Calls @google/genai (gemini-4-hydrogen)                           │  │
│  │   Tools: [{ googleSearch: {} }, { urlContext: {} }]                 │  │
│  │ - Handles name variants, mergers, official catalogs & registries    │  │
│  │ - Returns structured field diffs + groundingChunks source URLs      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **`InstitutionRecord`**: `id`, `rowIndex`, `raw: Record<string, unknown>`, `displayName`, `websiteUrl`, `priorPythonStatus` (`unresolved | ambiguous | error | verified | unknown`), `priorPythonNote: string`, `flaggedFields: string[]`, and `triageState` (`unresolved | investigating | needs_review | resolved | previously_clean | api_error`).
- **`SchemaConfig`**: Maps detected columns/keys to `role` (`identifier | url | location | accreditation | prior_status | prior_note | flagged_fields | attribute | ignore`), `unresolvedStatusValues: string[]`, `treatEmptyAsUnresolved: boolean`, and per-field `verifyEnabled` + `promptHint`.
- **`FieldVerificationResult`**: `fieldKey`, `originalValue`, `priorNote`, `verifiedValue`, `status` (`match | discrepancy | resolved_missing | still_unverified`), `confidence` (`high | medium | low`), `reasoning`, `evidenceSnippet`, `sourceUrls[]`, `decision` (`pending | accepted | kept_original | edited`), and `finalValue`.
- **`GroundSource`**: `{ title: string; uri: string; sourceType: 'official_site' | 'registry' | 'web_search' }` extracted from `groundingMetadata.groundingChunks` and `urlContextMetadata`.

### Interactive Component & State Mapping

- **Import & Schema Mapper**: Parses CSV/JSON into `InstitutionRecord[]`, detects prior Python status/note columns, and computes initial `unresolved` counts before entering the triage queue. **Load Sample Python Output** seeds realistic unresolved higher-ed records (e.g., bot-blocked `.edu` site, merged college name, missing accreditor ID, branch campus ambiguity) alongside clean baseline rows.
- **Unresolved Queue & Batch Runner**: Defaults to showing `Unresolved` records first, displays each record's prior Python failure note and unresolved field count, and provides **Investigate Case**, **Investigate Unresolved Queue** (sequential async runner with live progress and **Stop Queue** abort control), plus text search and status tabs.
- **Side-by-Side Diff & Re-investigation Controls**: Renders unresolved/flagged fields at the top of the diff table with `Accept`, `Keep`, and inline `Edit` buttons. Includes a per-record **Researcher Hint** input (e.g., alternate name, known domain, or specific question) to re-run just that institution when additional human context helps crack an edge case.
- **Exporter**: Supports **Full Merged Export** (`.json` / `.csv`), **Newly Resolved Delta Export** (`.json` / `.csv`), and **Audit & Citations Report** (`.json`) with complete source provenance.

### Key Sequences & Integrations

1. **SDK & Server Setup**: Upgrade `@google/genai` to latest (`>= 2.29.1`) to support `gemini-4-hydrogen` and modern grounding tools; run Express via `tsx server.ts` on port `3000` with `vite.middlewares` mounted in development.
2. **Context-Aware Grounded Verification**:
   - Server initializes `new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })`.
   - Prompt feeds the institution's current profile, any `priorPythonNote` / `flaggedFields`, and optional `researcherHint` into `gemini-4-hydrogen` with `googleSearch` and `urlContext`.
   - Agent explicitly checks for institutional rebrands/mergers, official university websites/catalogs, and national/regional accreditation & government registries (e.g., IPEDS/NCES, CHEA, recognized ministries), returning structured JSON field diffs alongside real `groundingChunks` URLs.
