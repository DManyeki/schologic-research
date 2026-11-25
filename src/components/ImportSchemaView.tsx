import React, { useRef, useState } from "react";
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  AlertCircle,
  Check,
  RotateCcw,
  Plus,
  Trash2,
  Filter,
  Database,
  Loader2,
} from "lucide-react";
import type {
  ColumnFilterRule,
  DatasetMeta,
  FieldMapping,
  FieldRole,
  FilterOperator,
  InstitutionRecord,
  UnresolvedRuleConfig,
} from "../types";
import {
  buildDefaultColumnFilters,
  SAMPLE_PYTHON_OUTPUT_JSON,
  stringifyFieldValue,
} from "../utils/dataParser";

interface ImportSchemaViewProps {
  datasetMeta: DatasetMeta | null;
  firstRow: Record<string, unknown> | null;
  totalRows: number;
  mappings: FieldMapping[];
  unresolvedRules: UnresolvedRuleConfig;
  previewRecords: InstitutionRecord[];
  onImportText: (rawText: string, fileName: string) => void;
  onUpdateMappings: (mappings: FieldMapping[]) => void;
  onUpdateRules: (rules: UnresolvedRuleConfig) => void;
  onProceedToTriage: () => void;
  onResetWorkspace: () => void;
}

const ROLE_OPTIONS: Array<{ value: FieldRole; label: string }> = [
  { value: "identifier", label: "Institution Name" },
  { value: "url", label: "Official Website URL" },
  { value: "location", label: "Location / Region" },
  { value: "accreditation", label: "Accreditation / Registry ID" },
  { value: "prior_status", label: "Workflow / Verification Status" },
  { value: "prior_note", label: "Prior Script Note" },
  { value: "flagged_fields", label: "Target / Flagged Fields" },
  { value: "attribute", label: "Verifiable Attribute" },
  { value: "ignore", label: "Ignore / Internal Metadata" },
];

const OPERATOR_OPTIONS: Array<{ value: FilterOperator; label: string }> = [
  { value: "equals", label: "Equals (exact, case-insensitive)" },
  { value: "contains", label: "Contains" },
  { value: "not_equals", label: "Not equals" },
  { value: "is_empty", label: "Is empty" },
  { value: "is_not_empty", label: "Is not empty" },
];

export const ImportSchemaView: React.FC<ImportSchemaViewProps> = ({
  datasetMeta,
  firstRow,
  totalRows,
  mappings,
  unresolvedRules,
  previewRecords,
  onImportText,
  onUpdateMappings,
  onUpdateRules,
  onProceedToTriage,
  onResetWorkspace,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingWorkspaceCsv, setIsLoadingWorkspaceCsv] = useState(false);

  const handleFile = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      onImportText(text, file.name);
      setPasteMode(false);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to parse uploaded file."
      );
    }
  };

  const handlePasteSubmit = () => {
    setImportError(null);
    if (!pastedText.trim()) {
      setImportError("Paste JSON or CSV content before importing.");
      return;
    }
    try {
      const guessedExt =
        pastedText.trim().startsWith("{") || pastedText.trim().startsWith("[")
          ? "pasted_python_output.json"
          : "pasted_python_output.csv";
      onImportText(pastedText, guessedExt);
      setPasteMode(false);
      setPastedText("");
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to parse pasted content."
      );
    }
  };

  const handleLoadWorkspaceCsv = async () => {
    setImportError(null);
    setIsLoadingWorkspaceCsv(true);
    try {
      const res = await fetch("/api/workspace-dataset");
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.error || "Could not load workspace institutions.csv."
        );
      }
      const text = await res.text();
      onImportText(text, "institutions.csv");
    } catch (err) {
      setImportError(
        err instanceof Error
          ? err.message
          : "Failed to load workspace institutions.csv."
      );
    } finally {
      setIsLoadingWorkspaceCsv(false);
    }
  };

  const handleLoadSample = () => {
    setImportError(null);
    try {
      onImportText(SAMPLE_PYTHON_OUTPUT_JSON, "python_unresolved_sample.json");
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to load sample dataset."
      );
    }
  };

  const updateFieldMapping = (index: number, patch: Partial<FieldMapping>) => {
    const next = mappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onUpdateMappings(next);
  };

  const updateFilterRule = (
    ruleId: string,
    patch: Partial<ColumnFilterRule>
  ) => {
    const next = unresolvedRules.columnFilters.map((r) =>
      r.id === ruleId ? { ...r, ...patch } : r
    );
    onUpdateRules({ ...unresolvedRules, columnFilters: next });
  };

  const addFilterRule = () => {
    const fallbackCol = datasetMeta?.columnOrder[0] ?? "";
    const newRule: ColumnFilterRule = {
      id: `rule-${Date.now()}`,
      column: fallbackCol,
      operator: "equals",
      value: "",
      enabled: true,
    };
    onUpdateRules({
      ...unresolvedRules,
      columnFilters: [...unresolvedRules.columnFilters, newRule],
    });
  };

  const removeFilterRule = (ruleId: string) => {
    onUpdateRules({
      ...unresolvedRules,
      columnFilters: unresolvedRules.columnFilters.filter(
        (r) => r.id !== ruleId
      ),
    });
  };

  const applyStandardPreset = () => {
    if (!datasetMeta) return;
    const preset = buildDefaultColumnFilters(datasetMeta.columnOrder);
    if (preset.filters.length > 0) {
      onUpdateRules({
        ...unresolvedRules,
        matchLogic: preset.matchLogic,
        columnFilters: preset.filters,
        treatEmptyAsUnresolved: preset.treatEmptyAsUnresolved,
      });
    }
  };

  const matchedQueueRecords = previewRecords.filter(
    (r) =>
      r.triageState === "unresolved" ||
      r.triageState === "needs_review" ||
      r.triageState === "api_error"
  );
  const excludedCount = previewRecords.length - matchedQueueRecords.length;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0F17] p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
          <div className="max-w-2xl">
            <h1 className="font-display text-2xl font-bold text-slate-100 tracking-tight">
              Import Python Pipeline Output &amp; Multi-Column Filters
            </h1>
            <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
              Upload JSON or CSV output from your verification database. Filter target cases across multiple status columns (prefetch status, research status, sync status, and verification status) and review mapped target fields.
            </p>
          </div>
          {datasetMeta && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onResetWorkspace}
                className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 bg-[#111827] border border-slate-800 rounded-md hover:bg-slate-800 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Clear Dataset
              </button>
              <button
                type="button"
                onClick={onProceedToTriage}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                Open Triage Queue ({matchedQueueRecords.length} Matched)
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {importError && (
          <div
            role="alert"
            className="flex items-center gap-3 p-4 bg-rose-950/40 border border-rose-900/70 rounded-md text-sm text-rose-200"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{importError}</span>
          </div>
        )}

        {/* Import Dropzone & Quick Actions */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleFile(file);
            }}
            className={`lg:col-span-2 p-6 rounded-md border transition-colors duration-150 flex flex-col justify-between ${
              isDragging
                ? "border-sky-500 bg-sky-950/20"
                : "border-slate-800 bg-[#111827]"
            }`}
          >
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-md bg-[#161F30] border border-slate-800 text-sky-400 shrink-0">
                <Upload className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Upload JSON or CSV Institutional Output
                </h2>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Supports large CSV exports (with JSONB columns like <span className="font-mono text-slate-300">target_fields</span>, <span className="font-mono text-slate-300">verified_fields_jsonb</span>, and <span className="font-mono text-slate-300">validation</span>) as well as JSON arrays and objects.
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,.tsv,application/json,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                Choose File (.csv / .json)
              </button>
              <button
                type="button"
                onClick={handleLoadWorkspaceCsv}
                disabled={isLoadingWorkspaceCsv}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-emerald-300 bg-[#161F30] border border-emerald-800/80 rounded-md hover:bg-emerald-950/40 disabled:opacity-50 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                {isLoadingWorkspaceCsv ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Database className="w-3.5 h-3.5" />
                )}
                Load Workspace institutions.csv
              </button>
              <button
                type="button"
                onClick={() => setPasteMode((prev) => !prev)}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#161F30] border border-slate-700 rounded-md hover:bg-slate-800 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                {pasteMode ? "Hide Paste" : "Paste Raw"}
              </button>
              <button
                type="button"
                onClick={handleLoadSample}
                className="px-3.5 py-2 text-xs font-medium text-slate-300 bg-[#161F30] border border-slate-700 rounded-md hover:bg-slate-800 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0"
              >
                Load Sample
              </button>
            </div>

            {pasteMode && (
              <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  rows={6}
                  placeholder="Paste JSON array/object or CSV rows with headers..."
                  className="w-full p-3 text-xs font-mono bg-[#0B0F17] border border-slate-700 rounded-md text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handlePasteSubmit}
                    className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors cursor-pointer"
                  >
                    Parse Pasted Data
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 rounded-md border border-slate-800 bg-[#111827] flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-slate-300">
                <FileSpreadsheet className="w-4 h-4 text-slate-400" />
                <h2 className="font-display text-base font-semibold">
                  Loaded Dataset Summary
                </h2>
              </div>
              {datasetMeta ? (
                <dl className="mt-4 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-2">
                    <dt className="text-slate-400">Source File</dt>
                    <dd
                      className="font-mono text-slate-200 truncate max-w-[180px]"
                      title={datasetMeta.fileName}
                    >
                      {datasetMeta.fileName}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-2">
                    <dt className="text-slate-400">Total Profiles</dt>
                    <dd className="font-mono tabular-nums text-slate-100 font-semibold">
                      {totalRows}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-2">
                    <dt className="text-slate-400">Matched Target Queue</dt>
                    <dd className="font-mono tabular-nums text-amber-400 font-semibold">
                      {matchedQueueRecords.length}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-slate-400">Outside Filter</dt>
                    <dd className="font-mono tabular-nums text-slate-400 font-semibold">
                      {excludedCount}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-4 text-xs text-slate-400 leading-relaxed">
                  No dataset loaded yet. Upload your CSV/JSON or click <span className="text-emerald-300 font-medium">Load Workspace institutions.csv</span> to isolate flagged records.
                </p>
              )}
            </div>
            {datasetMeta && (
              <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-400">
                Format:{" "}
                <span className="font-mono text-slate-300 uppercase">
                  {datasetMeta.format}
                </span>{" "}
                · Columns:{" "}
                <span className="font-mono tabular-nums text-slate-300">
                  {datasetMeta.columnOrder.length}
                </span>
              </div>
            )}
          </div>
        </section>

        {/* Multi-Column Triage Filter Builder */}
        {datasetMeta && mappings.length > 0 && (
          <>
            <section className="p-5 rounded-md border border-slate-800 bg-[#111827] space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-sky-400" />
                    <h2 className="font-display text-base font-semibold text-slate-100">
                      Multi-Column Triage Filter Rules
                    </h2>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Filter which records enter the priority queue across multiple status columns (prefetch status = packaged, research status = researched, sync status = applied, verification status = flagged).
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center p-0.5 bg-[#0B0F17] border border-slate-800 rounded">
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateRules({ ...unresolvedRules, matchLogic: "AND" })
                      }
                      className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                        unresolvedRules.matchLogic === "AND"
                          ? "bg-[#1E293B] text-slate-100"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Match ALL (AND)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateRules({ ...unresolvedRules, matchLogic: "OR" })
                      }
                      className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                        unresolvedRules.matchLogic === "OR"
                          ? "bg-[#1E293B] text-slate-100"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Match ANY (OR)
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={applyStandardPreset}
                    className="px-3 py-1.5 text-xs font-medium text-sky-300 bg-[#161F30] border border-slate-700 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Auto-Detect Status Columns
                  </button>
                  <button
                    type="button"
                    onClick={addFilterRule}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#161F30] border border-slate-700 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Filter
                  </button>
                </div>
              </div>

              {unresolvedRules.columnFilters.length === 0 ? (
                <div className="p-4 bg-[#0B0F17] border border-slate-800 rounded text-xs text-slate-400 flex items-center justify-between gap-4">
                  <span>
                    No column filters configured. Add a filter rule to isolate target cases by status column.
                  </span>
                  <button
                    type="button"
                    onClick={addFilterRule}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-sky-600 rounded hover:bg-sky-500 cursor-pointer shrink-0"
                  >
                    Add Column Filter
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {unresolvedRules.columnFilters.map((rule) => {
                    const needsValue =
                      rule.operator !== "is_empty" &&
                      rule.operator !== "is_not_empty";
                    return (
                      <div
                        key={rule.id}
                        className="flex flex-wrap items-center gap-2.5 p-2.5 bg-[#0B0F17] border border-slate-800 rounded"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            updateFilterRule(rule.id, { enabled: !rule.enabled })
                          }
                          aria-label="Toggle filter condition"
                          className={`w-5 h-5 rounded border flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                            rule.enabled
                              ? "bg-sky-600 border-sky-500 text-white"
                              : "bg-[#111827] border-slate-700 text-transparent"
                          }`}
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>

                        <select
                          value={rule.column}
                          onChange={(e) =>
                            updateFilterRule(rule.id, { column: e.target.value })
                          }
                          className="min-w-[200px] flex-1 px-2.5 py-1.5 text-xs font-mono bg-[#111827] border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
                        >
                          {datasetMeta.columnOrder.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>

                        <select
                          value={rule.operator}
                          onChange={(e) =>
                            updateFilterRule(rule.id, {
                              operator: e.target.value as FilterOperator,
                            })
                          }
                          className="min-w-[210px] px-2.5 py-1.5 text-xs bg-[#111827] border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
                        >
                          {OPERATOR_OPTIONS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>

                        {needsValue && (
                          <input
                            type="text"
                            value={rule.value}
                            onChange={(e) =>
                              updateFilterRule(rule.id, { value: e.target.value })
                            }
                            placeholder="Expected value..."
                            className="min-w-[200px] flex-1 px-2.5 py-1.5 text-xs font-mono bg-[#111827] border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                          />
                        )}

                        <button
                          type="button"
                          onClick={() => removeFilterRule(rule.id)}
                          aria-label="Remove filter condition"
                          className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-[#111827] rounded transition-colors cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-800/80 text-xs">
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={unresolvedRules.treatEmptyAsUnresolved}
                    onChange={(e) =>
                      onUpdateRules({
                        ...unresolvedRules,
                        treatEmptyAsUnresolved: e.target.checked,
                      })
                    }
                    className="w-4 h-4 rounded border-slate-600 bg-[#0B0F17] text-sky-500"
                  />
                  <span>Also include rows with blank verifiable attributes</span>
                </label>

                <div className="text-slate-400">
                  Matched Queue:{" "}
                  <span className="font-mono tabular-nums font-semibold text-amber-400">
                    {matchedQueueRecords.length}
                  </span>{" "}
                  of{" "}
                  <span className="font-mono tabular-nums text-slate-200">
                    {previewRecords.length}
                  </span>{" "}
                  records
                  {matchedQueueRecords.length > 0 && (
                    <span className="text-slate-500 ml-2">
                      (e.g.,{" "}
                      {matchedQueueRecords
                        .slice(0, 3)
                        .map((r) => r.displayName)
                        .join(", ")}
                      {matchedQueueRecords.length > 3 ? ", ..." : ""})
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* Column & Field Role Mapping */}
            <section className="rounded-md border border-slate-800 bg-[#111827] overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-100">
                    Column &amp; Field Role Mapping
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Internal pipeline/JSONB columns are automatically ignored for verification while remaining preserved on export.
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-400">
                  {mappings.filter((m) => m.verifyEnabled).length} of{" "}
                  {mappings.length} profile fields verifiable
                </span>
              </div>

              <div className="overflow-x-auto max-h-[420px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-[#0F1521] z-10">
                    <tr className="border-b border-slate-800 text-xs font-medium text-slate-400">
                      <th className="py-2.5 px-4">Verify</th>
                      <th className="py-2.5 px-4">Source Column / Key</th>
                      <th className="py-2.5 px-4">Sample Value (Row 1)</th>
                      <th className="py-2.5 px-4">Schema Role</th>
                      <th className="py-2.5 px-4">Agent Verification Instruction</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 text-xs">
                    {mappings.map((mapping, idx) => {
                      const sampleVal = stringifyFieldValue(
                        firstRow?.[mapping.key]
                      );
                      return (
                        <tr
                          key={mapping.key}
                          className="hover:bg-[#161F30] transition-colors duration-150"
                        >
                          <td className="py-2.5 px-4 w-14">
                            <button
                              type="button"
                              onClick={() =>
                                updateFieldMapping(idx, {
                                  verifyEnabled: !mapping.verifyEnabled,
                                })
                              }
                              aria-label={`Toggle verification for ${mapping.key}`}
                              className={`w-5 h-5 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                                mapping.verifyEnabled
                                  ? "bg-sky-600 border-sky-500 text-white"
                                  : "bg-[#0B0F17] border-slate-700 text-transparent"
                              }`}
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          </td>
                          <td className="py-2.5 px-4 font-mono text-slate-200 font-medium whitespace-nowrap">
                            {mapping.key}
                          </td>
                          <td
                            className="py-2.5 px-4 text-slate-400 max-w-[220px] truncate"
                            title={sampleVal}
                          >
                            {sampleVal || (
                              <span className="italic text-slate-600">
                                (empty)
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-4">
                            <select
                              value={mapping.role}
                              onChange={(e) => {
                                const newRole = e.target.value as FieldRole;
                                const autoVerify =
                                  newRole !== "ignore" &&
                                  newRole !== "prior_status" &&
                                  newRole !== "prior_note" &&
                                  newRole !== "flagged_fields";
                                updateFieldMapping(idx, {
                                  role: newRole,
                                  verifyEnabled: autoVerify,
                                });
                              }}
                              className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
                            >
                              {ROLE_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-4 min-w-[260px]">
                            <input
                              type="text"
                              value={mapping.promptHint}
                              disabled={!mapping.verifyEnabled}
                              placeholder={
                                mapping.verifyEnabled
                                  ? "Optional verification guidance..."
                                  : "Disabled for verification"
                              }
                              onChange={(e) =>
                                updateFieldMapping(idx, {
                                  promptHint: e.target.value,
                                })
                              }
                              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700/80 rounded text-slate-200 placeholder:text-slate-600 disabled:opacity-40 focus:outline-none focus:border-sky-500"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
