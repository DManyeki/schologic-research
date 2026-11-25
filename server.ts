import "dotenv/config";
import dns from "dns/promises";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type {
  GroundSource,
  VerifyInstitutionRequest,
  VerifyInstitutionResponse,
} from "./src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));

const ALLOWED_MODELS = new Set([
  "gemini-4-hydrogen",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-4-neon",
  "gemini-4-carbon",
]);

interface ApiKeyCandidate {
  label: string;
  key: string;
}

function getApiKeyCandidates(): ApiKeyCandidate[] {
  const slots: Array<{ label: string; value: string | undefined }> = [
    { label: "gemini_api_key2", value: process.env.gemini_api_key2 },
    { label: "GEMINI_API_KEY2", value: process.env.GEMINI_API_KEY2 },
    { label: "GEMINI_API_KEY", value: process.env.GEMINI_API_KEY },
    { label: "gemini_api_key", value: process.env.gemini_api_key },
  ];
  const seen = new Set<string>();
  const out: ApiKeyCandidate[] = [];
  for (const s of slots) {
    const trimmed = s.value?.trim();
    if (
      trimmed &&
      trimmed !== "MY_GEMINI_API_KEY" &&
      !seen.has(trimmed)
    ) {
      seen.add(trimmed);
      out.push({ label: s.label, key: trimmed });
    }
  }
  return out;
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function normalizeHttpUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^(n\/a|none|null|unknown|-)$/i.test(trimmed)) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function classifySourceType(
  uri: string,
  officialHost: string | null
): GroundSource["sourceType"] {
  const lower = uri.toLowerCase();
  if (
    lower.includes(".gov") ||
    lower.includes(".go.") ||
    lower.includes("tveta") ||
    lower.includes("cue.or.ke") ||
    lower.includes("kuccps") ||
    lower.includes("nces.ed.gov") ||
    lower.includes("ipeds") ||
    lower.includes("chea.org") ||
    lower.includes("ope.ed.gov") ||
    lower.includes("hlcommission") ||
    lower.includes("sacscoc") ||
    lower.includes("msche.org") ||
    lower.includes("neche.org") ||
    lower.includes("nwccu.org") ||
    lower.includes("wscuc.org") ||
    lower.includes("qaa.ac.uk") ||
    lower.includes("teqsa.gov") ||
    lower.includes("unesco") ||
    lower.includes("whed.net")
  ) {
    return "registry";
  }
  if (officialHost && lower.includes(officialHost)) {
    return "official_site";
  }
  if (
    lower.includes(".edu") ||
    lower.includes(".ac.") ||
    lower.includes("catalog") ||
    lower.includes("factbook")
  ) {
    return "official_site";
  }
  return "web_search";
}

const redirectCache = new Map<string, string>();
const MAX_REDIRECT_CACHE = 2000;

function setRedirectCache(key: string, value: string) {
  if (redirectCache.size >= MAX_REDIRECT_CACHE) {
    const firstKey = redirectCache.keys().next().value;
    if (firstKey !== undefined) redirectCache.delete(firstKey);
  }
  redirectCache.set(key, value);
}

async function resolveFinalUrl(rawUri: string): Promise<string> {
  if (!rawUri || !/^https?:\/\//i.test(rawUri)) return rawUri;
  const isVertexRedirect =
    rawUri.includes("vertexaisearch.cloud.google.com/grounding-api-redirect") ||
    rawUri.includes("google.com/url?");
  if (!isVertexRedirect) return rawUri;

  const cached = redirectCache.get(rawUri);
  if (cached) return cached;

  let current = rawUri;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const resp = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(1800),
      });
      const loc = resp.headers.get("location");
      if (loc && resp.status >= 300 && resp.status < 400) {
        current = new URL(loc, current).toString();
        continue;
      }
      if (resp.status === 405 || resp.status === 403 || resp.status === 501) {
        const getResp = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(1800),
        });
        const getLoc = getResp.headers.get("location");
        await getResp.body?.cancel().catch(() => {});
        if (getLoc && getResp.status >= 300 && getResp.status < 400) {
          current = new URL(getLoc, current).toString();
          continue;
        }
      }
      break;
    }
  } catch {
    // Keep best resolved URL reached so far
  }

  setRedirectCache(rawUri, current);
  return current;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes("503") ||
        msg.includes("500") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("ETIMEDOUT");
      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastError;
}

interface JsonSchemaDoc {
  properties?: Record<string, Record<string, unknown>>;
  $defs?: Record<string, Record<string, unknown>>;
  allOf?: Array<{ description?: string; if?: unknown; then?: unknown; else?: unknown }>;
}

let cachedInstitutionsSchema: JsonSchemaDoc | null = null;
function getInstitutionsSchema(): JsonSchemaDoc | null {
  if (cachedInstitutionsSchema) return cachedInstitutionsSchema;
  try {
    const schemaPath = path.resolve(__dirname, "institutions.schema.json");
    if (fs.existsSync(schemaPath)) {
      cachedInstitutionsSchema = JSON.parse(
        fs.readFileSync(schemaPath, "utf8")
      ) as JsonSchemaDoc;
    }
  } catch (err) {
    console.warn("Could not load institutions.schema.json:", err);
  }
  return cachedInstitutionsSchema;
}

function stripPgNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPgNoise);
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "x-pg") {
      if (v && typeof v === "object") {
        const pg = v as Record<string, unknown>;
        if (typeof pg.pg_description === "string" && pg.pg_description) {
          out.pg_description = pg.pg_description;
        }
        if (Array.isArray(pg.constraints)) {
          const checkRules = pg.constraints.filter(
            (c): c is string => typeof c === "string" && c.startsWith("CHECK")
          );
          if (checkRules.length > 0) out.db_checks = checkRules;
        }
      }
      continue;
    }
    out[k] = stripPgNoise(v);
  }
  return out;
}

function collectReferencedDefs(
  node: unknown,
  allDefs: Record<string, Record<string, unknown>>,
  collected: Record<string, unknown>
) {
  if (Array.isArray(node)) {
    for (const item of node) collectReferencedDefs(item, allDefs, collected);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/$defs/")) {
    const defName = obj.$ref.slice("#/$defs/".length);
    if (!collected[defName] && allDefs[defName]) {
      const cleaned = stripPgNoise(allDefs[defName]);
      collected[defName] = cleaned;
      collectReferencedDefs(cleaned, allDefs, collected);
    }
  }
  for (const val of Object.values(obj)) {
    collectReferencedDefs(val, allDefs, collected);
  }
}

function buildTargetedSchemaSnippet(
  chunkFields: VerifyInstitutionRequest["targetFields"]
): string {
  const doc = getInstitutionsSchema();
  if (!doc?.properties) return "";

  const matchedColumns: Record<string, unknown> = {};
  const matchedDefs: Record<string, unknown> = {};
  const chunkKeySet = new Set<string>();

  for (const f of chunkFields) {
    const rawKey = f.key.trim();
    const shortKey = rawKey.split(".").pop() ?? rawKey;
    const schemaKey = doc.properties[rawKey]
      ? rawKey
      : doc.properties[shortKey]
      ? shortKey
      : Object.keys(doc.properties).find(
          (k) => k.toLowerCase() === shortKey.toLowerCase()
        );
    if (!schemaKey) continue;
    chunkKeySet.add(schemaKey);
    const cleanedProp = stripPgNoise(doc.properties[schemaKey]);
    matchedColumns[schemaKey] = cleanedProp;
    if (doc.$defs) {
      collectReferencedDefs(cleanedProp, doc.$defs, matchedDefs);
    }
  }

  if (Object.keys(matchedColumns).length === 0) return "";

  const crossRules: string[] = [];
  if (chunkKeySet.has("category") || chunkKeySet.has("type")) {
    crossRules.push(
      "Category is required (NP|TVC|VTC) when type is TVET and must be null for UNIVERSITY/KMTC."
    );
  }
  if (chunkKeySet.has("location") && chunkKeySet.has("county")) {
    crossRules.push(
      "location must be a specific street/road/building/address and must NOT duplicate county."
    );
  }

  const payload: Record<string, unknown> = {
    columns: matchedColumns,
    ...(Object.keys(matchedDefs).length > 0 ? { $defs: matchedDefs } : {}),
    ...(crossRules.length > 0 ? { cross_column_rules: crossRules } : {}),
  };

  return JSON.stringify(payload, null, 2);
}

function buildTargetedFieldGuidance(
  chunkFields: VerifyInstitutionRequest["targetFields"]
): string {
  const keys = new Set(
    chunkFields.map((f) => (f.key.split(".").pop() ?? f.key).trim().toLowerCase())
  );
  const hasUrlRole = chunkFields.some((f) => f.role === "url");
  const lines: string[] = [];

  if (keys.has("website") || hasUrlRole) {
    lines.push(
      `- WEBSITE & FACEBOOK FALLBACK RULE: First search thoroughly for the institution's active standalone official website domain (format: uri). If—and only if—no active standalone official website exists (or the current URL belongs to a third-party directory or dead domain), locate the institution's official Facebook page URL (e.g. https://www.facebook.com/<handle>, https://www.facebook.com/people/..., https://www.facebook.com/profile.php?id=..., or https://web.facebook.com/...) and return that canonical Facebook URL as "verifiedValue" (status "resolved_missing" if DB was empty, or "discrepancy" if updating an old/dead URL). IMPORTANT: If a prior verdict says "Null corroborated" or "no website found", note that the prior pipeline ONLY checked standalone domains and did NOT accept Facebook pages—do NOT copy a prior negative verdict when a real official Facebook page exists.`
    );
  }

  if (keys.has("has_elearning") || keys.has("has_distance_learning")) {
    lines.push(
      `- LEARNING MODE TUPLE RULE (has_elearning / has_distance_learning): "verifiedValue" MUST be a 2-element JSON array string conforming strictly to $defs.learning_mode_tuple: ["verified" | "implied" | "none", "<reasoning>"].
  * Element 0 MUST be strictly lowercase "verified", "implied", or "none":
    - "verified": Confirmed active LMS, e-learning portal, or ODeL platform URL found — Element 1 ("reasoning") MUST include that valid https://... URL!
    - "implied": Official website, prospectus, brochure, or directory explicitly mentions online learning, e-learning, virtual/blended classes, or distance/ODeL programmes without a dedicated portal URL — Element 1 explains the evidence & source.
    - "none": No evidence of e-learning / ODeL / distance learning found in checked sources — Element 1 states what was checked.
  * Element 1 MUST be a non-empty explanation string. Never return plain "true", "false", or bare text outside the 2-element JSON array.`
    );
  }

  if (keys.has("has_teaching_courses")) {
    lines.push(
      `- HAS_TEACHING_COURSES TUPLE RULE: "verifiedValue" MUST be a JSON array starting with a boolean flag, e.g. [true, ["Course 1", "Course 2"]] or [false].`
    );
  }

  if (keys.has("location")) {
    lines.push(
      `- LOCATION RULE: Return specific physical street, road, building, landmark, or P.O. Box address. It MUST NOT simply repeat the county name.`
    );
  }

  if (keys.has("phone")) {
    lines.push(
      `- PHONE RULE: Must be an unmasked phone number without asterisks (*) (pattern: ^[^*]*$).`
    );
  }

  if (keys.has("category")) {
    lines.push(
      `- CATEGORY RULE: Must be "NP", "TVC", or "VTC" when type is "TVET"; must be empty/null for "UNIVERSITY" or "KMTC".`
    );
  }

  if (keys.has("courses")) {
    lines.push(
      `- COURSES RULE: Return a JSON array of objects matching $defs.course_item: { "name": string, "level": one of Certificate|Diploma|Higher Diploma|Degree|Masters|PhD|Artisan|Undergraduate|Postgraduate, "exam_body": e.g. KNEC|NITA|TVET CDACC|KASNEB|NCK|internal }.`
    );
  }

  if (keys.has("facilities") || keys.has("accreditations") || keys.has("campuses") || keys.has("affiliation")) {
    lines.push(
      `- ARRAY ATTRIBUTE RULE (facilities/accreditations/campuses/affiliation): Return a JSON array of concise strings (respecting maxLength: 160 for facilities, 320 for accreditations).`
    );
  }

  if (keys.has("about") || keys.has("description")) {
    lines.push(
      `- NARRATIVE LENGTH RULE: "about" requires at least 25 words; "description" requires at least 4 full sentences.`
    );
  }

  return lines.join("\n");
}

function isFacebookUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.|web\.|m\.|mbasic\.)?(?:facebook\.com|fb\.com)\//i.test(
    url
  );
}

function isUsableFacebookPageUrl(url: string): boolean {
  if (!isFacebookUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const p = parsed.pathname.toLowerCase();
    if (
      p === "/" ||
      p.startsWith("/login") ||
      p.startsWith("/sharer") ||
      p.startsWith("/share") ||
      p.startsWith("/dialog") ||
      p.startsWith("/policies") ||
      p.startsWith("/help") ||
      p.startsWith("/privacy") ||
      p.startsWith("/watch") ||
      p.startsWith("/reel") ||
      p.startsWith("/events") ||
      p.startsWith("/hashtag")
    ) {
      return false;
    }
    if (p === "/profile.php") {
      return Boolean(parsed.searchParams.get("id"));
    }
    return p.length > 2;
  } catch {
    return false;
  }
}

function canonicalizeFacebookUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hostname = "www.facebook.com";
    u.protocol = "https:";
    for (const param of ["mibextid", "ref", "paipv", "eav", "_rdr", "fbclid"]) {
      u.searchParams.delete(param);
    }
    if (u.pathname.toLowerCase() !== "/profile.php") {
      u.search = "";
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

async function probeUrlLive(
  rawUrl: string
): Promise<{ ok: boolean; finalUrl: string; title: string; fbLinks: string[] }> {
  const isFb = isFacebookUrl(rawUrl);
  const ua = isFb
    ? "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  try {
    const resp = await fetch(rawUrl, {
      method: "GET",
      headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(4500),
    });
    const finalUrl = resp.url || rawUrl;
    const html = await resp.text();
    const ogTitle =
      (html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ??
        html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i))?.[1] ??
      "";
    const titleTag =
      (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "").trim();
    const title = (ogTitle || titleTag).replace(/\s+/g, " ").trim();

    const fbLinks = isFb
      ? []
      : Array.from(
          new Set(
            [
              ...html.matchAll(
                /https?:\/\/(?:www\.|web\.|m\.)?(?:facebook\.com|fb\.com)\/[A-Za-z0-9._\-\/?=&%]+/gi
              ),
            ]
              .map((m) => m[0].replace(/[),.;'"]+$/, ""))
              .filter(isUsableFacebookPageUrl)
              .map(canonicalizeFacebookUrl)
          )
        ).slice(0, 5);

    const loginWall =
      isFb &&
      (finalUrl.includes("/login") ||
        /^log in or sign up/i.test(title) ||
        title.toLowerCase() === "facebook" ||
        title.toLowerCase() === "error");

    return {
      ok: resp.status >= 200 && resp.status < 400 && !loginWall,
      finalUrl: isFb ? canonicalizeFacebookUrl(finalUrl) : finalUrl,
      title,
      fbLinks,
    };
  } catch {
    return { ok: false, finalUrl: rawUrl, title: "", fbLinks: [] };
  }
}

async function discoverWebsiteAndFacebookCandidates(params: {
  ai: GoogleGenAI;
  model: string;
  institutionName: string;
  locationLabel: string;
  institutionContext?: Record<string, string>;
  researcherHint?: string;
  signal: AbortSignal;
}): Promise<{
  notes: string;
  candidateList: Array<{ url: string; title: string; kind: "facebook" | "official" | "directory" }>;
  groundedSources: GroundSource[];
}> {
  const ctxSummary = params.institutionContext
    ? Object.entries(params.institutionContext)
        .filter(([, v]) => v && v.trim() !== "")
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")
    : "";

  const discoveryPrompt = `Perform targeted live Google searches to find the official web presence for this higher-education / TVET institution.

Institution: ${params.institutionName}
Location: ${params.locationLabel || "(not provided)"}
${ctxSummary}
${params.researcherHint ? `Researcher note: ${params.researcherHint}` : ""}

Run searches specifically covering BOTH:
1. Standalone official website domain (e.g. .ac.ke, .edu, .org, .co.ke) belonging directly to "${params.institutionName}" (check any alternate names mentioned in about_summary).
2. Official Facebook page URL on facebook.com / web.facebook.com (search "${params.institutionName}" facebook, site:facebook.com "${params.institutionName}", "${params.institutionName}" ${params.institutionContext?.town || ""} facebook, and any TVET/VTC name variants).
3. Kenyan college directory listings (tvetnearme.com, yibuka.com, kenyaplex.com, teacher.co.ke, institutiontoday.com, yellowpageskenya.com) that may link to its website or Facebook page.

List every relevant URL you find with a 1-line note about what each URL belongs to.`;

  let rawText = "";
  const rawChunks: Array<{ uri: string; title: string }> = [];

  try {
    const resp = await withRetry(() =>
      params.ai.models.generateContent({
        model: params.model,
        contents: discoveryPrompt,
        config: {
          abortSignal: params.signal,
          tools: [{ googleSearch: {} }],
        },
      })
    );
    rawText = (resp.text ?? "").trim();
    const cand = resp.candidates?.[0] as
      | {
          groundingMetadata?: {
            groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
          };
        }
      | undefined;
    for (const ch of cand?.groundingMetadata?.groundingChunks ?? []) {
      if (ch.web?.uri && /^https?:\/\//i.test(ch.web.uri)) {
        rawChunks.push({ uri: ch.web.uri, title: ch.web.title || "" });
      }
    }
  } catch {
    // Non-fatal; continue with context-extracted URLs
  }

  const textUrls = Array.from(
    new Set(rawText.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [])
  ).map((u) => u.replace(/[.,;:]+$/, ""));

  const ctxUrls: string[] = [];
  if (params.institutionContext?.known_social_media) {
    ctxUrls.push(
      ...(params.institutionContext.known_social_media.match(
        /https?:\/\/[^\s"'<>)\]]+/gi
      ) ?? [])
    );
  }
  if (params.institutionContext?.known_row_sources) {
    ctxUrls.push(
      ...(params.institutionContext.known_row_sources.match(
        /https?:\/\/[^\s"'<>)\]]+/gi
      ) ?? [])
    );
  }

  const allRawUrls = Array.from(
    new Set([...rawChunks.map((c) => c.uri), ...textUrls, ...ctxUrls])
  );

  const resolvedPairs = await Promise.all(
    allRawUrls.slice(0, 18).map(async (u) => ({
      raw: u,
      final: await resolveFinalUrl(u),
    }))
  );

  const chunkTitleByFinal = new Map<string, string>();
  for (const ch of rawChunks) {
    const match = resolvedPairs.find((p) => p.raw === ch.uri);
    const finalU = match?.final ?? ch.uri;
    if (ch.title) chunkTitleByFinal.set(finalU, ch.title);
  }

  const uniqueFinalUrls = Array.from(new Set(resolvedPairs.map((p) => p.final)));
  const fbCandidates = new Set<string>(
    uniqueFinalUrls.filter(isUsableFacebookPageUrl).map(canonicalizeFacebookUrl)
  );

  const directoryUrlsToScan = uniqueFinalUrls
    .filter((u) => !isFacebookUrl(u) && !u.includes("maps.google.com") && !u.includes("tveta.go.ke"))
    .slice(0, 4);

  const probedDirs = await Promise.all(
    directoryUrlsToScan.map(async (u) => ({ url: u, res: await probeUrlLive(u) }))
  );

  for (const d of probedDirs) {
    for (const fb of d.res.fbLinks) {
      fbCandidates.add(fb);
    }
  }

  const verifiedFbs = await Promise.all(
    Array.from(fbCandidates)
      .slice(0, 5)
      .map(async (fbUrl) => ({ url: fbUrl, probe: await probeUrlLive(fbUrl) }))
  );

  const candidateList: Array<{
    url: string;
    title: string;
    kind: "facebook" | "official" | "directory";
  }> = [];
  const groundedSources: GroundSource[] = [];

  for (const item of verifiedFbs) {
    if (item.probe.ok) {
      const url = item.probe.finalUrl || item.url;
      const title = item.probe.title || "Facebook Page";
      candidateList.push({ url, title, kind: "facebook" });
      groundedSources.push({ uri: url, title, sourceType: "web_search" });
    }
  }

  for (const d of probedDirs) {
    if (d.res.ok) {
      const title = d.res.title || chunkTitleByFinal.get(d.url) || d.url;
      const lower = d.url.toLowerCase();
      const isDir =
        lower.includes("tvetnearme") ||
        lower.includes("yibuka") ||
        lower.includes("kenyaplex") ||
        lower.includes("teacher.co.ke") ||
        lower.includes("institutiontoday") ||
        lower.includes("yellowpages") ||
        lower.includes("cybo") ||
        lower.includes("newsblaze");
      candidateList.push({
        url: d.res.finalUrl || d.url,
        title,
        kind: isDir ? "directory" : "official",
      });
      groundedSources.push({
        uri: d.res.finalUrl || d.url,
        title,
        sourceType: isDir ? "web_search" : "official_site",
      });
    }
  }

  return {
    notes: rawText.slice(0, 1800),
    candidateList,
    groundedSources,
  };
}

app.get("/api/workspace-dataset", (_req, res) => {
  const csvPath = path.resolve(__dirname, "institutions.csv");
  if (!fs.existsSync(csvPath)) {
    res.status(404).json({ error: "No institutions.csv found in workspace root." });
    return;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  fs.createReadStream(csvPath).pipe(res);
});

app.get("/api/config-status", (_req, res) => {
  const candidates = getApiKeyCandidates();
  res.json({
    hasKey: candidates.length > 0,
    activeKeySlot: candidates[0]?.label ?? "none",
    availableKeyCount: candidates.length,
    defaultModel: "gemini-3.5-flash-lite",
  });
});

app.get("/api/models", async (_req, res) => {
  const candidates = getApiKeyCandidates();
  if (candidates.length === 0) {
    res.status(401).json({ error: "No API key configured." });
    return;
  }
  try {
    const ai = createGeminiClient(candidates[0].key);
    const pager = await ai.models.list();
    const models: Array<{ name: string; displayName?: string }> = [];
    for await (const m of pager) {
      if (m.name) {
        models.push({
          name: m.name.replace(/^models\//, ""),
          displayName: m.displayName,
        });
      }
    }
    res.json({ models });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list models",
    });
  }
});

app.post("/api/verify-institution", async (req, res) => {
  const requestAbort = new AbortController();
  const overallTimer = setTimeout(() => requestAbort.abort(), 90000);
  res.on("close", () => {
    if (!res.writableEnded) {
      requestAbort.abort();
    }
  });
  try {
    const body = req.body as VerifyInstitutionRequest;
    if (!body || !body.institutionName || !Array.isArray(body.targetFields)) {
      res.status(400).json({
        error:
          "Invalid request payload. institutionName and targetFields are required.",
      });
      return;
    }

    if (body.targetFields.length === 0) {
      res.status(400).json({
        error:
          "At least one verifiable field must be selected or enabled for verification.",
      });
      return;
    }

    const candidates = getApiKeyCandidates();
    if (candidates.length === 0) {
      res.status(401).json({
        error:
          "GEMINI_API_KEY is not configured. Please set it in Settings > Secrets.",
      });
      return;
    }

    const selectedModel =
      body.model && ALLOWED_MODELS.has(body.model)
        ? body.model
        : "gemini-3.5-flash-lite";

    const validWebsite = normalizeHttpUrl(body.websiteUrl || "");
    const officialHost = validWebsite
      ? new URL(validWebsite).hostname.replace(/^www\./, "").toLowerCase()
      : null;

    const capabilities = body.capabilities ?? {
      webSearch: true,
      officialSite: true,
      registryCheck: true,
    };

    // Fast DNS check so dead/NXDOMAIN candidate websites do not stall Gemini urlContext
    let canUseUrlContext = Boolean(capabilities.officialSite && validWebsite);
    if (canUseUrlContext && validWebsite) {
      try {
        const hostname = new URL(validWebsite).hostname;
        await Promise.race([
          dns.lookup(hostname),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("dns timeout")), 600)
          ),
        ]);
      } catch {
        canUseUrlContext = false;
      }
    }

    const extraContextLines = body.institutionContext
      ? Object.entries(body.institutionContext)
          .filter(([, v]) => v && v.trim() !== "")
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")
      : "";

    const CHUNK_SIZE = 8;
    const fieldChunks: Array<VerifyInstitutionRequest["targetFields"]> = [];
    for (let i = 0; i < body.targetFields.length; i += CHUNK_SIZE) {
      fieldChunks.push(body.targetFields.slice(i, i + CHUNK_SIZE));
    }

    // Dedicated live Web + Facebook discovery pass when verifying website/URL with missing, dead, or flagged URL
    const needsWebsiteDiscovery =
      Boolean(capabilities.webSearch) &&
      body.targetFields.some(
        (f) =>
          (f.key.toLowerCase() === "website" || f.role === "url") &&
          (!canUseUrlContext || !validWebsite || f.isFlagged)
      );

    let discoveryContextBlock = "";
    let discoveryGroundedSources: GroundSource[] = [];
    if (needsWebsiteDiscovery && candidates.length > 0) {
      for (let i = 0; i < candidates.length; i++) {
        try {
          const discoveryAi = createGeminiClient(candidates[i].key);
          const discAbort = new AbortController();
          const onParentAbort = () => discAbort.abort();
          requestAbort.signal.addEventListener("abort", onParentAbort, {
            once: true,
          });
          const discTimer = setTimeout(() => discAbort.abort(), 16000);
          try {
            const disc = await discoverWebsiteAndFacebookCandidates({
              ai: discoveryAi,
              model: selectedModel,
              institutionName: body.institutionName,
              locationLabel: body.locationLabel,
              institutionContext: body.institutionContext,
              researcherHint: body.researcherHint,
              signal: discAbort.signal,
            });
            discoveryGroundedSources = disc.groundedSources;
            if (disc.candidateList.length > 0 || disc.notes) {
              const candidateLines = disc.candidateList
                .map(
                  (c) =>
                    `  - [${c.kind.toUpperCase()}] ${c.url} (Live page title: ${JSON.stringify(c.title)})`
                )
                .join("\n");
              discoveryContextBlock = `\nLIVE WEB & FACEBOOK DISCOVERY RESULTS:\n${
                candidateLines || "  (No live URLs probed)"
              }${disc.notes ? `\nDiscovery search notes:\n${disc.notes}` : ""}\n`;
            }
            break;
          } finally {
            clearTimeout(discTimer);
            requestAbort.signal.removeEventListener("abort", onParentAbort);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isKeyErr =
            msg.includes("403") ||
            msg.includes("PERMISSION_DENIED") ||
            msg.includes("RESOURCE_EXHAUSTED");
          if (!isKeyErr || i === candidates.length - 1) {
            break;
          }
        }
      }
    }

    const executeFieldChunk = async (
      chunkFields: VerifyInstitutionRequest["targetFields"]
    ) => {
      const targetedSchemaJson = buildTargetedSchemaSnippet(chunkFields);
      const targetedFieldGuidance = buildTargetedFieldGuidance(chunkFields);
      const hasWebsiteInChunk = chunkFields.some(
        (f) => f.key.toLowerCase() === "website" || f.role === "url"
      );

      const fieldPromptBlock = chunkFields
        .map((f, idx) => {
          const flagNote = f.isFlagged
            ? " [NEEDS VERIFICATION / FLAGGED IN TARGET_FIELDS]"
            : "";
          const priorVerdictNote = f.priorVerdictStatus
            ? ` | Prior verdict: ${f.priorVerdictStatus}${
                f.priorVerdictRationale ? ` (${f.priorVerdictRationale})` : ""
              }`
            : "";
          const hintNote = f.promptHint
            ? ` | Verification hint: ${f.promptHint}`
            : "";
          const isClipped = Boolean(f.currentValue && f.currentValue.length > 4500);
          const clippedValue = isClipped
            ? `${f.currentValue.slice(0, 4500)}... [truncated from ${f.currentValue.length} chars; if status is "match", set verifiedValue to "__MATCH_EXISTING__"]`
            : f.currentValue || "(empty)";
          return `${idx + 1}. key="${f.key}" (role=${f.role})${flagNote}${priorVerdictNote}${hintNote}\n   Current DB value: ${JSON.stringify(clippedValue)}`;
        })
        .join("\n");

      const prompt = `Investigate and verify the following higher-education / TVET institution profile. Focus specifically on resolving ALL requested target fields accurately without omitting any field.

INSTITUTION CONTEXT:
- Name in database: ${body.institutionName}
- Location in database: ${body.locationLabel || "(not provided)"}
- Candidate official URL: ${validWebsite || body.websiteUrl || "(not provided)"}
${extraContextLines}
- Prior pipeline status: ${body.priorStatus || "flagged"}
- Prior pipeline note: ${body.priorNote || "(none provided)"}
- Target fields in this batch (${chunkFields.length}): ${chunkFields.map((t) => t.key).join(", ")}
${
  body.researcherHint && body.researcherHint.trim()
    ? `
HUMAN RESEARCHER RE-INVESTIGATION COMMENT (HIGH PRIORITY):
${JSON.stringify(body.researcherHint.trim())}
Follow this specific instruction closely when investigating and formatting "verifiedValue" for the requested target field(s) (for example, extract specific individual names, towns, or campus details rather than leaving vague summaries like "others unnamed" if requested and supported by sources).`
    : ""
}
${hasWebsiteInChunk && discoveryContextBlock ? discoveryContextBlock : ""}
INVESTIGATION OBJECTIVES:
${
  capabilities.officialSite
    ? `- Inspect the official institution website (${validWebsite || "discover official domain via search"}) and official about/academics/contact/facilities pages.`
    : ""
}
${
  capabilities.registryCheck
    ? "- Cross-check official government and accreditation registries (e.g., TVETA, KUCCPS, CUE, NCES/IPEDS, DAPIP, CHEA, or national higher-ed/TVET directories matching the institution's region)."
    : ""
}
${
  capabilities.webSearch
    ? "- Search for authoritative institutional directories, campus listings, official social/registry profiles, or domain changes that resolve why the prior run could not confirm these target fields."
    : ""
}
${targetedFieldGuidance ? `\nTARGETED COLUMN RULES & CONSTRAINTS:\n${targetedFieldGuidance}` : ""}
${
  targetedSchemaJson
    ? `\nDATABASE SCHEMA FOR THIS BATCH ONLY (output MUST conform strictly to these column definitions):\n\`\`\`json\n${targetedSchemaJson}\n\`\`\``
    : ""
}

TARGET FIELDS TO VERIFY:
${fieldPromptBlock}

OUTPUT INSTRUCTIONS:
Return strict JSON matching the schema. You MUST return an entry in "fields" for EVERY SINGLE key listed above (${chunkFields.map((t) => t.key).join(", ")}):
- "fieldKey": Exact key string from TARGET FIELDS TO VERIFY.
- "status":
  - "match": Verified current DB value is accurate, schema-compliant, and complete.
  - "discrepancy": Verified authoritative value differs from current DB value (e.g., new website URL or Facebook fallback URL, corrected address/town, updated logo URL, revised learning mode tuple, or revised facilities/courses list).
  - "resolved_missing": Current DB value was empty/missing/[] and you found the authoritative value (including an official Facebook page fallback when no standalone website exists).
  - "still_unverified": Could not find reliable authoritative evidence even after live search & registry checks (do NOT guess or fabricate; explain honestly in reasoning).
- "verifiedValue": The exact verified value to store in the database, conforming to the column schema above. Preserve JSON format for JSON/array columns (e.g. '["implied","..."]' for has_elearning/has_distance_learning, or '["Workshop 1","Computer Lab"]' for facilities/campuses/accreditations), or clean string for website/logo_url/location/email/phone. If status is "match" on a long/truncated field, return "__MATCH_EXISTING__". If "still_unverified", return empty string or "__MATCH_EXISTING__".
- "reasoning": 1-3 crisp sentences explaining what you checked and why it matches, differs, or remains unverified (directly addressing the prior verdict rationale when present).
- "evidenceSnippet": Direct factual quote or observation from the authoritative source.
- "sourceUrls": Array of exact URLs supporting this specific field.`;

      const runWithCandidate = async (
        candidate: ApiKeyCandidate,
        useUrlContext: boolean
      ) => {
        const ai = createGeminiClient(candidate.key);
        const chunkTools: Array<Record<string, unknown>> = [];
        if (capabilities.webSearch || capabilities.registryCheck) {
          chunkTools.push({ googleSearch: {} });
        }
        if (useUrlContext && canUseUrlContext) {
          chunkTools.push({ urlContext: {} });
        }

        const chunkAbort = new AbortController();
        const onParentAbort = () => chunkAbort.abort();
        requestAbort.signal.addEventListener("abort", onParentAbort, {
          once: true,
        });
        const chunkTimer = setTimeout(() => chunkAbort.abort(), 45000);

        try {
          return await withRetry(() =>
            ai.models.generateContent({
              model: selectedModel,
              contents: prompt,
              config: {
                abortSignal: chunkAbort.signal,
                systemInstruction:
                  "You are a senior higher-education and TVET institutional data verification researcher. Never fabricate URLs, logo links, facilities, registration IDs, or statistics. Rely strictly on live web search, official university/college websites, official social pages when no standalone site exists, and national accreditation/government registries. Always return valid JSON covering every requested target field.",
                ...(selectedModel.startsWith("gemini-4-")
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } }
                  : {}),
                tools: chunkTools.length > 0 ? chunkTools : undefined,
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    discoveredOfficialUrl: {
                      type: Type.STRING,
                      description:
                        "The verified canonical official website URL (or official Facebook page URL if no standalone website exists), or empty string if unknown.",
                    },
                    executiveSummary: {
                      type: Type.STRING,
                      description:
                        "2-3 sentence summary explaining what was verified or updated for the flagged target fields.",
                    },
                    fields: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          fieldKey: { type: Type.STRING },
                          verifiedValue: { type: Type.STRING },
                          status: {
                            type: Type.STRING,
                            description:
                              "One of: match, discrepancy, resolved_missing, still_unverified",
                          },
                          confidence: {
                            type: Type.STRING,
                            description: "One of: high, medium, low",
                          },
                          reasoning: { type: Type.STRING },
                          evidenceSnippet: { type: Type.STRING },
                          sourceUrls: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                        },
                        required: [
                          "fieldKey",
                          "verifiedValue",
                          "status",
                          "confidence",
                          "reasoning",
                          "evidenceSnippet",
                          "sourceUrls",
                        ],
                      },
                    },
                  },
                  required: ["discoveredOfficialUrl", "executiveSummary", "fields"],
                },
              },
            })
          );
        } finally {
          clearTimeout(chunkTimer);
          requestAbort.signal.removeEventListener("abort", onParentAbort);
        }
      };

      const executeWithUrlContextFallback = async (
        candidate: ApiKeyCandidate
      ) => {
        const hasUrlCtx = canUseUrlContext;
        try {
          return await runWithCandidate(candidate, hasUrlCtx);
        } catch (err) {
          if (requestAbort.signal.aborted || !hasUrlCtx) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeoutOrUrlErr =
            msg.includes("AbortError") ||
            msg.includes("aborted") ||
            msg.includes("DEADLINE_EXCEEDED") ||
            msg.includes("URL") ||
            msg.includes("timeout");
          if (!isTimeoutOrUrlErr) {
            throw err;
          }
          // Retry quickly with Google Search only when candidate website stalls urlContext
          return await runWithCandidate(candidate, false);
        }
      };

      let response;
      let lastCandidateError: unknown;
      for (let i = 0; i < candidates.length; i++) {
        try {
          response = await executeWithUrlContextFallback(candidates[i]);
          break;
        } catch (err) {
          lastCandidateError = err;
          if (requestAbort.signal.aborted) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const isKeyOrPermError =
            msg.includes("403") ||
            msg.includes("PERMISSION_DENIED") ||
            msg.includes("API_KEY_INVALID") ||
            msg.includes("API key not valid") ||
            msg.includes("RESOURCE_EXHAUSTED");
          if (!isKeyOrPermError || i === candidates.length - 1) {
            throw err;
          }
        }
      }
      if (!response) {
        throw lastCandidateError ?? new Error("Verification failed.");
      }

      const candidate = response.candidates?.[0] as
        | {
            finishReason?: string;
            groundingMetadata?: {
              groundingChunks?: Array<{
                web?: { uri?: string; title?: string };
              }>;
            };
            urlContextMetadata?: {
              urlMetadata?: Array<{
                retrievedUrl?: string;
                urlRetrievalStatus?: string;
              }>;
            };
          }
        | undefined;

      const finishReason = candidate?.finishReason;
      const rawText = (response.text ?? "").trim();
      if (!rawText) {
        throw new Error(
          `Model returned an empty response for batch (${chunkFields.map((f) => f.key).join(", ")})${
            finishReason ? ` [finishReason: ${finishReason}]` : ""
          }.`
        );
      }

      const cleanedJson = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      let parsed: {
        discoveredOfficialUrl?: string;
        executiveSummary?: string;
        fields?: VerifyInstitutionResponse["fields"];
      };
      try {
        parsed = JSON.parse(cleanedJson);
      } catch {
        throw new Error(
          `Failed to parse structured JSON for batch (${chunkFields.map((f) => f.key).join(", ")})${
            finishReason ? ` [finishReason: ${finishReason}]` : ""
          }. Try fewer fields or a stronger model.`
        );
      }

      return { parsed, candidate, chunkFields };
    };

    const sourceMap = new Map<string, GroundSource>();
    for (const dSrc of discoveryGroundedSources) {
      if (dSrc.uri && !sourceMap.has(dSrc.uri)) {
        sourceMap.set(dSrc.uri, dSrc);
      }
    }
    const rawToFinalUrlMap = new Map<string, string>();
    const allNormalizedFields: VerifyInstitutionResponse["fields"] = [];
    const summaryParts: string[] = [];
    let discoveredOfficialUrl = "";
    const warnings: string[] = [];

    // Execute chunks with concurrency up to 2 so multi-chunk requests complete rapidly
    const CONCURRENCY = 2;
    const chunkOutcomes: Array<
      | {
          status: "fulfilled";
          value: Awaited<ReturnType<typeof executeFieldChunk>>;
        }
      | { status: "rejected"; reason: unknown; keys: string[] }
    > = [];

    for (let i = 0; i < fieldChunks.length; i += CONCURRENCY) {
      if (requestAbort.signal.aborted) break;
      const slice = fieldChunks.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        slice.map(async (cf) => {
          try {
            const val = await executeFieldChunk(cf);
            return { status: "fulfilled" as const, value: val };
          } catch (err) {
            return {
              status: "rejected" as const,
              reason: err,
              keys: cf.map((f) => f.key),
            };
          }
        })
      );
      chunkOutcomes.push(...settled);
    }

    const fulfilledChunks = chunkOutcomes.filter(
      (o): o is Extract<typeof o, { status: "fulfilled" }> =>
        o.status === "fulfilled"
    );
    const rejectedChunks = chunkOutcomes.filter(
      (o): o is Extract<typeof o, { status: "rejected" }> =>
        o.status === "rejected"
    );

    if (fulfilledChunks.length === 0 && rejectedChunks.length > 0) {
      throw rejectedChunks[0].reason;
    }

    for (const rej of rejectedChunks) {
      const msg =
        rej.reason instanceof Error ? rej.reason.message : String(rej.reason);
      warnings.push(
        `Batch (${rej.keys.join(", ")}) failed: ${msg}`
      );
    }

    for (const outcome of fulfilledChunks) {
      const { parsed, candidate, chunkFields } = outcome.value;

      if (!discoveredOfficialUrl && parsed.discoveredOfficialUrl) {
        discoveredOfficialUrl = String(parsed.discoveredOfficialUrl).trim();
      }
      if (parsed.executiveSummary) {
        summaryParts.push(String(parsed.executiveSummary).trim());
      }

      const groundingChunks =
        candidate?.groundingMetadata?.groundingChunks ?? [];
      const urlMeta = candidate?.urlContextMetadata?.urlMetadata ?? [];

      const rawUrlSet = new Set<string>();
      const chunkTitleMap = new Map<string, string>();
      for (const chunk of groundingChunks) {
        const u = chunk.web?.uri ?? "";
        if (u && /^https?:\/\//i.test(u)) {
          rawUrlSet.add(u);
          if (chunk.web?.title) chunkTitleMap.set(u, chunk.web.title);
        }
      }
      for (const entry of urlMeta) {
        const u = entry.retrievedUrl ?? "";
        if (u && /^https?:\/\//i.test(u)) {
          rawUrlSet.add(u);
        }
      }
      for (const f of parsed.fields ?? []) {
        if (Array.isArray(f.sourceUrls)) {
          for (const u of f.sourceUrls) {
            if (typeof u === "string" && /^https?:\/\//i.test(u)) {
              rawUrlSet.add(u);
            }
          }
        }
      }

      await Promise.all(
        Array.from(rawUrlSet).map(async (rawUri) => {
          if (!rawToFinalUrlMap.has(rawUri)) {
            const finalUri = await resolveFinalUrl(rawUri);
            rawToFinalUrlMap.set(rawUri, finalUri);
          }
        })
      );

      for (const chunk of groundingChunks) {
        const rawUri = chunk.web?.uri ?? "";
        if (!rawUri || !/^https?:\/\//i.test(rawUri)) continue;
        const uri = rawToFinalUrlMap.get(rawUri) ?? rawUri;
        let hostname = uri;
        try {
          hostname = new URL(uri).hostname;
        } catch {
          // fallback
        }
        sourceMap.set(uri, {
          uri,
          title: chunkTitleMap.get(rawUri) || hostname,
          sourceType: classifySourceType(uri, officialHost),
        });
      }

      for (const entry of urlMeta) {
        const rawUri = entry.retrievedUrl;
        if (rawUri && /^https?:\/\//i.test(rawUri)) {
          const uri = rawToFinalUrlMap.get(rawUri) ?? rawUri;
          if (!sourceMap.has(uri)) {
            let hostname = uri;
            try {
              hostname = new URL(uri).hostname;
            } catch {
              // fallback
            }
            sourceMap.set(uri, {
              uri,
              title: `Direct URL Inspection (${hostname})`,
              sourceType: classifySourceType(uri, officialHost),
            });
          }
        }
      }

      const chunkNormalized = (parsed.fields ?? []).map((f) => {
        const validStatus = (
          ["match", "discrepancy", "resolved_missing", "still_unverified"] as const
        ).includes(f.status as VerifyInstitutionResponse["fields"][number]["status"])
          ? f.status
          : "still_unverified";

        const validConfidence = (["high", "medium", "low"] as const).includes(
          f.confidence as "high" | "medium" | "low"
        )
          ? f.confidence
          : "medium";

        const rawFieldUrls = (
          Array.isArray(f.sourceUrls) ? f.sourceUrls : []
        ).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));

        const safeUrls = Array.from(
          new Set(rawFieldUrls.map((u) => rawToFinalUrlMap.get(u) ?? u))
        );

        for (const u of safeUrls) {
          if (!sourceMap.has(u)) {
            let hostname = u;
            try {
              hostname = new URL(u).hostname;
            } catch {
              // fallback
            }
            sourceMap.set(u, {
              uri: u,
              title: hostname,
              sourceType: classifySourceType(u, officialHost),
            });
          }
        }

        const origFieldMeta = chunkFields.find(
          (tf) =>
            tf.key.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ===
            String(f.fieldKey ?? "")
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")
        );
        const origValue = origFieldMeta?.currentValue ?? "";
        const wasOrigClipped = origValue.length > 4500;

        const rawVerifiedVal = f.verifiedValue as unknown;
        let safeVerifiedValue =
          rawVerifiedVal === null || rawVerifiedVal === undefined
            ? ""
            : typeof rawVerifiedVal === "string"
            ? rawVerifiedVal
            : JSON.stringify(rawVerifiedVal);

        if (safeVerifiedValue === "__MATCH_EXISTING__") {
          safeVerifiedValue = validStatus === "match" ? origValue : "";
        } else if (
          validStatus === "match" &&
          (safeVerifiedValue.trim() === "" ||
            (wasOrigClipped && safeVerifiedValue.length < origValue.length))
        ) {
          // Preserve complete untruncated DB value when model confirms a match on a large field
          safeVerifiedValue = origValue;
        }

        // Enforce schema tuple formatting for has_elearning / has_distance_learning
        const shortFieldKey = String(f.fieldKey ?? "")
          .trim()
          .split(".")
          .pop()
          ?.toLowerCase();
        if (
          (shortFieldKey === "has_elearning" ||
            shortFieldKey === "has_distance_learning") &&
          safeVerifiedValue.trim() !== ""
        ) {
          try {
            const parsedTuple = JSON.parse(safeVerifiedValue);
            if (Array.isArray(parsedTuple) && parsedTuple.length >= 2) {
              let mode = String(parsedTuple[0] ?? "").trim().toLowerCase();
              let reason = String(parsedTuple[1] ?? "").trim();
              if (mode === "verified" || mode === "implied" || mode === "none") {
                if (mode === "verified" && !/https?:\/\//i.test(reason)) {
                  if (safeUrls[0]) {
                    reason = `${reason} (${safeUrls[0]})`;
                  } else {
                    mode = "implied";
                  }
                }
                if (!reason) {
                  reason = String(f.reasoning ?? "Verified via live search.");
                }
                safeVerifiedValue = JSON.stringify([mode, reason]);
              }
            }
          } catch {
            // Leave as-is if not JSON tuple
          }
        }

        return {
          fieldKey: String(f.fieldKey ?? ""),
          verifiedValue: safeVerifiedValue,
          status: validStatus,
          confidence: validConfidence,
          reasoning: String(f.reasoning ?? ""),
          evidenceSnippet: String(f.evidenceSnippet ?? ""),
          sourceUrls: safeUrls,
        };
      });

      for (const nf of chunkNormalized) {
        allNormalizedFields.push(nf);
      }

      const returnedKeys = new Set(
        chunkNormalized.map((nf) =>
          nf.fieldKey.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
        )
      );
      const missingInChunk = chunkFields
        .filter(
          (tf) =>
            !returnedKeys.has(
              tf.key.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
            )
        )
        .map((tf) => tf.key);

      if (missingInChunk.length > 0) {
        warnings.push(
          `Model omitted output for: ${missingInChunk.join(", ")}`
        );
      }
    }

    const payload: VerifyInstitutionResponse = {
      discoveredOfficialUrl,
      executiveSummary: summaryParts.join(" "),
      fields: allNormalizedFields,
      sources: Array.from(sourceMap.values()),
      verifiedAt: new Date().toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (!res.writableEnded) {
      res.json(payload);
    }
  } catch (err) {
    console.error("Error in /api/verify-institution:", err);
    const rawMessage =
      err instanceof Error ? err.message : "Unknown verification error.";

    let extractedMessage = rawMessage;
    let extractedStatusCode: number | undefined =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;
    let extractedStatusText = "";

    try {
      const parsedErr = JSON.parse(rawMessage);
      if (parsedErr?.error) {
        if (typeof parsedErr.error.message === "string") {
          extractedMessage = parsedErr.error.message;
        }
        if (typeof parsedErr.error.code === "number") {
          extractedStatusCode = parsedErr.error.code;
        }
        if (typeof parsedErr.error.status === "string") {
          extractedStatusText = parsedErr.error.status;
        }
      }
    } catch {
      // rawMessage is not JSON; keep as-is
    }

    let friendlyMessage = extractedMessage;
    let statusCode = extractedStatusCode ?? 500;

    if (
      extractedMessage.includes("GEMINI_API_KEY is not configured") ||
      extractedMessage.includes("Secrets")
    ) {
      statusCode = 401;
    } else if (
      extractedStatusCode === 403 ||
      extractedStatusText === "PERMISSION_DENIED" ||
      extractedMessage.includes("free tier is not available")
    ) {
      statusCode = 403;
      friendlyMessage =
        "Gemini API permission denied (403): the free tier is not available for the attached project. Open Settings > Secrets in AI Studio to select a billing-enabled Gemini API key, or enable billing on your project at https://aistudio.google.com/billing.";
    } else if (
      extractedStatusText === "API_KEY_INVALID" ||
      extractedMessage.includes("API key not valid")
    ) {
      statusCode = 400;
      friendlyMessage =
        "Invalid Gemini API key (400). Please check or replace GEMINI_API_KEY in AI Studio's Settings > Secrets panel.";
    } else if (
      extractedStatusCode === 429 ||
      extractedStatusText === "RESOURCE_EXHAUSTED" ||
      extractedMessage.includes("RESOURCE_EXHAUSTED")
    ) {
      statusCode = 429;
      friendlyMessage =
        "Gemini API quota exceeded (429). Wait briefly before retrying or attach a billing-enabled API key in Settings > Secrets.";
    }

    if (!res.writableEnded) {
      res.status(statusCode).json({ error: friendlyMessage });
    }
  } finally {
    clearTimeout(overallTimer);
  }
});

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR !== "true" ? { server: httpServer } : false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
