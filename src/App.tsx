import { useEffect, useMemo, useRef, useState } from "react";
import { TopBar, type WorkspaceTab } from "./components/TopBar";
import { ImportSchemaView } from "./components/ImportSchemaView";
import {
  QueueSidebar,
  matchesQueueFilter,
  type BatchLimitOption,
  type QueueFilter,
} from "./components/QueueSidebar";
import { DiffWorkspace } from "./components/DiffWorkspace";
import { EvidencePane } from "./components/EvidencePane";
import { ExportView } from "./components/ExportView";
import type {
  DatasetMeta,
  FieldDecision,
  FieldMapping,
  FieldVerificationResult,
  FieldVerificationStatus,
  GeminiModelId,
  InstitutionRecord,
  PriorFieldVerdict,
  SavedEvidenceEntry,
  SavedVerificationRecord,
  UnresolvedRuleConfig,
  VerificationCapabilities,
  VerifyInstitutionResponse,
} from "./types";
import {
  buildInstitutionRecords,
  getFieldNeedReason,
  getPriorVerdictForField,
  inferColumnRole,
  isFieldEligibleForReinvestigation,
  parseRawInput,
  stringifyFieldValue,
} from "./utils/dataParser";
import {
  clearWorkspaceFromDB,
  loadWorkspaceFromDB,
  saveWorkspaceToDB,
} from "./utils/storage";

interface PersistedWorkspace {
  datasetMeta: DatasetMeta | null;
  mappings: FieldMapping[];
  unresolvedRules: UnresolvedRuleConfig;
  records: InstitutionRecord[];
}

const EMPTY_RULES: UnresolvedRuleConfig = {
  matchLogic: "AND",
  columnFilters: [],
  noteField: "",
  flaggedField: "",
  treatEmptyAsUnresolved: true,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("import");
  const [datasetMeta, setDatasetMeta] = useState<DatasetMeta | null>(null);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [unresolvedRules, setUnresolvedRules] =
    useState<UnresolvedRuleConfig>(EMPTY_RULES);
  const [records, setRecords] = useState<InstitutionRecord[]>([]);

  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("unresolved");
  const [searchQuery, setSearchQuery] = useState("");
  const [capabilities, setCapabilities] = useState<VerificationCapabilities>({
    webSearch: true,
    officialSite: true,
    registryCheck: true,
  });
  const [selectedModel, setSelectedModel] = useState<GeminiModelId>(
    "gemini-3.5-flash-lite"
  );

  const [isEvidenceCollapsed, setIsEvidenceCollapsed] = useState(false);

  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const batchAbortRef = useRef<boolean>(false);
  const investigateControllersRef = useRef<Map<string, AbortController>>(
    new Map()
  );
  const justResolvedRef = useRef<{
    id: string;
    rowIndex: number;
    name: string;
  } | null>(null);
  const [advanceNotice, setAdvanceNotice] = useState<string | null>(null);

  // Hydrate persisted workspace from IndexedDB on mount and normalize legacy mappings/locations
  useEffect(() => {
    let cancelled = false;
    loadWorkspaceFromDB<PersistedWorkspace>().then((saved) => {
      if (cancelled || !saved) return;
      if (Array.isArray(saved.records) && saved.records.length > 0) {
        const normalizedMappings = (saved.mappings ?? []).map((m) => {
          const freshRole = inferColumnRole(m.key);
          if (freshRole === "ignore" && m.role !== "ignore") {
            return { ...m, role: "ignore" as const, verifyEnabled: false };
          }
          return m;
        });
        const activeRules = saved.unresolvedRules ?? EMPTY_RULES;
        const rebuiltRecords = buildInstitutionRecords(
          saved.records.map((r) => r.raw),
          normalizedMappings,
          activeRules,
          saved.records
        ).map((rec) => {
          // Recover records left in transient "investigating" state by an interrupted session
          if (rec.triageState === "investigating") {
            const hasResults = Object.keys(rec.fieldResults).length > 0;
            return {
              ...rec,
              triageState: hasResults
                ? ("needs_review" as const)
                : ("unresolved" as const),
              errorMessage:
                rec.errorMessage ||
                "Previous investigation was interrupted before completion. Click Investigate to retry.",
            };
          }
          return rec;
        });

        setDatasetMeta(saved.datasetMeta);
        setMappings(normalizedMappings);
        setUnresolvedRules(activeRules);
        setRecords(rebuiltRecords);
        const firstUnresolved = rebuiltRecords.find(
          (r) =>
            r.triageState === "unresolved" ||
            r.triageState === "needs_review" ||
            r.triageState === "api_error"
        );
        setSelectedRecordId(firstUnresolved?.id ?? rebuiltRecords[0].id);
        setActiveTab("triage");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist workspace changes to IndexedDB (skip transient investigating states; debounce to keep UI responsive)
  useEffect(() => {
    if (!datasetMeta || records.length === 0) return;
    if (records.some((r) => r.triageState === "investigating")) return;
    const timer = setTimeout(() => {
      saveWorkspaceToDB<PersistedWorkspace>({
        datasetMeta,
        mappings,
        unresolvedRules,
        records,
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [datasetMeta, mappings, unresolvedRules, records]);

  const getVerificationStatusColumn = (): string => {
    return (
      mappings.find(
        (m) => m.role === "prior_status" && /verif/i.test(m.key)
      )?.key ??
      unresolvedRules.columnFilters.find((f) => /verif/i.test(f.column))
        ?.column ??
      mappings.find((m) => m.role === "prior_status")?.key ??
      ""
    );
  };

  const commitRecordSaveAndVerify = (
    record: InstitutionRecord,
    nextFieldResults: Record<string, FieldVerificationResult>
  ): InstitutionRecord => {
    const nextRaw: Record<string, unknown> = { ...record.raw };
    const nextPriorVerdicts: Record<string, PriorFieldVerdict> = {
      ...(record.priorFieldVerdicts ?? {}),
    };
    const entries: SavedEvidenceEntry[] = [];
    const sourceUrlSet = new Set<string>(record.sources.map((s) => s.uri));
    const savedAt = new Date().toISOString();

    // Update verified_fields_jsonb and validation.field_verdicts if present in raw
    let vfJson: Record<string, unknown> = {};
    try {
      if (typeof nextRaw.verified_fields_jsonb === "string" && nextRaw.verified_fields_jsonb.trim()) {
        vfJson = JSON.parse(nextRaw.verified_fields_jsonb);
      } else if (
        nextRaw.verified_fields_jsonb &&
        typeof nextRaw.verified_fields_jsonb === "object" &&
        !Array.isArray(nextRaw.verified_fields_jsonb)
      ) {
        vfJson = { ...(nextRaw.verified_fields_jsonb as Record<string, unknown>) };
      }
    } catch {
      vfJson = {};
    }

    let validationJson: Record<string, unknown> = {};
    try {
      if (typeof nextRaw.validation === "string" && nextRaw.validation.trim()) {
        validationJson = JSON.parse(nextRaw.validation);
      } else if (nextRaw.validation && typeof nextRaw.validation === "object") {
        validationJson = { ...(nextRaw.validation as Record<string, unknown>) };
      }
    } catch {
      validationJson = {};
    }
    const valFieldVerdicts =
      validationJson.field_verdicts &&
      typeof validationJson.field_verdicts === "object"
        ? { ...(validationJson.field_verdicts as Record<string, unknown>) }
        : {};

    let sourcesJson: Record<string, unknown> = {};
    try {
      if (typeof nextRaw.sources === "string" && nextRaw.sources.trim()) {
        sourcesJson = JSON.parse(nextRaw.sources);
      } else if (nextRaw.sources && typeof nextRaw.sources === "object" && !Array.isArray(nextRaw.sources)) {
        sourcesJson = { ...(nextRaw.sources as Record<string, unknown>) };
      }
    } catch {
      sourcesJson = {};
    }

    let changelogArr: Array<Record<string, unknown>> = [];
    try {
      if (typeof nextRaw.changelog_jsonb === "string" && nextRaw.changelog_jsonb.trim()) {
        const parsedCl = JSON.parse(nextRaw.changelog_jsonb);
        if (Array.isArray(parsedCl)) changelogArr = [...parsedCl];
      } else if (Array.isArray(nextRaw.changelog_jsonb)) {
        changelogArr = [...nextRaw.changelog_jsonb];
      }
    } catch {
      changelogArr = [];
    }

    for (const [fieldKey, res] of Object.entries(nextFieldResults)) {
      if (res.decision === "accepted" || res.decision === "edited") {
        nextRaw[fieldKey] = res.finalValue;
      } else if (res.decision === "kept_original") {
        nextRaw[fieldKey] = res.originalValue;
      }

      if (res.decision !== "pending") {
        const effectiveUrls =
          res.sourceUrls.length > 0
            ? res.sourceUrls
            : record.sources.map((s) => s.uri).slice(0, 3);

        for (const u of effectiveUrls) {
          sourceUrlSet.add(u);
        }
        entries.push({
          fieldKey,
          previousValue: res.originalValue,
          updatedValue: res.finalValue,
          decision: res.decision,
          reasoning: res.reasoning,
          evidenceSnippet: res.evidenceSnippet,
          sourceUrls: effectiveUrls,
        });

        const primaryUrl = effectiveUrls[0] || "";
        const verdictEntry = {
          status: "confirmed",
          verdict: "confirmed",
          rationale: res.reasoning || res.evidenceSnippet || "Confirmed via VeritasHE",
          source_url: primaryUrl,
          url_checked: primaryUrl,
          verified_at: savedAt,
        };
        vfJson[fieldKey] = verdictEntry;
        valFieldVerdicts[fieldKey] = verdictEntry;

        if (effectiveUrls.length > 0) {
          sourcesJson[fieldKey] = effectiveUrls;
        }

        changelogArr.push({
          field: fieldKey,
          action: "human_verify",
          new_val: res.finalValue,
          old_val: res.originalValue || null,
          timestamp: savedAt,
          decided_by: "veritashe:manual_confirm",
          source_urls: effectiveUrls,
        });

        nextPriorVerdicts[fieldKey.toLowerCase()] = {
          status: "confirmed",
          rationale: verdictEntry.rationale,
          sourceUrl: primaryUrl,
          urlChecked: primaryUrl,
        };
      }
    }

    if ("verified_fields_jsonb" in nextRaw) {
      nextRaw.verified_fields_jsonb = JSON.stringify(vfJson);
    }
    if ("validation" in nextRaw) {
      validationJson.field_verdicts = valFieldVerdicts;
      nextRaw.validation = JSON.stringify(validationJson);
    }
    if ("sources" in nextRaw || Object.keys(sourcesJson).length > 0) {
      nextRaw.sources = JSON.stringify(sourcesJson);
    }
    if ("changelog_jsonb" in nextRaw) {
      nextRaw.changelog_jsonb = JSON.stringify(changelogArr);
    }

    const verifCol = getVerificationStatusColumn();
    const prevVerifVal = verifCol
      ? stringifyFieldValue((record.initialRaw ?? record.raw)[verifCol])
      : record.priorStatus;

    if (verifCol) {
      nextRaw[verifCol] = "verified";
    }
    if ("verified_at" in nextRaw) {
      nextRaw.verified_at = savedAt;
    }
    if ("updated_at" in nextRaw || "last_updated" in nextRaw) {
      if ("updated_at" in nextRaw) nextRaw.updated_at = savedAt;
      if ("last_updated" in nextRaw) nextRaw.last_updated = savedAt;
    } else {
      nextRaw.updated_at = savedAt;
    }
    if ("last_writer" in nextRaw) {
      nextRaw.last_writer = "veritashe";
    }
    if (unresolvedRules.flaggedField) {
      nextRaw[unresolvedRules.flaggedField] = "[]";
    }

    const statusKeys = mappings
      .filter((m) => m.role === "prior_status")
      .map((m) => m.key);
    const priorityKeys = [
      "prefetch_status",
      "research_status",
      "sync_status",
      "verification_status",
    ];
    const orderedKeys = [
      ...priorityKeys.filter((pk) => statusKeys.includes(pk)),
      ...statusKeys.filter((sk) => !priorityKeys.includes(sk)),
    ].slice(0, 4);

    const updatedPriorStatus = orderedKeys
      .map((k) => {
        const val = stringifyFieldValue(nextRaw[k]).trim();
        return val ? `${k}: ${val}` : "";
      })
      .filter(Boolean)
      .join(" · ");

    const savedEvidence: SavedVerificationRecord = {
      savedAt,
      previousVerificationStatus: prevVerifVal || "flagged",
      newVerificationStatus: "verified",
      entries,
      allSourceUrls: Array.from(sourceUrlSet),
    };

    const identifierKeys = mappings
      .filter((m) => m.role === "identifier")
      .map((m) => m.key);
    const urlKeys = mappings.filter((m) => m.role === "url").map((m) => m.key);

    return {
      ...record,
      raw: nextRaw,
      displayName:
        identifierKeys
          .map((k) => stringifyFieldValue(nextRaw[k]))
          .find((v) => v.trim().length > 0) || record.displayName,
      websiteUrl:
        urlKeys
          .map((k) => stringifyFieldValue(nextRaw[k]))
          .find((v) => v.trim().length > 0) || record.websiteUrl,
      priorStatus: updatedPriorStatus || "verification_status: verified",
      flaggedFields: [],
      manualFlaggedFields: [],
      priorFieldVerdicts: nextPriorVerdicts,
      fieldResults: nextFieldResults,
      savedEvidence,
      errorMessage: undefined,
      triageState: "resolved",
    };
  };

  const handleImportText = (rawText: string, fileName: string) => {
    const parsed = parseRawInput(rawText, fileName);
    const built = buildInstitutionRecords(
      parsed.rows,
      parsed.mappings,
      parsed.unresolvedRules
    );
    setDatasetMeta(parsed.meta);
    setMappings(parsed.mappings);
    setUnresolvedRules(parsed.unresolvedRules);
    setRecords(built);
    const firstUnresolved = built.find((r) => r.triageState === "unresolved");
    setSelectedRecordId(firstUnresolved?.id ?? built[0]?.id ?? null);
    setSelectedFieldKey(null);
    setQueueFilter(firstUnresolved ? "unresolved" : "all");
  };

  const handleUpdateMappings = (nextMappings: FieldMapping[]) => {
    setMappings(nextMappings);
    if (records.length > 0) {
      const rebuilt = buildInstitutionRecords(
        records.map((r) => r.raw),
        nextMappings,
        unresolvedRules,
        records
      );
      setRecords(rebuilt);
    }
  };

  const handleUpdateRules = (nextRules: UnresolvedRuleConfig) => {
    setUnresolvedRules(nextRules);
    if (records.length > 0) {
      const rebuilt = buildInstitutionRecords(
        records.map((r) => r.raw),
        mappings,
        nextRules,
        records
      );
      setRecords(rebuilt);
      const firstUnresolved = rebuilt.find(
        (r) => r.triageState === "unresolved" || r.triageState === "needs_review"
      );
      if (firstUnresolved) {
        setSelectedRecordId(firstUnresolved.id);
      }
    }
  };

  const handleResetWorkspace = () => {
    batchAbortRef.current = true;
    setIsBatchRunning(false);
    setBatchProgress(null);
    setDatasetMeta(null);
    setMappings([]);
    setUnresolvedRules(EMPTY_RULES);
    setRecords([]);
    setSelectedRecordId(null);
    setSelectedFieldKey(null);
    clearWorkspaceFromDB();
  };

  const handleToggleCapability = (cap: keyof VerificationCapabilities) => {
    setCapabilities((prev) => ({ ...prev, [cap]: !prev[cap] }));
  };

  const handleUpdateHint = (recordId: string, hint: string) => {
    setRecords((prev) =>
      prev.map((r) => (r.id === recordId ? { ...r, researcherHint: hint } : r))
    );
  };

  const handleToggleManualFlag = (recordId: string, fieldKey: string) => {
    setRecords((prev) =>
      prev.map((r) => {
        if (r.id !== recordId) return r;
        const current = r.manualFlaggedFields ?? [];
        const exists = current.some(
          (f) => f.toLowerCase() === fieldKey.toLowerCase()
        );
        const nextManual = exists
          ? current.filter((f) => f.toLowerCase() !== fieldKey.toLowerCase())
          : [...current, fieldKey];
        const nextTriageState =
          !exists && r.triageState === "resolved"
            ? "needs_review"
            : r.triageState;
        return {
          ...r,
          manualFlaggedFields: nextManual,
          triageState: nextTriageState,
        };
      })
    );
  };

  const investigateSingleRecord = async (
    recordId: string,
    scope: "target" | "all" = "target",
    latestRecords?: InstitutionRecord[],
    commentOverride?: string
  ) => {
    const sourceList = latestRecords ?? records;
    const target = sourceList.find((r) => r.id === recordId);
    if (!target) return;

    const effectiveHint =
      commentOverride !== undefined ? commentOverride : target.researcherHint;

    const verifiable = mappings.filter((m) => m.verifyEnabled);
    if (verifiable.length === 0) {
      setRecords((prev) =>
        prev.map((r) =>
          r.id === recordId
            ? {
                ...r,
                triageState: "api_error",
                errorMessage:
                  "No verifiable fields are enabled in Schema Mapping. Enable at least one field in Import & Schema.",
              }
            : r
        )
      );
      return;
    }

    const enrichedTargetFields = verifiable.map((m) => {
      const origVal = stringifyFieldValue((target.initialRaw ?? target.raw)[m.key]);
      const currentVal = stringifyFieldValue(target.raw[m.key]);
      const isEligibleTarget = isFieldEligibleForReinvestigation(
        target,
        m.key,
        origVal
      );
      const priorVerdict = getPriorVerdictForField(target, m.key);
      return {
        key: m.key,
        role: m.role,
        currentValue: currentVal,
        promptHint: m.promptHint,
        isFlagged: isEligibleTarget,
        priorVerdictStatus: priorVerdict?.status,
        priorVerdictRationale: priorVerdict?.rationale,
      };
    });

    const flaggedOnly = enrichedTargetFields.filter((f) => f.isFlagged);
    const fieldsToVerify =
      scope === "target" && flaggedOnly.length > 0
        ? flaggedOnly
        : enrichedTargetFields;

    const contextKeys = [
      "type",
      "category",
      "ownership",
      "town",
      "county",
      "region",
      "location",
      "phone",
      "email",
      "accreditations",
    ];
    const institutionContext: Record<string, string> = {};
    for (const ck of contextKeys) {
      const val = stringifyFieldValue(target.raw[ck]).trim();
      if (val && val !== "[]" && val !== "{}") {
        institutionContext[ck] = val.length > 400 ? `${val.slice(0, 400)}...` : val;
      }
    }

    const socialVal = stringifyFieldValue(target.raw.social_media).trim();
    if (socialVal && socialVal !== "[]") {
      institutionContext.known_social_media =
        socialVal.length > 600 ? `${socialVal.slice(0, 600)}...` : socialVal;
    }

    const extractUrlsFromJsonText = (rawVal: unknown): string[] => {
      const text = stringifyFieldValue(rawVal);
      if (!text) return [];
      return Array.from(
        new Set(text.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? [])
      );
    };
    const rowUrls = Array.from(
      new Set([
        ...extractUrlsFromJsonText(target.raw.institution_sources),
        ...extractUrlsFromJsonText(target.raw.other_sources),
        ...extractUrlsFromJsonText(target.raw.sources),
      ])
    ).slice(0, 12);
    if (rowUrls.length > 0) {
      institutionContext.known_row_sources = rowUrls.join(", ");
    }

    const aboutVal = stringifyFieldValue(target.raw.about).trim();
    if (aboutVal) {
      institutionContext.about_summary =
        aboutVal.length > 350 ? `${aboutVal.slice(0, 350)}...` : aboutVal;
    }

    // Cancel any existing in-flight request for this record
    investigateControllersRef.current.get(recordId)?.abort();
    const controller = new AbortController();
    investigateControllersRef.current.set(recordId, controller);
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 80000);

    setRecords((prev) =>
      prev.map((r) =>
        r.id === recordId
          ? {
              ...r,
              researcherHint: effectiveHint,
              triageState: "investigating",
              errorMessage: undefined,
            }
          : r
      )
    );

    try {
      const response = await fetch("/api/verify-institution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          institutionName: target.displayName,
          websiteUrl: target.websiteUrl,
          locationLabel: target.locationLabel,
          institutionContext,
          priorStatus: target.priorStatus,
          priorNote: target.priorNote,
          flaggedFields: fieldsToVerify.map((f) => f.key),
          researcherHint: effectiveHint,
          model: selectedModel,
          capabilities,
          targetFields: fieldsToVerify,
        }),
      });

      const rawRespText = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = rawRespText ? JSON.parse(rawRespText) : {};
      } catch {
        throw new Error(
          `Server returned non-JSON response (${response.status}): ${rawRespText.slice(0, 180)}`
        );
      }

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" && data.error
            ? data.error
            : `Verification failed (${response.status})`
        );
      }

      const verified = data as unknown as VerifyInstitutionResponse;
      const chunkFieldResults: Record<string, FieldVerificationResult> = {};
      const normKey = (k: string) =>
        k.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const missingFields: string[] = [];

      for (const targetField of fieldsToVerify) {
        const originalValue = stringifyFieldValue(
          (target.initialRaw ?? target.raw)[targetField.key]
        );
        const agentField =
          verified.fields.find(
            (f) =>
              f.fieldKey.trim().toLowerCase() ===
              targetField.key.trim().toLowerCase()
          ) ??
          verified.fields.find(
            (f) => normKey(f.fieldKey) === normKey(targetField.key)
          );

        if (agentField) {
          const proposed = agentField.verifiedValue.trim();
          const origTrimmed = originalValue.trim();
          let normalizedStatus: FieldVerificationStatus = agentField.status;

          let semanticallyEqual = proposed === origTrimmed;
          if (
            !semanticallyEqual &&
            (proposed.startsWith("[") || proposed.startsWith("{")) &&
            (origTrimmed.startsWith("[") || origTrimmed.startsWith("{"))
          ) {
            try {
              semanticallyEqual =
                JSON.stringify(JSON.parse(proposed)) ===
                JSON.stringify(JSON.parse(origTrimmed));
            } catch {
              semanticallyEqual = false;
            }
          }

          if (proposed !== "" && !semanticallyEqual) {
            normalizedStatus =
              origTrimmed === "" || origTrimmed === "[]"
                ? "resolved_missing"
                : "discrepancy";
          } else if (semanticallyEqual && origTrimmed !== "") {
            normalizedStatus = "match";
          }

          chunkFieldResults[targetField.key] = {
            fieldKey: targetField.key,
            originalValue,
            priorFlagged: targetField.isFlagged,
            verifiedValue: agentField.verifiedValue,
            status: normalizedStatus,
            confidence: agentField.confidence,
            reasoning: agentField.reasoning,
            evidenceSnippet: agentField.evidenceSnippet,
            sourceUrls: agentField.sourceUrls,
            decision: "pending",
            finalValue: originalValue,
          };
        } else {
          missingFields.push(targetField.key);
          chunkFieldResults[targetField.key] = {
            fieldKey: targetField.key,
            originalValue,
            priorFlagged: targetField.isFlagged,
            verifiedValue: "",
            status: "still_unverified",
            confidence: "low",
            reasoning:
              "Model response omitted this field during multi-field verification. Click Retry or edit manually.",
            evidenceSnippet: "",
            sourceUrls: [],
            decision: "pending",
            finalValue: originalValue,
          };
        }
      }

      const warningParts: string[] = [];
      if (Array.isArray(verified.warnings) && verified.warnings.length > 0) {
        warningParts.push(...verified.warnings);
      }
      if (missingFields.length > 0) {
        const missingMsg = `Missing field result(s): ${missingFields.join(", ")}.`;
        if (!warningParts.some((w) => w.includes(missingFields[0]))) {
          warningParts.push(missingMsg);
        }
      }
      const nonSilentWarning =
        warningParts.length > 0 ? warningParts.join(" ") : undefined;

      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          const mergedFieldResults: Record<string, FieldVerificationResult> = {
            ...r.fieldResults,
            ...chunkFieldResults,
          };
          const seenSourceUris = new Set<string>();
          const mergedSources = [...verified.sources, ...r.sources].filter(
            (src) => {
              if (!src.uri || seenSourceUris.has(src.uri)) return false;
              seenSourceUris.add(src.uri);
              return true;
            }
          );
          return {
            ...r,
            triageState: "needs_review",
            lastVerifiedAt: verified.verifiedAt,
            summaryNote: verified.executiveSummary,
            discoveredOfficialUrl:
              verified.discoveredOfficialUrl || r.discoveredOfficialUrl,
            sources: mergedSources,
            fieldResults: mergedFieldResults,
            errorMessage: nonSilentWarning,
          };
        })
      );

      if (selectedRecordId === recordId && fieldsToVerify[0]) {
        setSelectedFieldKey(fieldsToVerify[0].key);
      }
    } catch (err) {
      const isAbort =
        err instanceof DOMException
          ? err.name === "AbortError"
          : err instanceof Error && err.name === "AbortError";

      if (isAbort && !timedOut) {
        setRecords((prev) =>
          prev.map((r) => {
            if (r.id !== recordId) return r;
            const hasResults = Object.keys(r.fieldResults).length > 0;
            return {
              ...r,
              triageState: hasResults ? "needs_review" : "unresolved",
              errorMessage: "Investigation cancelled.",
            };
          })
        );
      } else {
        const msg = timedOut
          ? "Investigation timed out after 80s (multi-field or slow source site). Click Retry or try a faster model."
          : err instanceof Error
          ? err.message
          : "Failed to verify institution.";
        setRecords((prev) =>
          prev.map((r) =>
            r.id === recordId
              ? { ...r, triageState: "api_error", errorMessage: msg }
              : r
          )
        );
      }
    } finally {
      clearTimeout(timeoutId);
      if (investigateControllersRef.current.get(recordId) === controller) {
        investigateControllersRef.current.delete(recordId);
      }
    }
  };

  const handleCancelInvestigation = (recordId: string) => {
    const ctrl = investigateControllersRef.current.get(recordId);
    if (ctrl) {
      ctrl.abort();
      investigateControllersRef.current.delete(recordId);
    } else {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId || r.triageState !== "investigating") return r;
          const hasResults = Object.keys(r.fieldResults).length > 0;
          return {
            ...r,
            triageState: hasResults ? "needs_review" : "unresolved",
            errorMessage: "Investigation cancelled.",
          };
        })
      );
    }
  };

  const handleRunUnresolvedBatch = async (limit: BatchLimitOption) => {
    const queue = records.filter(
      (r) => r.triageState === "unresolved" || r.triageState === "api_error"
    );
    if (queue.length === 0) return;

    const batch = limit === "all" ? queue : queue.slice(0, limit);

    batchAbortRef.current = false;
    setIsBatchRunning(true);
    setBatchProgress({ current: 0, total: batch.length });

    for (let i = 0; i < batch.length; i++) {
      if (batchAbortRef.current) break;
      const item = batch[i];
      setSelectedRecordId(item.id);
      setBatchProgress({ current: i + 1, total: batch.length });
      await investigateSingleRecord(item.id, "target");
    }

    setIsBatchRunning(false);
    setBatchProgress(null);
  };

  const handleStopBatch = () => {
    batchAbortRef.current = true;
    for (const ctrl of investigateControllersRef.current.values()) {
      ctrl.abort();
    }
    investigateControllersRef.current.clear();
    setIsBatchRunning(false);
  };

  const handleFieldDecision = (
    recordId: string,
    fieldKey: string,
    decision: FieldDecision,
    editedValue?: string
  ) => {
    setRecords((prev) =>
      prev.map((r) => {
        if (r.id !== recordId) return r;
        const existing = r.fieldResults[fieldKey];
        const originalValue = stringifyFieldValue(
          (r.initialRaw ?? r.raw)[fieldKey]
        );

        const baseResult: FieldVerificationResult = existing ?? {
          fieldKey,
          originalValue,
          priorFlagged: Boolean(getFieldNeedReason(r, fieldKey, originalValue)),
          verifiedValue: editedValue ?? originalValue,
          status: "match",
          confidence: "high",
          reasoning: "Manually verified by researcher.",
          evidenceSnippet: "",
          sourceUrls: [],
          decision,
          finalValue: editedValue ?? originalValue,
        };

        let finalValue = baseResult.finalValue;
        if (decision === "accepted") {
          finalValue = baseResult.verifiedValue || baseResult.originalValue;
        } else if (decision === "kept_original") {
          finalValue = baseResult.originalValue;
        } else if (decision === "edited" && editedValue !== undefined) {
          finalValue = editedValue;
        }

        const updatedResults: Record<string, FieldVerificationResult> = {
          ...r.fieldResults,
          [fieldKey]: {
            ...baseResult,
            decision,
            finalValue,
          },
        };

        const nextRaw = { ...r.raw, [fieldKey]: finalValue };
        const nextManualFlags =
          decision === "pending"
            ? r.manualFlaggedFields
            : (r.manualFlaggedFields ?? []).filter(
                (f) => f.toLowerCase() !== fieldKey.toLowerCase()
              );

        const candidateRecord: InstitutionRecord = {
          ...r,
          raw: nextRaw,
          fieldResults: updatedResults,
          manualFlaggedFields: nextManualFlags,
        };

        const verifiable = mappings.filter((m) => m.verifyEnabled);
        const anyNeedsVerificationPending = verifiable.some((m) => {
          const orig = stringifyFieldValue((r.initialRaw ?? r.raw)[m.key]);
          return isFieldEligibleForReinvestigation(candidateRecord, m.key, orig);
        });

        const updatedRecord: InstitutionRecord = {
          ...candidateRecord,
          triageState: anyNeedsVerificationPending ? "needs_review" : "resolved",
        };

        if (!anyNeedsVerificationPending) {
          if (queueFilter === "unresolved" || queueFilter === "needs_review") {
            justResolvedRef.current = {
              id: recordId,
              rowIndex: r.rowIndex,
              name: r.displayName,
            };
          }
          return commitRecordSaveAndVerify(updatedRecord, updatedResults);
        }

        return updatedRecord;
      })
    );
  };

  const handleConfirmSelectedFields = (
    recordId: string,
    selectedKeys: string[]
  ) => {
    const selectedSet = new Set(selectedKeys.map((k) => k.toLowerCase()));
    if (selectedSet.size === 0) return;

    setRecords((prev) =>
      prev.map((r) => {
        if (r.id !== recordId) return r;
        const nextResults: Record<string, FieldVerificationResult> = {};
        const nextRaw: Record<string, unknown> = { ...r.raw };

        for (const [key, res] of Object.entries(r.fieldResults)) {
          if (res.decision === "pending" && selectedSet.has(key.toLowerCase())) {
            if (res.verifiedValue.trim() !== "") {
              nextResults[key] = {
                ...res,
                decision: "accepted",
                finalValue: res.verifiedValue,
              };
              nextRaw[key] = res.verifiedValue;
            } else {
              nextResults[key] = {
                ...res,
                decision: "kept_original",
                finalValue: res.originalValue,
              };
              nextRaw[key] = res.originalValue;
            }
          } else {
            nextResults[key] = res;
          }
        }

        const nextManualFlags = (r.manualFlaggedFields ?? []).filter(
          (f) => !selectedSet.has(f.toLowerCase())
        );

        const candidateRecord: InstitutionRecord = {
          ...r,
          raw: nextRaw,
          fieldResults: nextResults,
          manualFlaggedFields: nextManualFlags,
        };

        const verifiable = mappings.filter((m) => m.verifyEnabled);
        const anyNeedsVerificationPending = verifiable.some((m) => {
          const orig = stringifyFieldValue((r.initialRaw ?? r.raw)[m.key]);
          return isFieldEligibleForReinvestigation(candidateRecord, m.key, orig);
        });

        const updatedRecord: InstitutionRecord = {
          ...candidateRecord,
          triageState: anyNeedsVerificationPending ? "needs_review" : "resolved",
        };

        if (!anyNeedsVerificationPending) {
          if (queueFilter === "unresolved" || queueFilter === "needs_review") {
            justResolvedRef.current = {
              id: recordId,
              rowIndex: r.rowIndex,
              name: r.displayName,
            };
          }
          return commitRecordSaveAndVerify(updatedRecord, nextResults);
        }

        return updatedRecord;
      })
    );
  };

  const handleSaveAndVerifyCase = (recordId: string) => {
    setRecords((prev) =>
      prev.map((r) => {
        if (r.id !== recordId) return r;
        const finalizedResults: Record<string, FieldVerificationResult> = {};
        for (const [key, res] of Object.entries(r.fieldResults)) {
          if (res.decision === "pending") {
            finalizedResults[key] = {
              ...res,
              decision: "kept_original",
              finalValue: res.originalValue,
            };
          } else {
            finalizedResults[key] = res;
          }
        }
        if (queueFilter === "unresolved" || queueFilter === "needs_review") {
          justResolvedRef.current = {
            id: recordId,
            rowIndex: r.rowIndex,
            name: r.displayName,
          };
        }
        return commitRecordSaveAndVerify(r, finalizedResults);
      })
    );
  };

  const filteredQueueRecords = useMemo(
    () =>
      records.filter((r) => matchesQueueFilter(r, queueFilter, searchQuery)),
    [records, queueFilter, searchQuery]
  );

  useEffect(() => {
    const resolvedMeta = justResolvedRef.current;
    if (!resolvedMeta) return;
    justResolvedRef.current = null;

    if (queueFilter !== "unresolved" && queueFilter !== "needs_review") return;

    const nextItem =
      filteredQueueRecords.find((r) => r.rowIndex > resolvedMeta.rowIndex) ??
      filteredQueueRecords[0] ??
      null;

    setSelectedRecordId(nextItem?.id ?? null);
    setSelectedFieldKey(null);
    setAdvanceNotice(
      nextItem
        ? `Verified "${resolvedMeta.name}" — moved to next entry (${filteredQueueRecords.length} remaining).`
        : `Verified "${resolvedMeta.name}" — all matching entries in this view are complete.`
    );
  }, [records, queueFilter, filteredQueueRecords]);

  useEffect(() => {
    if (!advanceNotice) return;
    const timer = setTimeout(() => setAdvanceNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [advanceNotice]);

  const selectedRecord =
    filteredQueueRecords.find((r) => r.id === selectedRecordId) ??
    filteredQueueRecords[0] ??
    null;

  const resolvedCount = records.filter(
    (r) => r.triageState === "resolved"
  ).length;

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#0B0F17] text-slate-100">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        hasRecords={records.length > 0}
      />

      {activeTab === "import" && (
        <ImportSchemaView
          datasetMeta={datasetMeta}
          firstRow={records[0]?.raw ?? null}
          totalRows={records.length}
          mappings={mappings}
          unresolvedRules={unresolvedRules}
          previewRecords={records}
          onImportText={handleImportText}
          onUpdateMappings={handleUpdateMappings}
          onUpdateRules={handleUpdateRules}
          onProceedToTriage={() => {
            const firstUnresolved = records.find(
              (r) =>
                r.triageState === "unresolved" ||
                r.triageState === "needs_review"
            );
            if (firstUnresolved) {
              setSelectedRecordId(firstUnresolved.id);
              setQueueFilter("unresolved");
            }
            setActiveTab("triage");
          }}
          onResetWorkspace={handleResetWorkspace}
        />
      )}

      {activeTab === "triage" && (
        <>
          {records.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md text-center space-y-4 p-8 rounded-md border border-slate-800 bg-[#111827]">
                <h2 className="font-display text-lg font-semibold text-slate-100">
                  No Institutional Dataset Loaded
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Import your CSV/JSON database export or load the workspace <span className="font-mono text-slate-300">institutions.csv</span> file to start triaging flagged profiles.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab("import")}
                  className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors cursor-pointer"
                >
                  Go to Import &amp; Schema
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex overflow-hidden">
              <QueueSidebar
                records={records}
                selectedId={selectedRecord?.id ?? null}
                filter={queueFilter}
                searchQuery={searchQuery}
                unresolvedRules={unresolvedRules}
                isBatchRunning={isBatchRunning}
                batchProgress={batchProgress}
                onSelectRecord={(id) => {
                  setSelectedRecordId(id);
                  setSelectedFieldKey(null);
                }}
                onChangeFilter={setQueueFilter}
                onChangeSearch={setSearchQuery}
                onRunUnresolvedBatch={handleRunUnresolvedBatch}
                onStopBatch={handleStopBatch}
                onOpenFilterSettings={() => setActiveTab("import")}
              />

              {selectedRecord ? (
                <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
                  {advanceNotice && (
                    <div className="px-6 py-2 bg-emerald-950/35 border-b border-emerald-900/60 text-xs text-emerald-200 flex items-center justify-between gap-3 shrink-0">
                      <span>{advanceNotice}</span>
                      <button
                        type="button"
                        onClick={() => setAdvanceNotice(null)}
                        className="text-[11px] text-emerald-400 hover:text-emerald-200 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  <div className="flex-1 min-h-0 flex overflow-hidden">
                    <DiffWorkspace
                      record={selectedRecord}
                      mappings={mappings}
                      capabilities={capabilities}
                      selectedModel={selectedModel}
                      selectedFieldKey={selectedFieldKey}
                      onChangeModel={setSelectedModel}
                      onToggleCapability={handleToggleCapability}
                      onSelectField={setSelectedFieldKey}
                      onUpdateHint={handleUpdateHint}
                      onToggleManualFlag={handleToggleManualFlag}
                      onInvestigateRecord={(recordId, scope, comment) =>
                        investigateSingleRecord(
                          recordId,
                          scope,
                          undefined,
                          comment
                        )
                      }
                      onCancelInvestigation={handleCancelInvestigation}
                      onFieldDecision={handleFieldDecision}
                      onConfirmSelectedFields={handleConfirmSelectedFields}
                      onSaveAndVerifyCase={handleSaveAndVerifyCase}
                    />

                    <EvidencePane
                      record={selectedRecord}
                      selectedFieldKey={selectedFieldKey}
                      isCollapsed={isEvidenceCollapsed}
                      onToggleCollapse={() =>
                        setIsEvidenceCollapsed((prev) => !prev)
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center p-8 bg-[#0B0F17]">
                  <div className="max-w-md text-center space-y-4 p-8 rounded-md border border-slate-800 bg-[#111827]">
                    <h2 className="font-display text-lg font-semibold text-slate-100">
                      {queueFilter === "unresolved" ||
                      queueFilter === "needs_review"
                        ? "Queue Complete"
                        : "No Matching Entries"}
                    </h2>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {queueFilter === "unresolved" ||
                      queueFilter === "needs_review"
                        ? `All entries in this view have been processed. ${resolvedCount} verified institution(s) are ready in the Verified tab and Export Center.`
                        : "No institutions match the current tab or search query."}
                    </p>
                    <div className="flex items-center justify-center gap-2.5">
                      {resolvedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setQueueFilter("resolved")}
                          className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-slate-700 rounded-md hover:border-slate-600 transition-colors cursor-pointer"
                        >
                          View Verified ({resolvedCount})
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveTab("export")}
                        className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors cursor-pointer"
                      >
                        Go to Export Center
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {activeTab === "export" && (
        <ExportView
          datasetMeta={datasetMeta}
          records={records}
          mappings={mappings}
          unresolvedRules={unresolvedRules}
          onBackToTriage={() => setActiveTab("triage")}
        />
      )}
    </div>
  );
}
