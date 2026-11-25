import React, { useEffect, useRef, useState } from "react";
import {
  Play,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  XCircle,
  ExternalLink,
  Check,
  X,
  Pencil,
  Sparkles,
  Globe,
  Building2,
  ShieldCheck,
  Flag,
  Save,
  Cpu,
  ChevronUp,
  ChevronDown,
  MessageSquare,
} from "lucide-react";
import type {
  FieldDecision,
  FieldMapping,
  FieldVerificationResult,
  FieldVerificationStatus,
  GeminiModelId,
  InstitutionRecord,
  VerificationCapabilities,
} from "../types";
import {
  getFieldNeedReason,
  getPriorVerdictForField,
  isFieldEligibleForReinvestigation,
  stringifyFieldValue,
} from "../utils/dataParser";

interface DiffWorkspaceProps {
  record: InstitutionRecord;
  mappings: FieldMapping[];
  capabilities: VerificationCapabilities;
  selectedModel: GeminiModelId;
  selectedFieldKey: string | null;
  onChangeModel: (model: GeminiModelId) => void;
  onToggleCapability: (cap: keyof VerificationCapabilities) => void;
  onSelectField: (fieldKey: string) => void;
  onUpdateHint: (recordId: string, hint: string) => void;
  onToggleManualFlag: (recordId: string, fieldKey: string) => void;
  onInvestigateRecord: (
    recordId: string,
    scope: "target" | "all",
    comment?: string
  ) => void;
  onCancelInvestigation: (recordId: string) => void;
  onFieldDecision: (
    recordId: string,
    fieldKey: string,
    decision: FieldDecision,
    editedValue?: string
  ) => void;
  onConfirmSelectedFields: (recordId: string, fieldKeys: string[]) => void;
  onSaveAndVerifyCase: (recordId: string) => void;
}

const MODEL_OPTIONS: Array<{ id: GeminiModelId; label: string }> = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (Default)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "gemini-4-neon", label: "Gemini 4 Neon" },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
];

function formatCellPreview(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return "";
  if (trimmed.length > 12000) {
    return `${trimmed.slice(0, 12000)}…`;
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) return "[]";
        if (parsed.every((item) => typeof item !== "object" || item === null)) {
          return parsed.map((x) => `• ${String(x)}`).join("\n");
        }
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return val;
    }
  }
  return val;
}

function getRowSavedFieldSources(
  raw: Record<string, unknown>,
  fieldKey: string
): string[] {
  const rawSources = raw.sources;
  if (!rawSources) return [];
  let obj: Record<string, unknown> | null = null;
  if (typeof rawSources === "string" && rawSources.trim().startsWith("{")) {
    try {
      obj = JSON.parse(rawSources) as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (typeof rawSources === "object" && !Array.isArray(rawSources)) {
    obj = rawSources as Record<string, unknown>;
  }
  if (!obj) return [];
  const val = obj[fieldKey];
  if (typeof val === "string" && /^https?:\/\//i.test(val)) return [val];
  if (Array.isArray(val)) {
    return val.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  }
  return [];
}

function getFieldStatusVisual(status: FieldVerificationStatus): {
  label: string;
  textClass: string;
  Icon: React.FC<{ className?: string }>;
} {
  switch (status) {
    case "match":
      return {
        label: "Verified Match",
        textClass: "text-emerald-400",
        Icon: CheckCircle2,
      };
    case "discrepancy":
      return {
        label: "New Value Found",
        textClass: "text-amber-400",
        Icon: AlertTriangle,
      };
    case "resolved_missing":
      return {
        label: "Missing Value Found",
        textClass: "text-sky-400",
        Icon: Sparkles,
      };
    case "still_unverified":
      return {
        label: "Needs Manual Check",
        textClass: "text-rose-400",
        Icon: HelpCircle,
      };
  }
}

export const DiffWorkspace: React.FC<DiffWorkspaceProps> = ({
  record,
  mappings,
  capabilities,
  selectedModel,
  selectedFieldKey,
  onChangeModel,
  onToggleCapability,
  onSelectField,
  onUpdateHint,
  onToggleManualFlag,
  onInvestigateRecord,
  onCancelInvestigation,
  onFieldDecision,
  onConfirmSelectedFields,
  onSaveAndVerifyCase,
}) => {
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [selectedConfirmMap, setSelectedConfirmMap] = useState<
    Record<string, boolean>
  >({});
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const verifiableFields = mappings.filter((m) => m.verifyEnabled);

  const enrichedFields = verifiableFields.map((mapping) => {
    const initialValue = stringifyFieldValue(
      (record.initialRaw ?? record.raw)[mapping.key]
    );
    const currentValue = stringifyFieldValue(record.raw[mapping.key]);
    const needReason = getFieldNeedReason(record, mapping.key, initialValue);
    const priorVerdict = getPriorVerdictForField(record, mapping.key);
    const result: FieldVerificationResult | undefined =
      record.fieldResults[mapping.key];
    const hasResult = Boolean(result);
    const isEligibleTarget = isFieldEligibleForReinvestigation(
      record,
      mapping.key,
      initialValue
    );
    return {
      mapping,
      initialValue,
      currentValue,
      needReason,
      priorVerdict,
      needsVerification: Boolean(needReason) || hasResult,
      isPendingTarget: isEligibleTarget,
      result,
    };
  });

  const pendingTargetCount = enrichedFields.filter(
    (f) => f.isPendingTarget
  ).length;
  const needsVerificationCount = enrichedFields.filter(
    (f) => f.needsVerification
  ).length;

  const [fieldFilter, setFieldFilter] = useState<"all" | "needs_verification">(
    needsVerificationCount > 0 ? "needs_verification" : "all"
  );

  // Reset filter view & checkbox overrides when switching to a different institution
  useEffect(() => {
    setFieldFilter(needsVerificationCount > 0 ? "needs_verification" : "all");
    setEditingFieldKey(null);
    setSelectedConfirmMap({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id]);

  // Sort fields that need verification or have session audit results first
  const sortedFields = [...enrichedFields].sort((a, b) => {
    if (a.needsVerification !== b.needsVerification) {
      return a.needsVerification ? -1 : 1;
    }
    return 0;
  });

  const visibleFields =
    fieldFilter === "needs_verification"
      ? sortedFields.filter((f) => f.needsVerification)
      : sortedFields;

  const isInvestigating = record.triageState === "investigating";
  const hasFieldResults = Object.keys(record.fieldResults).length > 0;

  useEffect(() => {
    if (isInvestigating) {
      setSelectedConfirmMap({});
    }
  }, [isInvestigating]);

  const pendingConfirmKeys = Object.values(record.fieldResults)
    .filter((r) => r.decision === "pending")
    .map((r) => r.fieldKey);

  // All pending investigated fields are selected by default unless unchecked by user
  const checkedPendingKeys = pendingConfirmKeys.filter(
    (key) => selectedConfirmMap[key] !== false
  );
  const allPendingChecked =
    pendingConfirmKeys.length > 0 &&
    checkedPendingKeys.length === pendingConfirmKeys.length;
  const somePendingChecked =
    checkedPendingKeys.length > 0 &&
    checkedPendingKeys.length < pendingConfirmKeys.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePendingChecked;
    }
  }, [somePendingChecked]);

  const toggleAllPending = () => {
    const nextState = !allPendingChecked;
    const nextMap: Record<string, boolean> = {};
    for (const k of pendingConfirmKeys) {
      nextMap[k] = nextState;
    }
    setSelectedConfirmMap(nextMap);
  };

  const toggleFieldConfirmCheck = (fieldKey: string) => {
    setSelectedConfirmMap((prev) => ({
      ...prev,
      [fieldKey]: prev[fieldKey] === false ? true : false,
    }));
  };

  const confirmedCount = Object.values(record.fieldResults).filter(
    (r) =>
      r.decision === "accepted" ||
      r.decision === "edited" ||
      r.decision === "kept_original"
  ).length;

  const startManualEdit = (fieldKey: string, currentVal: string) => {
    setEditingFieldKey(fieldKey);
    setEditDraft(currentVal);
  };

  const commitManualEdit = (fieldKey: string) => {
    onFieldDecision(record.id, fieldKey, "edited", editDraft);
    setEditingFieldKey(null);
  };

  const displayWebsite = record.discoveredOfficialUrl || record.websiteUrl;
  const safeHref =
    displayWebsite && /^https?:\/\//i.test(displayWebsite)
      ? displayWebsite
      : displayWebsite
      ? `https://${displayWebsite}`
      : "";

  const manualFlaggedSet = new Set(
    (record.manualFlaggedFields ?? []).map((f) => f.toLowerCase())
  );

  return (
    <main className="flex-1 min-w-0 flex flex-col h-full bg-[#0B0F17] overflow-hidden">
      {/* Institution Context Header (Collapsible) */}
      <div
        className={`px-6 border-b border-slate-800 bg-[#0F1521]/60 shrink-0 ${
          isHeaderCollapsed
            ? "py-2.5 space-y-2"
            : "py-4 space-y-2.5 max-h-[42%] overflow-y-auto"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 min-w-0">
              <h1 className="font-display text-lg font-bold text-slate-100 tracking-tight truncate">
                {record.displayName}
              </h1>
              {isHeaderCollapsed && (
                <span className="font-mono tabular-nums text-xs text-slate-400 shrink-0">
                  Row #{record.rowIndex + 1}
                </span>
              )}
              {isHeaderCollapsed && record.savedEvidence && (
                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 shrink-0">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {record.savedEvidence.newVerificationStatus}
                </span>
              )}
            </div>
            {!isHeaderCollapsed && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span className="font-mono tabular-nums shrink-0">
                  Row #{record.rowIndex + 1}
                </span>
                {record.locationLabel && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="truncate max-w-[300px]"
                      title={record.locationLabel}
                    >
                      {record.locationLabel}
                    </span>
                  </>
                )}
                {record.priorStatus && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="font-mono text-slate-300 truncate max-w-[420px]"
                      title={record.priorStatus}
                    >
                      {record.priorStatus}
                    </span>
                  </>
                )}
                {safeHref && (
                  <>
                    <span aria-hidden="true">·</span>
                    <a
                      href={safeHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-sky-400 hover:text-sky-300 shrink-0"
                    >
                      <span className="truncate max-w-[220px]">
                        {displayWebsite}
                      </span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {hasFieldResults && pendingConfirmKeys.length > 0 && (
              <button
                type="button"
                disabled={checkedPendingKeys.length === 0}
                onClick={() =>
                  onConfirmSelectedFields(record.id, checkedPendingKeys)
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-sky-200 bg-[#111827] border border-sky-700/80 rounded-md hover:bg-sky-950/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Check className="w-3.5 h-3.5 text-sky-400" />
                Confirm Selected ({checkedPendingKeys.length}/
                {pendingConfirmKeys.length})
              </button>
            )}

            {hasFieldResults &&
              confirmedCount > 0 &&
              record.triageState !== "resolved" && (
                <button
                  type="button"
                  onClick={() => onSaveAndVerifyCase(record.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Updates &amp; Verify Status
                </button>
              )}

            {isInvestigating ? (
              <div className="inline-flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-sky-600/60 rounded-md cursor-not-allowed whitespace-nowrap"
                >
                  <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  Investigating...
                </button>
                <button
                  type="button"
                  onClick={() => onCancelInvestigation(record.id)}
                  className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-rose-200 bg-rose-950/60 border border-rose-800/80 hover:bg-rose-900/60 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                  title="Cancel active investigation"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() =>
                  onInvestigateRecord(
                    record.id,
                    pendingTargetCount > 0 ? "target" : "all",
                    record.researcherHint
                  )
                }
                title={
                  hasFieldResults && pendingTargetCount > 0
                    ? `Re-investigate only the ${pendingTargetCount} unverified/flagged field(s)`
                    : undefined
                }
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {hasFieldResults ? (
                  <>
                    <RotateCw className="w-3.5 h-3.5" />
                    {pendingTargetCount > 0
                      ? `Re-investigate Unverified (${pendingTargetCount})`
                      : "Re-investigate All Fields"}
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    {pendingTargetCount > 0
                      ? `Investigate Target Fields (${pendingTargetCount})`
                      : "Investigate All Fields"}
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsHeaderCollapsed((prev) => !prev)}
              title={isHeaderCollapsed ? "Expand Header" : "Collapse Header"}
              aria-label={
                isHeaderCollapsed ? "Expand Header" : "Collapse Header"
              }
              className="inline-flex items-center gap-1 px-2 py-2 text-xs text-slate-300 bg-[#111827] border border-slate-700 rounded-md hover:text-white hover:border-slate-600 transition-colors cursor-pointer shrink-0"
            >
              {isHeaderCollapsed ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Compact Re-investigation Comment Bar when Header is Collapsed */}
        {isHeaderCollapsed && hasFieldResults && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <MessageSquare className="w-3.5 h-3.5 text-sky-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={record.researcherHint}
                onChange={(e) => onUpdateHint(record.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isInvestigating) {
                    onInvestigateRecord(
                      record.id,
                      pendingTargetCount > 0 ? "target" : "all",
                      record.researcherHint
                    );
                  }
                }}
                placeholder="Optional comment for re-investigation (press Enter to run)..."
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-[#0B0F17] border border-slate-800 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
              />
              {record.researcherHint && (
                <button
                  type="button"
                  onClick={() => onUpdateHint(record.id, "")}
                  title="Clear comment"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Non-silent Error / Partial Warning Alert (always visible even when header collapsed) */}
        {record.errorMessage && (
          <div
            role="alert"
            className="px-3.5 py-2.5 bg-rose-950/40 border border-rose-900/70 rounded text-xs text-rose-200 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2 min-w-0">
              <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="break-words">{record.errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                onInvestigateRecord(
                  record.id,
                  pendingTargetCount > 0 ? "target" : "all",
                  record.researcherHint
                )
              }
              className="px-2.5 py-1 text-[11px] font-medium bg-rose-900/60 hover:bg-rose-900 rounded text-rose-100 shrink-0 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {!isHeaderCollapsed && (
          <>
            {/* Saved Verification Confirmation Banner */}
            {record.savedEvidence && (
              <div className="px-3.5 py-2.5 bg-emerald-950/30 border border-emerald-800/70 rounded text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    Verification status updated from{" "}
                    <span className="font-mono text-amber-300">
                      {record.savedEvidence.previousVerificationStatus ||
                        "flagged"}
                    </span>{" "}
                    to{" "}
                    <span className="font-mono text-emerald-300 font-semibold">
                      {record.savedEvidence.newVerificationStatus}
                    </span>
                    {" · "}
                    {record.savedEvidence.entries.length} field decision(s) and{" "}
                    {record.savedEvidence.allSourceUrls.length} evidence
                    citation(s) saved.
                  </span>
                </div>
                <span className="font-mono tabular-nums text-[11px] text-emerald-400">
                  {new Date(record.savedEvidence.savedAt).toLocaleTimeString()}
                </span>
              </div>
            )}

            {/* Target Fields Summary Strip */}
            {needsVerificationCount > 0 && (
              <div
                className={`px-3.5 py-2 bg-[#111827] rounded text-xs flex flex-wrap items-center gap-2 border ${
                  pendingTargetCount === 0
                    ? "border-emerald-900/50"
                    : "border-amber-900/50"
                }`}
              >
                <span
                  className={`inline-flex items-center gap-1.5 font-semibold shrink-0 ${
                    pendingTargetCount === 0
                      ? "text-emerald-400"
                      : "text-amber-400"
                  }`}
                >
                  {pendingTargetCount === 0 ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5" />
                  )}
                  {pendingTargetCount === 0
                    ? `All Target Fields Confirmed (${needsVerificationCount}):`
                    : `Remaining to Verify (${pendingTargetCount}):`}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {enrichedFields
                    .filter((f) => f.needsVerification)
                    .map((f) => {
                      const isDone = !f.isPendingTarget;
                      return (
                        <button
                          key={f.mapping.key}
                          type="button"
                          onClick={() => {
                            setFieldFilter("needs_verification");
                            onSelectField(f.mapping.key);
                          }}
                          title={
                            isDone
                              ? `${f.mapping.key} confirmed (will be skipped on re-investigate unless flagged)`
                              : `${f.mapping.key} unverified (will be sent on re-investigate)`
                          }
                          className={`inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[11px] rounded border transition-colors cursor-pointer ${
                            selectedFieldKey === f.mapping.key
                              ? isDone
                                ? "bg-emerald-950/70 border-emerald-500 text-emerald-200"
                                : "bg-amber-950/70 border-amber-500 text-amber-200"
                              : isDone
                              ? "bg-emerald-950/25 border-emerald-800/60 text-emerald-300/90 hover:border-emerald-600/80"
                              : "bg-[#0B0F17] border-amber-800/60 text-amber-200 hover:border-sky-600/70"
                          }`}
                        >
                          {isDone && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                          {f.mapping.key}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Prior Script Note */}
            {record.priorNote && (
              <div className="px-3.5 py-2 bg-[#111827] border border-slate-800 rounded text-xs text-slate-300 flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-amber-400 shrink-0">
                  Prior Note:
                </span>
                <span
                  className="leading-relaxed line-clamp-2"
                  title={record.priorNote}
                >
                  {record.priorNote}
                </span>
              </div>
            )}

            {/* Field Scope Toggle, Model Selector, Sources & Researcher Hint */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center p-0.5 bg-[#0B0F17] border border-slate-800 rounded mr-1">
                  <button
                    type="button"
                    onClick={() => setFieldFilter("needs_verification")}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                      fieldFilter === "needs_verification"
                        ? "bg-[#1E293B] text-amber-300"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Needs Verification ({needsVerificationCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFieldFilter("all")}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                      fieldFilter === "all"
                        ? "bg-[#1E293B] text-slate-100"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    All Profile Fields ({verifiableFields.length})
                  </button>
                </div>

                <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-[#0B0F17] border border-slate-800 rounded">
                  <Cpu className="w-3 h-3 text-sky-400 shrink-0" />
                  <label
                    htmlFor="model-select"
                    className="text-[11px] text-slate-400"
                  >
                    Model
                  </label>
                  <select
                    id="model-select"
                    value={selectedModel}
                    onChange={(e) =>
                      onChangeModel(e.target.value as GeminiModelId)
                    }
                    className="bg-transparent text-[11px] font-mono text-slate-200 focus:outline-none cursor-pointer"
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        className="bg-[#111827] text-slate-200"
                      >
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => onToggleCapability("webSearch")}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                    capabilities.webSearch
                      ? "bg-[#161F30] border-sky-700/70 text-sky-300"
                      : "bg-[#111827] border-slate-800 text-slate-500"
                  }`}
                >
                  <Globe className="w-3 h-3" />
                  Web Search
                </button>
                <button
                  type="button"
                  onClick={() => onToggleCapability("officialSite")}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                    capabilities.officialSite
                      ? "bg-[#161F30] border-sky-700/70 text-sky-300"
                      : "bg-[#111827] border-slate-800 text-slate-500"
                  }`}
                >
                  <Building2 className="w-3 h-3" />
                  Official Site
                </button>
                <button
                  type="button"
                  onClick={() => onToggleCapability("registryCheck")}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                    capabilities.registryCheck
                      ? "bg-[#161F30] border-sky-700/70 text-sky-300"
                      : "bg-[#111827] border-slate-800 text-slate-500"
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  Registries
                </button>
              </div>

              <div className="flex-1 min-w-[240px] relative">
                <MessageSquare className="w-3.5 h-3.5 text-sky-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={record.researcherHint}
                  onChange={(e) => onUpdateHint(record.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isInvestigating) {
                      onInvestigateRecord(
                        record.id,
                        pendingTargetCount > 0 ? "target" : "all",
                        record.researcherHint
                      );
                    }
                  }}
                  placeholder={
                    hasFieldResults
                      ? "Optional re-investigation comment (e.g. include specific names of all 5 campuses)..."
                      : "Optional research comment, instruction, or URL..."
                  }
                  className="w-full pl-8 pr-7 py-1.5 text-xs bg-[#0B0F17] border border-slate-800 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
                {record.researcherHint && (
                  <button
                    type="button"
                    onClick={() => onUpdateHint(record.id, "")}
                    title="Clear comment"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Side-by-Side Diff Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-10 bg-[#0F1521] border-b border-slate-800">
            <tr className="text-[11px] font-semibold text-slate-400">
              <th className="py-2.5 px-3 w-10 text-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all investigated fields for confirmation"
                  checked={allPendingChecked}
                  disabled={pendingConfirmKeys.length === 0 || isInvestigating}
                  onChange={toggleAllPending}
                  className="w-3.5 h-3.5 accent-sky-500 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                />
              </th>
              <th className="py-2.5 px-4 w-[22%]">Field &amp; Prior Verdict</th>
              <th className="py-2.5 px-4 w-[21%]">Database Value</th>
              <th className="py-2.5 px-4 w-[23%]">Proposed New Value</th>
              <th className="py-2.5 px-4 w-[14%]">Audit Status</th>
              <th className="py-2.5 px-4 w-[16%] text-right">Manual Confirm</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 text-xs">
            {visibleFields.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="py-8 px-4 text-center text-xs text-slate-500"
                >
                  No fields currently flagged as needing verification. Switch to &ldquo;All Profile Fields&rdquo; or flag specific fields manually.
                </td>
              </tr>
            ) : (
              visibleFields.map(
                ({
                  mapping,
                  initialValue,
                  currentValue,
                  needReason,
                  priorVerdict,
                  needsVerification,
                  result,
                }) => {
                  const isSelected = selectedFieldKey === mapping.key;
                  const isEditing = editingFieldKey === mapping.key;
                  const isManuallyFlagged = manualFlaggedSet.has(
                    mapping.key.toLowerCase()
                  );

                  if (isInvestigating) {
                    return (
                      <tr key={mapping.key} className="bg-[#0B0F17]">
                        <td className="py-3 px-3 text-center">
                          <div className="h-3.5 w-3.5 mx-auto bg-slate-800/80 rounded animate-pulse" />
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-200">
                          {mapping.key}
                        </td>
                        <td className="py-3 px-4 text-slate-400 max-w-[240px] truncate">
                          {currentValue || "—"}
                        </td>
                        <td className="py-3 px-4">
                          <div className="h-4 w-36 bg-slate-800/80 rounded animate-pulse" />
                        </td>
                        <td className="py-3 px-4">
                          <div className="h-4 w-24 bg-slate-800/80 rounded animate-pulse" />
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="h-4 w-20 ml-auto bg-slate-800/80 rounded animate-pulse" />
                        </td>
                      </tr>
                    );
                  }

                  const visual = result
                    ? getFieldStatusVisual(result.status)
                    : null;

                  const hasValueChange = Boolean(
                    result &&
                      result.verifiedValue.trim() !== "" &&
                      (result.status === "discrepancy" ||
                        result.status === "resolved_missing")
                  );

                  return (
                    <tr
                      key={mapping.key}
                      onClick={() => onSelectField(mapping.key)}
                      className={`transition-colors duration-150 cursor-pointer ${
                        isSelected
                          ? "bg-[#161F30]"
                          : needsVerification
                          ? "bg-[#111827]/70 hover:bg-[#141D2E]"
                          : "hover:bg-[#111827]"
                      }`}
                    >
                      {/* Confirmation Selection Checkbox */}
                      <td
                        className="py-3 px-3 align-top text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {result && result.decision === "pending" ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${mapping.key} for confirmation`}
                            checked={selectedConfirmMap[mapping.key] !== false}
                            onChange={() =>
                              toggleFieldConfirmCheck(mapping.key)
                            }
                            className="w-3.5 h-3.5 mt-0.5 accent-sky-500 rounded cursor-pointer"
                          />
                        ) : result ? (
                          <CheckCircle2
                            className="w-3.5 h-3.5 mt-0.5 mx-auto text-emerald-500/80"
                            aria-label="Confirmed"
                          />
                        ) : (
                          <input
                            type="checkbox"
                            disabled
                            checked={false}
                            aria-label={`${mapping.key} awaiting investigation`}
                            className="w-3.5 h-3.5 mt-0.5 accent-sky-500 rounded opacity-25 cursor-not-allowed"
                          />
                        )}
                      </td>

                      {/* Field & Prior Verdict / Needs Verification Indicator */}
                      <td className="py-3 px-4 align-top">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-medium text-slate-100">
                            {mapping.key}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleManualFlag(record.id, mapping.key);
                            }}
                            title={
                              isManuallyFlagged
                                ? "Remove from next re-investigation"
                                : "Flag field to include in next re-investigation"
                            }
                            className={`p-1 rounded transition-colors cursor-pointer ${
                              isManuallyFlagged
                                ? "text-amber-400 bg-amber-950/40"
                                : "text-slate-600 hover:text-slate-300"
                            }`}
                          >
                            <Flag className="w-3 h-3" />
                          </button>
                        </div>

                        {isManuallyFlagged ? (
                          <div className="mt-1 space-y-1">
                            <div className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400">
                              <Flag className="w-3 h-3 shrink-0" />
                              <span>Queued for Re-investigation</span>
                            </div>
                            {priorVerdict?.rationale && (
                              <p className="text-[11px] text-slate-400 leading-snug line-clamp-2">
                                {priorVerdict.rationale}
                              </p>
                            )}
                          </div>
                        ) : result && result.decision !== "pending" ? (
                          <div className="mt-1 space-y-1">
                            <div className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                              <CheckCircle2 className="w-3 h-3 shrink-0" />
                              <span>Verified &amp; Saved</span>
                            </div>
                            {priorVerdict?.rationale && (
                              <p className="text-[11px] text-slate-400 leading-snug line-clamp-2">
                                {priorVerdict.rationale}
                              </p>
                            )}
                          </div>
                        ) : needReason ? (
                          <div className="mt-1 space-y-1">
                            <div className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              <span>Needs Verification · {needReason}</span>
                            </div>
                            {priorVerdict?.rationale && (
                              <p className="text-[11px] text-slate-400 leading-snug line-clamp-2">
                                {priorVerdict.rationale}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {priorVerdict?.status
                              ? `Prior verdict: ${priorVerdict.status}`
                              : mapping.role.replace("_", " ")}
                          </div>
                        )}
                      </td>

                      {/* Database Value (Original / Current) */}
                      <td className="py-3 px-4 align-top">
                        <div
                          className={`font-mono text-xs whitespace-pre-wrap break-words max-h-32 overflow-y-auto ${
                            result &&
                            (result.decision === "accepted" ||
                              result.decision === "edited") &&
                            currentValue !== initialValue
                              ? "line-through text-slate-500"
                              : "text-slate-300"
                          }`}
                        >
                          {formatCellPreview(initialValue) || (
                            <span className="italic text-slate-600">(empty)</span>
                          )}
                        </div>
                        {result &&
                          (result.decision === "accepted" ||
                            result.decision === "edited") &&
                          currentValue !== initialValue && (
                            <div className="mt-1.5 font-mono text-xs text-emerald-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                              Saved: {formatCellPreview(currentValue)}
                            </div>
                          )}
                      </td>

                      {/* Proposed New Value */}
                      <td
                        className="py-3 px-4 align-top"
                        onClick={(e) => {
                          if (isEditing) e.stopPropagation();
                        }}
                      >
                        {isEditing ? (
                          <div className="flex items-start gap-1.5">
                            {editDraft.length > 60 || editDraft.includes("\n") || editDraft.startsWith("[") ? (
                              <textarea
                                value={editDraft}
                                rows={3}
                                autoFocus
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape")
                                    setEditingFieldKey(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-[#0B0F17] border border-sky-500 rounded text-slate-100 focus:outline-none"
                              />
                            ) : (
                              <input
                                type="text"
                                value={editDraft}
                                autoFocus
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    commitManualEdit(mapping.key);
                                  if (e.key === "Escape")
                                    setEditingFieldKey(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-[#0B0F17] border border-sky-500 rounded text-slate-100 focus:outline-none"
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => commitManualEdit(mapping.key)}
                              className="p-1 text-emerald-400 hover:bg-slate-800 rounded cursor-pointer"
                              title="Save manual value"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingFieldKey(null)}
                              className="p-1 text-slate-400 hover:bg-slate-800 rounded cursor-pointer"
                              title="Cancel edit"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : result ? (
                          <div className="space-y-1">
                            <div
                              className={`font-mono text-xs whitespace-pre-wrap break-words max-h-32 overflow-y-auto ${
                                result.decision === "accepted" ||
                                result.decision === "edited"
                                  ? "text-emerald-300 font-medium"
                                  : hasValueChange
                                  ? "text-sky-300 font-medium"
                                  : result.status === "match"
                                  ? "text-slate-300"
                                  : "text-slate-400"
                              }`}
                            >
                              {result.decision === "edited"
                                ? formatCellPreview(result.finalValue)
                                : formatCellPreview(result.verifiedValue) || (
                                    <span className="italic text-slate-600">
                                      (no value found)
                                    </span>
                                  )}
                            </div>
                            {result.decision === "pending" && hasValueChange && (
                              <div className="text-[11px] text-sky-400">
                                Awaiting manual confirmation
                              </div>
                            )}
                            {result.decision === "accepted" && (
                              <div className="text-[11px] text-emerald-400">
                                Confirmed &amp; applied
                              </div>
                            )}
                            {result.decision === "edited" && (
                              <div className="text-[11px] text-emerald-400">
                                Manually edited &amp; applied
                              </div>
                            )}
                            {result.decision === "kept_original" && (
                              <div className="text-[11px] text-slate-400">
                                Kept original value
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600 italic">
                            Run investigation to fetch value
                          </span>
                        )}
                      </td>

                      {/* Audit Status & Table Sources Column */}
                      <td
                        className="py-3 px-4 align-top"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const tableUrls = getRowSavedFieldSources(
                            record.raw,
                            mapping.key
                          );
                          const displayUrls =
                            result?.sourceUrls && result.sourceUrls.length > 0
                              ? result.sourceUrls
                              : tableUrls;
                          return (
                            <div className="space-y-1.5">
                              {visual ? (
                                <div className="space-y-0.5">
                                  <div
                                    className={`inline-flex items-center gap-1.5 text-xs font-medium ${visual.textClass}`}
                                  >
                                    <visual.Icon className="w-3.5 h-3.5 shrink-0" />
                                    <span>{visual.label}</span>
                                  </div>
                                  <div className="text-[11px] text-slate-500 capitalize">
                                    {result?.confidence} confidence
                                  </div>
                                </div>
                              ) : (
                                <span
                                  className={`text-xs block ${
                                    needsVerification
                                      ? "text-amber-400"
                                      : "text-slate-500"
                                  }`}
                                >
                                  {needsVerification ? "Pending Check" : "Confirmed"}
                                </span>
                              )}
                              {displayUrls.length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  {displayUrls.slice(0, 2).map((u) => {
                                    let host = u;
                                    try {
                                      host = new URL(u).hostname.replace(/^www\./, "");
                                    } catch {
                                      // fallback
                                    }
                                    return (
                                      <a
                                        key={u}
                                        href={u}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={u}
                                        className="inline-flex items-center gap-1 text-[10px] font-mono text-sky-400 hover:text-sky-300 underline decoration-sky-800/70"
                                      >
                                        <span className="truncate max-w-[125px]">
                                          {host}
                                        </span>
                                        <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                      </a>
                                    );
                                  })}
                                  {displayUrls.length > 2 && (
                                    <span className="text-[10px] font-mono text-slate-500">
                                      +{displayUrls.length - 2}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>

                      {/* Manual Confirmation Actions */}
                      <td
                        className="py-3 px-4 align-top text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center justify-end gap-1">
                          {result && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  onFieldDecision(
                                    record.id,
                                    mapping.key,
                                    "accepted"
                                  )
                                }
                                title="Confirm and apply proposed new value"
                                className={`px-2.5 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer whitespace-nowrap ${
                                  result.decision === "accepted"
                                    ? "bg-emerald-950/70 border-emerald-600 text-emerald-300"
                                    : "bg-sky-600/20 border-sky-700/80 text-sky-300 hover:bg-sky-600/30"
                                }`}
                              >
                                {result.decision === "accepted"
                                  ? "Confirmed"
                                  : hasValueChange
                                  ? "Confirm Update"
                                  : "Confirm Match"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onFieldDecision(
                                    record.id,
                                    mapping.key,
                                    "kept_original"
                                  )
                                }
                                title="Keep original database value"
                                className={`px-2 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                                  result.decision === "kept_original"
                                    ? "bg-slate-800 border-slate-600 text-slate-100"
                                    : "bg-[#111827] border-slate-800 text-slate-400 hover:border-slate-700"
                                }`}
                              >
                                Keep
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              startManualEdit(
                                mapping.key,
                                result?.verifiedValue || currentValue
                              )
                            }
                            title="Edit value manually"
                            className="p-1.5 text-slate-400 hover:text-slate-100 bg-[#111827] border border-slate-800 rounded hover:border-slate-700 transition-colors cursor-pointer"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
              )
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
};
