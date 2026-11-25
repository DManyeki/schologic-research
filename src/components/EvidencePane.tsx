import React from "react";
import {
  ExternalLink,
  BookOpen,
  Building2,
  Globe,
  ShieldCheck,
  Archive,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type {
  FieldVerificationResult,
  GroundSource,
  InstitutionRecord,
} from "../types";

interface EvidencePaneProps {
  record: InstitutionRecord;
  selectedFieldKey: string | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

function getSourceMeta(sourceType: GroundSource["sourceType"]): {
  label: string;
  Icon: React.FC<{ className?: string }>;
} {
  switch (sourceType) {
    case "official_site":
      return { label: "Official Institution Site", Icon: Building2 };
    case "registry":
      return { label: "Accreditation / Gov Registry", Icon: ShieldCheck };
    default:
      return { label: "Web Search Grounding", Icon: Globe };
  }
}

export const EvidencePane: React.FC<EvidencePaneProps> = ({
  record,
  selectedFieldKey,
  isCollapsed,
  onToggleCollapse,
}) => {
  const selectedResult: FieldVerificationResult | undefined = selectedFieldKey
    ? record.fieldResults[selectedFieldKey]
    : undefined;

  const hasResults = Object.keys(record.fieldResults).length > 0;

  if (isCollapsed) {
    return (
      <aside className="w-11 shrink-0 border-l border-slate-800 bg-[#0F1521] flex flex-col items-center py-3 gap-3 h-full">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand Evidence & Citations"
          aria-label="Expand Evidence & Citations"
          className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors cursor-pointer"
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>

        <div
          className="flex flex-col items-center gap-1 pt-2 border-t border-slate-800 w-7"
          title={`${record.sources.length} grounded source(s)`}
        >
          <BookOpen className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-mono tabular-nums text-[10px] text-slate-300">
            {record.sources.length}
          </span>
        </div>

        {record.savedEvidence && (
          <div
            title={`Saved ${record.savedEvidence.entries.length} decision(s)`}
            className="p-1 text-emerald-400"
          >
            <Archive className="w-3.5 h-3.5" />
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside className="w-[340px] shrink-0 border-l border-slate-800 bg-[#0F1521] flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3.5 border-b border-slate-800 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display text-xs font-semibold text-slate-200 tracking-wide">
            Evidence &amp; Grounding Citations
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {selectedResult
              ? `Inspecting field: ${selectedResult.fieldKey}`
              : "Select any field row to inspect its source evidence."}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Collapse Evidence Sidebar"
          aria-label="Collapse Evidence Sidebar"
          className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors cursor-pointer shrink-0"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-5 flex-1">
        {/* Saved Evidence Archive */}
        {record.savedEvidence && (
          <section className="space-y-2 p-3 bg-emerald-950/20 border border-emerald-900/60 rounded">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                <Archive className="w-3.5 h-3.5" />
                <span>Saved Verification Evidence</span>
              </div>
              <span className="font-mono tabular-nums text-[10px] text-emerald-400">
                {record.savedEvidence.newVerificationStatus}
              </span>
            </div>
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p>
                Attributed to <span className="font-semibold text-slate-100">{record.displayName}</span>
                {record.raw.id ? (
                  <span className="font-mono text-slate-400"> ({String(record.raw.id).slice(0, 8)}…)</span>
                ) : null}
                . Saved {record.savedEvidence.entries.length} field decision(s) &amp;{" "}
                {record.savedEvidence.allSourceUrls.length} link(s) into table columns{" "}
                <span className="font-mono text-slate-200">
                  sources, verified_fields_jsonb, validation, updated_at
                </span>
                .
              </p>
              <div className="font-mono tabular-nums text-[10px] text-emerald-300/90">
                updated_at: {new Date(String(record.raw.updated_at || record.savedEvidence.savedAt)).toLocaleString()}
              </div>
            </div>
            {record.savedEvidence.entries.length > 0 && (
              <ul className="space-y-1.5 pt-1 border-t border-emerald-900/40">
                {record.savedEvidence.entries.map((entry) => (
                  <li key={entry.fieldKey} className="text-[11px]">
                    <div className="font-mono text-slate-200">
                      {entry.fieldKey}:{" "}
                      <span className="text-emerald-300">
                        {entry.updatedValue || "(kept empty)"}
                      </span>
                    </div>
                    {entry.evidenceSnippet && (
                      <div className="text-slate-400 line-clamp-2 mt-0.5">
                        {entry.evidenceSnippet}
                      </div>
                    )}
                    {entry.sourceUrls.length > 0 && (
                      <div className="mt-0.5 font-mono text-[10px] text-sky-400 truncate">
                        {entry.sourceUrls.join(", ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Agent Executive Summary */}
        {record.summaryNote && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold text-slate-300">
              Case Investigation Summary
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed bg-[#111827] border border-slate-800 rounded p-3">
              {record.summaryNote}
            </p>
          </section>
        )}

        {/* Selected Field Deep Evidence */}
        {selectedResult ? (
          <section className="space-y-3 pt-1 border-t border-slate-800">
            <div className="flex items-center justify-between gap-2 pt-2">
              <span className="font-mono text-xs font-semibold text-sky-400 truncate">
                {selectedResult.fieldKey}
              </span>
              <span className="text-[11px] text-slate-400 capitalize">
                {selectedResult.confidence} confidence
              </span>
            </div>

            <div className="space-y-1">
              <span className="text-[11px] font-medium text-slate-400">
                Verification Reasoning
              </span>
              <p className="text-xs text-slate-200 leading-relaxed">
                {selectedResult.reasoning || "No reasoning provided."}
              </p>
            </div>

            {selectedResult.evidenceSnippet && (
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-slate-400">
                  Extracted Evidence Snippet
                </span>
                <blockquote className="text-xs text-slate-300 bg-[#0B0F17] border border-slate-800 rounded p-3 leading-relaxed">
                  {selectedResult.evidenceSnippet}
                </blockquote>
              </div>
            )}

            {selectedResult.sourceUrls.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-slate-400">
                  Field-Specific Citations
                </span>
                <ul className="space-y-1.5">
                  {selectedResult.sourceUrls.map((url) => (
                    <li key={url}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between gap-2 px-2.5 py-2 text-[11px] font-mono text-sky-400 bg-[#111827] border border-slate-800 rounded hover:border-slate-700 hover:text-sky-300 transition-colors"
                      >
                        <span className="truncate">{url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : (
          <div className="p-4 bg-[#111827] border border-slate-800 rounded text-xs text-slate-400 leading-relaxed flex items-start gap-2.5">
            <BookOpen className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
            <span>
              {hasResults
                ? "Click a row in the diff table to inspect field-level reasoning and catalog quotes."
                : "Run investigation on this institution to populate live Google Search, official website, and accreditation registry citations."}
            </span>
          </div>
        )}

        {/* Grounding Chunks from Search / URL Context */}
        <section className="space-y-2 pt-3 border-t border-slate-800">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-300">
              All Grounded Sources
            </h3>
            <span className="font-mono tabular-nums text-[11px] text-slate-500">
              {record.sources.length}
            </span>
          </div>

          {record.sources.length === 0 ? (
            <p className="text-xs text-slate-500">
              No grounded sources recorded yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {record.sources.map((src) => {
                const { label, Icon } = getSourceMeta(src.sourceType);
                return (
                  <li key={src.uri}>
                    <a
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-2.5 bg-[#111827] border border-slate-800 rounded hover:border-slate-700 transition-colors group"
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="w-3 h-3 text-slate-400" />
                          {label}
                        </span>
                        <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400" />
                      </div>
                      <div className="mt-1 text-xs font-medium text-slate-200 group-hover:text-sky-300 line-clamp-1">
                        {src.title}
                      </div>
                      <div className="mt-0.5 text-[11px] font-mono text-slate-500 truncate">
                        {src.uri}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
};
