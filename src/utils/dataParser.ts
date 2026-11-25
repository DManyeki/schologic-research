import type {
  ColumnFilterRule,
  DatasetFormat,
  DatasetMeta,
  FieldMapping,
  FieldRole,
  InstitutionRecord,
  PriorFieldVerdict,
  TriageState,
  UnresolvedRuleConfig,
} from "../types";

export const DEFAULT_UNRESOLVED_TOKENS = [
  "flagged",
  "unresolved",
  "ambiguous",
  "failed",
  "error",
  "timeout",
  "not_found",
  "needs_review",
  "pending",
  "partial",
  "mismatch",
];

function detectCsvDelimiter(firstLine: string): string {
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  for (const delim of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === delim) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  return bestCount > 0 ? best : ",";
}

/**
 * RFC-4180 compliant delimited parser handling commas, tabs, semicolons, quoted fields, multiline quoted strings, and UTF-8 BOM.
 */
export function parseCSV(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return [];

  const firstNewline = clean.search(/\r?\n/);
  const firstLine = firstNewline >= 0 ? clean.slice(0, firstNewline) : clean;
  const delimiter = detectCsvDelimiter(firstLine);

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\r" && nextChar === "\n") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
        i++;
      } else if (char === "\n" || char === "\r") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim()).filter(Boolean);
  const records: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (row[c] ?? "").trim();
    }
    records.push(obj);
  }

  return records;
}

export function serializeCSV(
  records: Record<string, unknown>[],
  columnOrder: string[]
): string {
  const escapeCell = (val: unknown): string => {
    const str =
      val === null || val === undefined
        ? ""
        : typeof val === "object"
        ? JSON.stringify(val)
        : String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = columnOrder.map(escapeCell).join(",");
  const dataLines = records.map((rec) =>
    columnOrder.map((col) => escapeCell(rec[col])).join(",")
  );
  return [headerLine, ...dataLines].join("\n");
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const normKey = normalizeColName(key);
    const shouldNotFlatten =
      PIPELINE_METADATA_COLUMNS.has(normKey) ||
      /(_jsonb|_json|_sources|_evidence|_verdicts?)$/.test(normKey);

    if (
      !shouldNotFlatten &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      depth < 2 &&
      Object.keys(val as Record<string, unknown>).length > 0
    ) {
      const nested = flattenObject(val as Record<string, unknown>, path, depth + 1);
      for (const [nk, nv] of Object.entries(nested)) {
        result[nk] = nv;
      }
    } else {
      result[path] = val;
    }
  }
  return result;
}

export function stringifyFieldValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) return JSON.stringify(val);
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

export function parseFlaggedFieldList(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  const str = String(val).trim();
  if (!str || str === "[]") return [];
  if (str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  return str
    .split(/[;|,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeColName(col: string): string {
  return col
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const PIPELINE_METADATA_COLUMNS = new Set([
  "id",
  "row_id",
  "record_id",
  "uuid",
  "_id",
  "created_at",
  "updated_at",
  "sync_updated_at",
  "sync_run_id",
  "verified_at",
  "verified_by_run",
  "claimed_by",
  "claimed_until",
  "claim_queue",
  "attempt_count",
  "last_writer",
  "duplicate_of",
  "profile_level",
  "research_queued_at",
  "research_origin",
  "research_pass",
  "verification_pass",
  "conflict_pass",
  "verification_basis",
  "research_score",
  "health_score",
  "last_sync_at",
  "evidence_prefetched_at",
  "evidence_packaged_at",
  "prefetch_error",
  "changelog_jsonb",
  "verified_fields_jsonb",
  "validation",
  "research_data",
  "conflict",
  "sources",
  "corpus_sources",
  "institution_sources",
  "other_sources",
  "geo",
]);

export function inferColumnRole(key: string): FieldRole {
  const norm = normalizeColName(key);
  const parts = key.split(".");
  const rootSegment = normalizeColName(parts[0] ?? key);
  const lastSegment = normalizeColName(parts[parts.length - 1] ?? key);

  if (
    /(prefetch_status|research_status|sync_status|verification_status|verify_status|python_status|audit_status|^status$|resolution_status|operational_status|registration_status)/.test(
      lastSegment
    ) ||
    /(prefetch_status|research_status|sync_status|verification_status)/.test(norm)
  ) {
    return "prior_status";
  }
  if (
    /(target_fields|unresolved_fields|flagged_fields|failed_fields|error_fields)/.test(
      lastSegment
    )
  ) {
    return "flagged_fields";
  }
  if (
    /(research_note|last_error|python_script_note|python_note|script_note|error_reason|failure_reason|unresolved_reason|verification_note|flag_reason|^notes?$|reason)/.test(
      lastSegment
    )
  ) {
    return "prior_note";
  }
  if (
    PIPELINE_METADATA_COLUMNS.has(rootSegment) ||
    PIPELINE_METADATA_COLUMNS.has(lastSegment) ||
    /(_jsonb|_json|_sources|_source|_evidence|_verdicts?|_metadata|_log|_error|_at|_by|_run|_score|_pass)$/.test(
      lastSegment
    )
  ) {
    return "ignore";
  }
  if (
    /(^(institution_)?name$|university_name|college_name|school_name|instnm|institution$|official_name)/.test(
      lastSegment
    )
  ) {
    return "identifier";
  }
  if (/^(website|website_url|web_url|homepage|url|domain|webaddr|official_url)$/.test(lastSegment)) {
    return "url";
  }
  if (
    /^(city|town|county|state|province|country|location|address|street_address|region|zip|postal_code|postcode|city_state)$/.test(
      lastSegment
    )
  ) {
    return "location";
  }
  if (/(accred|dapip|ope_id|opeid|ipeds|unitid|carnegie|registry)/.test(lastSegment)) {
    return "accreditation";
  }
  return "attribute";
}

export function suggestPromptHint(key: string, role: FieldRole): string {
  const lower = key.toLowerCase();
  if (role === "url") return "Confirm active canonical official homepage URL (if no standalone official website exists, fall back to the institution's official Facebook page URL)";
  if (lower === "logo_url") return "Find direct official institution logo image URL if published";
  if (role === "accreditation" || lower.includes("accred")) {
    return "Verify institutional accreditor, registration ID, and licence validity via official regulator/registry";
  }
  if (lower === "facilities") {
    return "Verify campus facilities, workshops, labs, or libraries from official sources (return JSON array of strings)";
  }
  if (lower === "courses") {
    return "Verify official accredited academic/TVET programmes or courses offered";
  }
  if (lower === "campuses") {
    return "Verify branch or additional campus locations if any (return JSON array)";
  }
  if (lower === "has_elearning" || lower === "has_distance_learning") {
    return 'Return 2-element JSON array ["verified"|"implied"|"none", "<reasoning>"]: use "verified" (with portal URL in reasoning) if an LMS/ODeL portal URL exists, "implied" if mentioned without portal URL, or "none" if absent';
  }
  if (
    lower.includes("president") ||
    lower.includes("chancellor") ||
    lower.includes("leader")
  ) {
    return "Check current institutional president, principal, or chancellor on official leadership page";
  }
  if (lower.includes("tuition") || lower.includes("fee")) {
    return "Check latest published academic year tuition and fees";
  }
  if (lower.includes("enroll") || lower.includes("student_count")) {
    return "Check latest official total student enrollment";
  }
  return "";
}

function findColumnByTokens(
  columnOrder: string[],
  includeAll: string[]
): string | undefined {
  return columnOrder.find((col) => {
    const norm = normalizeColName(col);
    return includeAll.every((tok) => norm.includes(tok));
  });
}

export function buildDefaultColumnFilters(
  columnOrder: string[]
): {
  filters: ColumnFilterRule[];
  matchLogic: "AND" | "OR";
  treatEmptyAsUnresolved: boolean;
} {
  const prefetchCol = findColumnByTokens(columnOrder, ["prefetch", "status"]);
  const researchCol = findColumnByTokens(columnOrder, ["research", "status"]);
  const syncCol = findColumnByTokens(columnOrder, ["sync", "status"]);
  const verificationCol =
    findColumnByTokens(columnOrder, ["verification", "status"]) ||
    findColumnByTokens(columnOrder, ["verify", "status"]);

  const multiFilters: ColumnFilterRule[] = [];
  if (prefetchCol) {
    multiFilters.push({
      id: "rule-prefetch-status",
      column: prefetchCol,
      operator: "equals",
      value: "packaged",
      enabled: true,
    });
  }
  if (researchCol) {
    multiFilters.push({
      id: "rule-research-status",
      column: researchCol,
      operator: "equals",
      value: "researched",
      enabled: true,
    });
  }
  if (syncCol) {
    multiFilters.push({
      id: "rule-sync-status",
      column: syncCol,
      operator: "equals",
      value: "applied",
      enabled: true,
    });
  }
  if (verificationCol) {
    multiFilters.push({
      id: "rule-verification-status",
      column: verificationCol,
      operator: "equals",
      value: "flagged",
      enabled: true,
    });
  }

  if (multiFilters.length > 0) {
    return {
      filters: multiFilters,
      matchLogic: "AND",
      treatEmptyAsUnresolved: false,
    };
  }

  const genericStatusCol = columnOrder.find((col) =>
    /^(status|python_status|audit_status|resolution_status)$/i.test(
      normalizeColName(col)
    )
  );
  if (genericStatusCol) {
    return {
      filters: [
        {
          id: "rule-generic-status",
          column: genericStatusCol,
          operator: "contains",
          value: "unresolved",
          enabled: true,
        },
      ],
      matchLogic: "AND",
      treatEmptyAsUnresolved: true,
    };
  }

  return {
    filters: [],
    matchLogic: "AND",
    treatEmptyAsUnresolved: true,
  };
}

export function parseRawInput(
  rawText: string,
  fileName: string
): {
  rows: Record<string, unknown>[];
  meta: DatasetMeta;
  mappings: FieldMapping[];
  unresolvedRules: UnresolvedRuleConfig;
} {
  const trimmed = rawText.trim();
  let rawObjects: Record<string, unknown>[] = [];
  let format: DatasetFormat = "csv";
  let jsonRootKey: string | null = null;

  const looksLikeJson =
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    fileName.toLowerCase().endsWith(".json");

  if (looksLikeJson) {
    format = "json";
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      rawObjects = parsed.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object")
      );
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const preferredKeys = [
        "institutions",
        "records",
        "data",
        "profiles",
        "items",
        "results",
        "rows",
      ];
      let foundArrayKey = preferredKeys.find((k) => Array.isArray(obj[k]));
      if (!foundArrayKey) {
        foundArrayKey = Object.keys(obj).find(
          (k) =>
            Array.isArray(obj[k]) &&
            (obj[k] as unknown[]).some(
              (el) => el && typeof el === "object" && !Array.isArray(el)
            )
        );
      }

      if (foundArrayKey) {
        jsonRootKey = foundArrayKey;
        rawObjects = (obj[foundArrayKey] as unknown[]).filter(
          (item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object")
        );
      } else {
        const entries = Object.entries(obj);
        const objectEntries = entries.filter(
          ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v)
        );
        if (objectEntries.length > 1 && objectEntries.length === entries.length) {
          rawObjects = objectEntries.map(([key, val]) => ({
            _record_key: key,
            ...(val as Record<string, unknown>),
          }));
        } else {
          rawObjects = [obj];
        }
      }
    }
  } else {
    format = "csv";
    rawObjects = parseCSV(rawText);
  }

  const rows = rawObjects.map((r) => flattenObject(r));

  if (rows.length === 0) {
    throw new Error("No valid records found in the provided file or text.");
  }

  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  const columnOrder = Array.from(columnSet);

  const mappings: FieldMapping[] = columnOrder.map((key) => {
    const role = inferColumnRole(key);
    const shouldVerify =
      role !== "ignore" &&
      role !== "prior_status" &&
      role !== "prior_note" &&
      role !== "flagged_fields";
    return {
      key,
      role,
      verifyEnabled: shouldVerify,
      promptHint: suggestPromptHint(key, role),
    };
  });

  if (!mappings.some((m) => m.role === "identifier") && mappings.length > 0) {
    const fallback =
      mappings.find((m) => m.role === "attribute") ?? mappings[0];
    fallback.role = "identifier";
    fallback.verifyEnabled = true;
  }

  const priorNoteMappings = mappings.filter((m) => m.role === "prior_note");
  const noteField =
    priorNoteMappings.find(
      (m) =>
        normalizeColName(m.key) === "research_note" &&
        rows.some((r) => stringifyFieldValue(r[m.key]).trim() !== "")
    )?.key ??
    priorNoteMappings.find((m) =>
      rows.some((r) => stringifyFieldValue(r[m.key]).trim() !== "")
    )?.key ??
    priorNoteMappings[0]?.key ??
    "";
  const flaggedField =
    mappings.find((m) => m.role === "flagged_fields")?.key ?? "";

  const defaultFilterSetup = buildDefaultColumnFilters(columnOrder);

  const unresolvedRules: UnresolvedRuleConfig = {
    matchLogic: defaultFilterSetup.matchLogic,
    columnFilters: defaultFilterSetup.filters,
    noteField,
    flaggedField,
    treatEmptyAsUnresolved: defaultFilterSetup.treatEmptyAsUnresolved,
  };

  return {
    rows,
    meta: {
      fileName,
      format,
      columnOrder,
      jsonRootKey,
      importedAt: new Date().toISOString(),
    },
    mappings,
    unresolvedRules,
  };
}

export function evaluateColumnFilter(
  raw: Record<string, unknown>,
  rule: ColumnFilterRule
): boolean {
  if (!rule.column) return true;
  const rawStr = stringifyFieldValue(raw[rule.column]).trim();
  const rawLower = rawStr.toLowerCase();
  const targetLower = rule.value.trim().toLowerCase();

  switch (rule.operator) {
    case "equals":
      return rawLower === targetLower;
    case "contains":
      return targetLower === ""
        ? rawLower.length > 0
        : rawLower.includes(targetLower);
    case "not_equals":
      return rawLower !== targetLower;
    case "is_empty":
      return rawStr === "";
    case "is_not_empty":
      return rawStr !== "";
  }
}

export function doesRowMatchUnresolvedRules(
  raw: Record<string, unknown>,
  rules: UnresolvedRuleConfig,
  verifiableKeys: string[],
  flaggedFields: string[]
): boolean {
  const activeFilters = rules.columnFilters.filter(
    (f) => f.enabled && f.column.trim() !== ""
  );

  let matchesColumnFilters = false;
  if (activeFilters.length > 0) {
    if (rules.matchLogic === "AND") {
      matchesColumnFilters = activeFilters.every((rule) =>
        evaluateColumnFilter(raw, rule)
      );
    } else {
      matchesColumnFilters = activeFilters.some((rule) =>
        evaluateColumnFilter(raw, rule)
      );
    }
  } else {
    matchesColumnFilters =
      flaggedFields.length > 0 ||
      (rules.treatEmptyAsUnresolved &&
        verifiableKeys.some((k) => stringifyFieldValue(raw[k]).trim() === ""));
    return matchesColumnFilters;
  }

  if (rules.treatEmptyAsUnresolved) {
    const hasEmpty = verifiableKeys.some(
      (k) => stringifyFieldValue(raw[k]).trim() === ""
    );
    return rules.matchLogic === "AND"
      ? matchesColumnFilters
      : matchesColumnFilters || hasEmpty;
  }

  return matchesColumnFilters;
}

export function isPlaceholderOrEmpty(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]" || trimmed === "{}") return true;
  return /^(n\/a|na|none|null|unknown|tbd|missing|pending|unverified|-|--)$/i.test(
    trimmed
  );
}

function safeParseJsonObj(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === "string") {
    const t = val.trim();
    if (t.startsWith("{")) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parsePriorFieldVerdicts(
  raw: Record<string, unknown>
): Record<string, PriorFieldVerdict> {
  const verdicts: Record<string, PriorFieldVerdict> = {};

  const recordVerdict = (rawKey: string, entry: Record<string, unknown>) => {
    const status = String(entry.status || entry.verdict || "").trim();
    const rationale = String(entry.rationale || "").trim();
    if (!status && !rationale) return;
    const verdictObj: PriorFieldVerdict = {
      status: status || "unknown",
      rationale,
      sourceUrl:
        typeof entry.source_url === "string" ? entry.source_url : undefined,
      urlChecked:
        typeof entry.url_checked === "string" ? entry.url_checked : undefined,
    };
    const exactLower = rawKey.toLowerCase();
    const shortLower = (rawKey.split(".").pop() ?? rawKey).toLowerCase();
    verdicts[exactLower] = verdictObj;
    verdicts[shortLower] = verdictObj;
  };

  const vf = safeParseJsonObj(raw.verified_fields_jsonb);
  if (vf) {
    for (const [k, v] of Object.entries(vf)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        recordVerdict(k, v as Record<string, unknown>);
      }
    }
  }

  const valObj = safeParseJsonObj(raw.validation);
  const fieldVerdicts = valObj
    ? safeParseJsonObj(valObj.field_verdicts)
    : null;
  if (fieldVerdicts) {
    for (const [k, v] of Object.entries(fieldVerdicts)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        recordVerdict(k, v as Record<string, unknown>);
      }
    }
  }

  // Also support pre-flattened keys like verified_fields_jsonb.town or validation.field_verdicts.location
  for (const [k, v] of Object.entries(raw)) {
    if (
      k.startsWith("verified_fields_jsonb.") ||
      k.startsWith("validation.field_verdicts.")
    ) {
      const parsed = safeParseJsonObj(v);
      if (parsed) {
        const subKey = k
          .replace(/^verified_fields_jsonb\./, "")
          .replace(/^validation\.field_verdicts\./, "");
        recordVerdict(subKey, parsed);
      }
    }
  }

  return verdicts;
}

export function getPriorVerdictForField(
  record: InstitutionRecord,
  fieldKey: string
): PriorFieldVerdict | undefined {
  const lower = fieldKey.trim().toLowerCase();
  const shortLower = (lower.split(".").pop() ?? lower).toLowerCase();
  return (
    record.priorFieldVerdicts?.[lower] ??
    record.priorFieldVerdicts?.[shortLower]
  );
}

export function getFieldNeedReason(
  record: InstitutionRecord,
  fieldKey: string,
  originalValue: string
): string | null {
  const keyLower = fieldKey.trim().toLowerCase();
  const flaggedLower = record.flaggedFields.map((f) => f.trim().toLowerCase());
  const manualLower = (record.manualFlaggedFields ?? []).map((f) =>
    f.trim().toLowerCase()
  );
  const priorVerdict = getPriorVerdictForField(record, fieldKey);

  if (manualLower.includes(keyLower)) {
    return "Manually flagged for verification";
  }

  if (flaggedLower.includes(keyLower)) {
    if (priorVerdict && priorVerdict.status !== "confirmed") {
      return `Target field · ${priorVerdict.status}`;
    }
    return "Flagged in target_fields";
  }

  if (
    priorVerdict &&
    priorVerdict.status &&
    priorVerdict.status.toLowerCase() !== "confirmed"
  ) {
    return `Prior verdict: ${priorVerdict.status}`;
  }

  // Only fall back to note-mention or empty-value heuristics if the row has no explicit target_fields or prior verdicts
  const hasExplicitTargetSchema =
    record.flaggedFields.length > 0 ||
    Object.keys(record.priorFieldVerdicts ?? {}).length > 0;

  if (!hasExplicitTargetSchema) {
    if (
      record.priorNote &&
      (record.priorNote.toLowerCase().includes(keyLower.replace(/_/g, " ")) ||
        record.priorNote.toLowerCase().includes(keyLower))
    ) {
      return "Referenced in prior note";
    }
    if (isPlaceholderOrEmpty(originalValue)) {
      return "Empty or placeholder value";
    }
  }

  const result = record.fieldResults[fieldKey];
  if (
    result &&
    (result.status === "discrepancy" ||
      result.status === "resolved_missing" ||
      result.status === "still_unverified")
  ) {
    return result.status === "discrepancy"
      ? "Agent found updated value"
      : result.status === "resolved_missing"
      ? "Agent found missing value"
      : "Requires manual verification";
  }

  return null;
}

export function isFieldEligibleForReinvestigation(
  record: InstitutionRecord,
  fieldKey: string,
  originalValue: string
): boolean {
  const keyLower = fieldKey.trim().toLowerCase();
  const manualLower = (record.manualFlaggedFields ?? []).map((f) =>
    f.trim().toLowerCase()
  );
  if (manualLower.includes(keyLower)) {
    return true;
  }

  const matchedResultKey = Object.keys(record.fieldResults).find(
    (k) => k.trim().toLowerCase() === keyLower
  );
  const existingResult = matchedResultKey
    ? record.fieldResults[matchedResultKey]
    : undefined;
  if (existingResult && existingResult.decision !== "pending") {
    return false;
  }

  return Boolean(getFieldNeedReason(record, fieldKey, originalValue));
}

export function buildInstitutionRecords(
  rows: Record<string, unknown>[],
  mappings: FieldMapping[],
  rules: UnresolvedRuleConfig,
  existingRecords?: InstitutionRecord[]
): InstitutionRecord[] {
  const existingByIndex = new Map<number, InstitutionRecord>();
  if (existingRecords) {
    for (const r of existingRecords) {
      existingByIndex.set(r.rowIndex, r);
    }
  }

  const identifierKeys = mappings
    .filter((m) => m.role === "identifier")
    .map((m) => m.key);
  const urlKeys = mappings.filter((m) => m.role === "url").map((m) => m.key);
  const locationKeys = mappings
    .filter((m) => m.role === "location")
    .map((m) => m.key);
  const statusKeys = mappings
    .filter((m) => m.role === "prior_status")
    .map((m) => m.key);
  const verifiableKeys = mappings
    .filter((m) => m.verifyEnabled)
    .map((m) => m.key);

  return rows.map((raw, idx) => {
    const prev = existingByIndex.get(idx);
    const activeRaw = prev?.raw ?? raw;
    const initialRaw = prev?.initialRaw ?? raw;

    const displayName =
      identifierKeys
        .map((k) => stringifyFieldValue(activeRaw[k]))
        .find((v) => v.trim().length > 0) || `Institution #${idx + 1}`;

    const websiteUrl =
      urlKeys
        .map((k) => stringifyFieldValue(activeRaw[k]))
        .find((v) => v.trim().length > 0) || "";

    const locationParts: string[] = [];
    const seenLoc = new Set<string>();
    for (const k of locationKeys) {
      const rawVal = activeRaw[k];
      if (rawVal !== null && typeof rawVal === "object") continue;
      const str = stringifyFieldValue(rawVal).trim();
      if (!str || str.startsWith("{") || str.startsWith("[") || str.length > 140) {
        continue;
      }
      const norm = str.toLowerCase();
      if (!seenLoc.has(norm)) {
        seenLoc.add(norm);
        locationParts.push(str);
      }
    }
    const locationLabel = locationParts.join(", ");

    const priorityStatusKeys = [
      "prefetch_status",
      "research_status",
      "sync_status",
      "verification_status",
    ];
    const orderedStatusKeys = [
      ...priorityStatusKeys.filter((pk) => statusKeys.includes(pk)),
      ...statusKeys.filter((sk) => !priorityStatusKeys.includes(sk)),
    ].slice(0, 4);

    const statusParts = orderedStatusKeys
      .map((k) => {
        const val = stringifyFieldValue(activeRaw[k]).trim();
        return val ? `${k}: ${val}` : "";
      })
      .filter(Boolean);
    const priorStatus = statusParts.join(" · ");

    const noteKeys = mappings
      .filter((m) => m.role === "prior_note")
      .map((m) => m.key);
    const orderedNoteKeys = rules.noteField
      ? [rules.noteField, ...noteKeys.filter((k) => k !== rules.noteField)]
      : noteKeys;
    const priorNote = orderedNoteKeys
      .map((k) => stringifyFieldValue(activeRaw[k]).trim())
      .filter(Boolean)
      .join(" | ");
    const flaggedFields = rules.flaggedField
      ? parseFlaggedFieldList(activeRaw[rules.flaggedField])
      : [];

    const priorFieldVerdicts =
      prev?.priorFieldVerdicts ?? parsePriorFieldVerdicts(activeRaw);

    const isUnresolved = doesRowMatchUnresolvedRules(
      activeRaw,
      rules,
      verifiableKeys,
      flaggedFields
    );

    let triageState: TriageState = isUnresolved
      ? "unresolved"
      : "previously_clean";

    if (
      prev &&
      (Object.keys(prev.fieldResults).length > 0 || prev.savedEvidence)
    ) {
      triageState = prev.triageState;
    }

    return {
      id: prev?.id ?? `inst-${idx + 1}`,
      rowIndex: idx,
      initialRaw,
      raw: activeRaw,
      displayName,
      websiteUrl,
      locationLabel,
      priorStatus,
      priorNote,
      flaggedFields,
      manualFlaggedFields: prev?.manualFlaggedFields ?? [],
      priorFieldVerdicts,
      triageState,
      researcherHint: prev?.researcherHint ?? "",
      lastVerifiedAt: prev?.lastVerifiedAt,
      summaryNote: prev?.summaryNote,
      discoveredOfficialUrl: prev?.discoveredOfficialUrl,
      sources: prev?.sources ?? [],
      fieldResults: prev?.fieldResults ?? {},
      savedEvidence: prev?.savedEvidence,
      errorMessage: prev?.errorMessage,
    };
  });
}

export const SAMPLE_PYTHON_OUTPUT_JSON = JSON.stringify(
  {
    pipeline_run: "verify_higher_ed_v2.py",
    institutions: [
      {
        unitid: "139940",
        institution_name: "Georgia State University",
        website_url: "http://www.gsu.edu",
        city_state: "Atlanta, GA",
        accreditation_body: "SACSCOC",
        president_name: "Mark P. Becker",
        undergrad_tuition_in_state: "$9,286",
        total_enrollment: "",
        prefetch_status: "packaged",
        research_status: "researched",
        sync_status: "applied",
        verification_status: "flagged",
        target_fields: ["president_name", "total_enrollment", "website_url"],
        research_note:
          "HTTP 403 bot challenge on catalog scrape; leadership bio page changed URL structure; enrollment table missing.",
      },
      {
        unitid: "196413",
        institution_name: "University of the Arts",
        website_url: "https://www.uarts.edu",
        city_state: "Philadelphia, PA",
        accreditation_body: "Middle States Commission on Higher Education",
        president_name: "Kerry Walk",
        undergrad_tuition_in_state: "$54,010",
        total_enrollment: "1,313",
        prefetch_status: "packaged",
        research_status: "researched",
        sync_status: "applied",
        verification_status: "flagged",
        target_fields: ["institution_name", "accreditation_body", "website_url"],
        research_note:
          "SSL/DNS timeout and conflicting news references regarding institutional closure or status change in 2024.",
      },
      {
        unitid: "166683",
        institution_name: "Massachusetts Institute of Technology",
        website_url: "https://www.mit.edu",
        city_state: "Cambridge, MA",
        accreditation_body: "New England Commission of Higher Education (NECHE)",
        president_name: "Sally Kornbluth",
        undergrad_tuition_in_state: "$61,990",
        total_enrollment: "11,920",
        prefetch_status: "packaged",
        research_status: "researched",
        sync_status: "applied",
        verification_status: "verified",
        target_fields: [],
        research_note:
          "All fields matched official factbook and NECHE registry.",
      },
    ],
  },
  null,
  2
);
