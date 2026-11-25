import React, { useState } from "react";
import { Download, FileJson, FileSpreadsheet, ArrowLeft } from "lucide-react";
import type {
  DatasetMeta,
  FieldMapping,
  InstitutionRecord,
  UnresolvedRuleConfig,
} from "../types";
import { serializeCSV, stringifyFieldValue } from "../utils/dataParser";

interface ExportViewProps {
  datasetMeta: DatasetMeta | null;
  records: InstitutionRecord[];
  mappings: FieldMapping[];
  unresolvedRules: UnresolvedRuleConfig;
  onBackToTriage: () => void;
}

function triggerDownload(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const ExportView: React.FC<ExportViewProps> = ({
  datasetMeta,
  records,
  mappings,
  unresolvedRules,
  onBackToTriage,
}) => {
  const [updateVerificationStatus, setUpdateVerificationStatus] = useState(true);
  const [includeSavedEvidenceCols, setIncludeSavedEvidenceCols] = useState(true);

  if (!datasetMeta || records.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0B0F17] p-8">
        <div className="max-w-md text-center space-y-3">
          <h2 className="font-display text-lg font-semibold text-slate-200">
            No Dataset Loaded for Export
          </h2>
          <p className="text-xs text-slate-400">
            Import a JSON or CSV dataset first, resolve your flagged institutional cases, and return here to export merged or delta outputs.
          </p>
        </div>
      </div>
    );
  }

  const resolvedRecords = records.filter((r) => r.triageState === "resolved");
  const cleanRecords = records.filter(
    (r) => r.triageState === "previously_clean"
  );
  const remainingUnresolved = records.filter(
    (r) =>
      r.triageState === "unresolved" ||
      r.triageState === "needs_review" ||
      r.triageState === "api_error"
  );

  let acceptedFieldChanges = 0;
  for (const rec of records) {
    for (const res of Object.values(rec.fieldResults)) {
      if (
        (res.decision === "accepted" || res.decision === "edited") &&
        res.finalValue !== res.originalValue
      ) {
        acceptedFieldChanges++;
      }
    }
  }

  const verificationCol =
    mappings.find(
      (m) => m.role === "prior_status" && /verif/i.test(m.key)
    )?.key ??
    unresolvedRules.columnFilters.find((f) => /verif/i.test(f.column))?.column ??
    "";

  const buildMergedRow = (rec: InstitutionRecord): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...rec.raw };
    for (const m of mappings) {
      const res = rec.fieldResults[m.key];
      if (res && (res.decision === "accepted" || res.decision === "edited")) {
        out[m.key] = res.finalValue;
      }
    }
    if (
      updateVerificationStatus &&
      verificationCol &&
      rec.triageState === "resolved"
    ) {
      out[verificationCol] = "verified";
      if (unresolvedRules.flaggedField) {
        const origFlagVal = stringifyFieldValue(
          (rec.initialRaw ?? rec.raw)[unresolvedRules.flaggedField]
        ).trim();
        out[unresolvedRules.flaggedField] =
          origFlagVal.startsWith("[") ||
          unresolvedRules.flaggedField === "target_fields"
            ? "[]"
            : "";
      }
    }
    if (includeSavedEvidenceCols) {
      if (rec.savedEvidence) {
        out.verification_evidence_summary = rec.savedEvidence.entries
          .map(
            (e) =>
              `${e.fieldKey}=${e.updatedValue} (${e.evidenceSnippet || e.reasoning})`
          )
          .join(" | ");
        out.verification_sources = rec.savedEvidence.allSourceUrls.join("; ");
        out.verification_saved_at = rec.savedEvidence.savedAt;
      } else {
        out.verification_evidence_summary = "";
        out.verification_sources = "";
        out.verification_saved_at = "";
      }
    }
    return out;
  };

  const exportColumnOrder = includeSavedEvidenceCols
    ? [
        ...datasetMeta.columnOrder,
        ...(datasetMeta.columnOrder.includes("verification_evidence_summary")
          ? []
          : [
              "verification_evidence_summary",
              "verification_sources",
              "verification_saved_at",
            ]),
      ]
    : datasetMeta.columnOrder;

  const baseName = datasetMeta.fileName.replace(/\.(json|csv|tsv)$/i, "");

  const handleExportMerged = (format: "json" | "csv") => {
    const rows = records.map(buildMergedRow);
    if (format === "csv") {
      const csv = serializeCSV(rows, exportColumnOrder);
      triggerDownload(
        csv,
        `${baseName}_merged_verified.csv`,
        "text/csv;charset=utf-8"
      );
    } else {
      const payload = datasetMeta.jsonRootKey
        ? { [datasetMeta.jsonRootKey]: rows }
        : rows;
      triggerDownload(
        JSON.stringify(payload, null, 2),
        `${baseName}_merged_verified.json`,
        "application/json"
      );
    }
  };

  const handleExportDelta = (format: "json" | "csv") => {
    const deltaSource = records.filter(
      (r) =>
        r.triageState === "resolved" ||
        Boolean(r.savedEvidence) ||
        Object.values(r.fieldResults).some(
          (fr) => fr.decision === "accepted" || fr.decision === "edited"
        )
    );
    const rows = deltaSource.map(buildMergedRow);
    if (format === "csv") {
      const csv = serializeCSV(rows, exportColumnOrder);
      triggerDownload(
        csv,
        `${baseName}_resolved_delta.csv`,
        "text/csv;charset=utf-8"
      );
    } else {
      const payload = datasetMeta.jsonRootKey
        ? { [datasetMeta.jsonRootKey]: rows }
        : rows;
      triggerDownload(
        JSON.stringify(payload, null, 2),
        `${baseName}_resolved_delta.json`,
        "application/json"
      );
    }
  };

  const handleExportAuditLog = () => {
    const auditEntries = records
      .filter((r) => Object.keys(r.fieldResults).length > 0 || r.savedEvidence)
      .map((r) => ({
        rowIndex: r.rowIndex,
        institutionId: String(r.raw.id ?? r.id),
        institutionName: r.displayName,
        priorStatus: r.priorStatus,
        priorNote: r.priorNote,
        triageState: r.triageState,
        updatedAt: r.raw.updated_at ?? r.savedEvidence?.savedAt ?? null,
        verifiedAt: r.raw.verified_at ?? r.lastVerifiedAt ?? null,
        lastVerifiedAt: r.lastVerifiedAt,
        discoveredOfficialUrl: r.discoveredOfficialUrl,
        summaryNote: r.summaryNote,
        sourcesColumn: r.raw.sources ?? null,
        savedEvidence: r.savedEvidence,
        sources: r.sources,
        fieldAudit: Object.values(r.fieldResults),
      }));

    triggerDownload(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          sourceFile: datasetMeta.fileName,
          auditedCount: auditEntries.length,
          records: auditEntries,
        },
        null,
        2
      ),
      `${baseName}_audit_citations.json`,
      "application/json"
    );
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0F17] p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-100 tracking-tight">
              Export Reconciled Dataset &amp; Saved Evidence
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Download either the complete merged institutional database or a delta patch containing only newly resolved profiles and archived evidence.
            </p>
          </div>
          <button
            type="button"
            onClick={onBackToTriage}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#111827] border border-slate-800 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Triage Queue
          </button>
        </div>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-md border border-slate-800 bg-[#111827]">
            <div className="text-xs text-slate-400">Total Profiles</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-100">
              {records.length}
            </div>
          </div>
          <div className="p-4 rounded-md border border-slate-800 bg-[#111827]">
            <div className="text-xs text-slate-400">Verified &amp; Saved</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-emerald-400">
              {resolvedRecords.length}
            </div>
          </div>
          <div className="p-4 rounded-md border border-slate-800 bg-[#111827]">
            <div className="text-xs text-slate-400">Still Unresolved / Review</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-amber-400">
              {remainingUnresolved.length}
            </div>
          </div>
          <div className="p-4 rounded-md border border-slate-800 bg-[#111827]">
            <div className="text-xs text-slate-400">Confirmed Field Updates</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-sky-400">
              {acceptedFieldChanges}
            </div>
          </div>
        </section>

        <div className="p-4 rounded-md border border-slate-800 bg-[#111827] space-y-2.5">
          {verificationCol && (
            <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={updateVerificationStatus}
                onChange={(e) => setUpdateVerificationStatus(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-[#0B0F17] text-sky-500"
              />
              <span>
                Ensure{" "}
                <span className="font-mono text-sky-300">{verificationCol}</span>{" "}
                is set to{" "}
                <span className="font-mono text-emerald-400">&quot;verified&quot;</span>{" "}
                for resolved cases
              </span>
            </label>
          )}
          <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSavedEvidenceCols}
              onChange={(e) => setIncludeSavedEvidenceCols(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-[#0B0F17] text-sky-500"
            />
            <span>
              Include saved evidence columns (
              <span className="font-mono text-slate-300">
                verification_evidence_summary, verification_sources, verification_saved_at
              </span>
              )
            </span>
          </label>
        </div>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 rounded-md border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Full Merged Dataset
              </h2>
              <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
                Exports all {records.length} rows—preserving {cleanRecords.length} outside-filter rows untouched while merging your confirmed updates and verification status.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => handleExportMerged("csv")}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                CSV
              </button>
              <button
                type="button"
                onClick={() => handleExportMerged("json")}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-100 bg-[#161F30] border border-slate-700 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
              >
                <FileJson className="w-3.5 h-3.5" />
                JSON
              </button>
            </div>
          </div>

          <div className="p-5 rounded-md border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Newly Resolved Delta
              </h2>
              <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
                Exports only records confirmed and verified in this session so your downstream script can patch only updated profiles.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => handleExportDelta("csv")}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-100 bg-[#161F30] border border-slate-700 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                CSV
              </button>
              <button
                type="button"
                onClick={() => handleExportDelta("json")}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-100 bg-[#161F30] border border-slate-700 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
              >
                <FileJson className="w-3.5 h-3.5" />
                JSON
              </button>
            </div>
          </div>

          <div className="p-5 rounded-md border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Audit &amp; Citations Report
              </h2>
              <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
                Structured provenance log recording every field&apos;s previous value, confirmed value, evidence snippet, status transition, and source URLs.
              </p>
            </div>
            <button
              type="button"
              onClick={handleExportAuditLog}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-100 bg-[#161F30] border border-slate-700 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download Audit JSON
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
