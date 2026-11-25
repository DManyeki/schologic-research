import React, { useState } from "react";
import {
  Search,
  Play,
  Square,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  SlidersHorizontal,
} from "lucide-react";
import type {
  InstitutionRecord,
  TriageState,
  UnresolvedRuleConfig,
} from "../types";

export type QueueFilter =
  | "unresolved"
  | "needs_review"
  | "resolved"
  | "previously_clean"
  | "all";

export type BatchLimitOption = 10 | 20 | 50 | 100 | "all";

interface QueueSidebarProps {
  records: InstitutionRecord[];
  selectedId: string | null;
  filter: QueueFilter;
  searchQuery: string;
  unresolvedRules: UnresolvedRuleConfig;
  isBatchRunning: boolean;
  batchProgress: { current: number; total: number } | null;
  onSelectRecord: (id: string) => void;
  onChangeFilter: (filter: QueueFilter) => void;
  onChangeSearch: (query: string) => void;
  onRunUnresolvedBatch: (limit: BatchLimitOption) => void;
  onStopBatch: () => void;
  onOpenFilterSettings: () => void;
}

function getStateLabel(state: TriageState): {
  label: string;
  colorClass: string;
  Icon: React.FC<{ className?: string }>;
} {
  switch (state) {
    case "unresolved":
      return {
        label: "Matched Queue",
        colorClass: "text-amber-400",
        Icon: AlertTriangle,
      };
    case "investigating":
      return {
        label: "Investigating",
        colorClass: "text-sky-400",
        Icon: Loader2,
      };
    case "needs_review":
      return {
        label: "Review Diff",
        colorClass: "text-sky-400",
        Icon: Clock,
      };
    case "resolved":
      return {
        label: "Resolved",
        colorClass: "text-emerald-400",
        Icon: CheckCircle2,
      };
    case "previously_clean":
      return {
        label: "Outside Filter",
        colorClass: "text-slate-400",
        Icon: CheckCircle2,
      };
    case "api_error":
      return {
        label: "Error",
        colorClass: "text-rose-400",
        Icon: XCircle,
      };
  }
}

export function matchesQueueFilter(
  rec: InstitutionRecord,
  filter: QueueFilter,
  searchQuery: string
): boolean {
  const matchesSearch =
    !searchQuery.trim() ||
    rec.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rec.locationLabel.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rec.priorStatus.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rec.priorNote.toLowerCase().includes(searchQuery.toLowerCase());

  if (!matchesSearch) return false;

  switch (filter) {
    case "unresolved":
      return (
        rec.triageState === "unresolved" ||
        rec.triageState === "investigating" ||
        rec.triageState === "needs_review" ||
        rec.triageState === "api_error"
      );
    case "needs_review":
      return rec.triageState === "needs_review";
    case "resolved":
      return rec.triageState === "resolved";
    case "previously_clean":
      return rec.triageState === "previously_clean";
    case "all":
      return true;
  }
}

export const QueueSidebar: React.FC<QueueSidebarProps> = ({
  records,
  selectedId,
  filter,
  searchQuery,
  unresolvedRules,
  isBatchRunning,
  batchProgress,
  onSelectRecord,
  onChangeFilter,
  onChangeSearch,
  onRunUnresolvedBatch,
  onStopBatch,
  onOpenFilterSettings,
}) => {
  const [batchLimit, setBatchLimit] = useState<BatchLimitOption>(10);

  const openQueueCount = records.filter(
    (r) =>
      r.triageState === "unresolved" ||
      r.triageState === "investigating" ||
      r.triageState === "needs_review" ||
      r.triageState === "api_error"
  ).length;
  const batchTargetCount = records.filter(
    (r) => r.triageState === "unresolved" || r.triageState === "api_error"
  ).length;
  const reviewCount = records.filter(
    (r) => r.triageState === "needs_review" || r.triageState === "investigating"
  ).length;
  const resolvedCount = records.filter((r) => r.triageState === "resolved").length;
  const cleanCount = records.filter(
    (r) => r.triageState === "previously_clean"
  ).length;

  const filtered = records.filter((rec) =>
    matchesQueueFilter(rec, filter, searchQuery)
  );

  const filterButtons: Array<{ id: QueueFilter; label: string; count: number }> = [
    { id: "unresolved", label: "Queue", count: openQueueCount },
    { id: "needs_review", label: "Review", count: reviewCount },
    { id: "resolved", label: "Verified", count: resolvedCount },
    { id: "previously_clean", label: "Other", count: cleanCount },
    { id: "all", label: "All", count: records.length },
  ];

  const activeFilters = unresolvedRules.columnFilters.filter(
    (f) => f.enabled && f.column
  );

  return (
    <aside className="w-[325px] shrink-0 border-r border-slate-800 bg-[#0F1521] flex flex-col h-full">
      <div className="p-3.5 border-b border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xs font-semibold text-slate-200 tracking-wide">
            Triage Queue
          </h2>
          <span className="font-mono tabular-nums text-[11px] text-slate-400">
            {openQueueCount} matched
          </span>
        </div>

        {/* Active Multi-Column Filter Summary */}
        <div className="p-2 bg-[#0B0F17] border border-slate-800 rounded text-[11px] space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400 font-medium">
              Active Filter ({unresolvedRules.matchLogic})
            </span>
            <button
              type="button"
              onClick={onOpenFilterSettings}
              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer"
            >
              <SlidersHorizontal className="w-3 h-3" />
              Edit
            </button>
          </div>
          {activeFilters.length > 0 ? (
            <div className="font-mono text-[10px] text-slate-300 space-y-0.5">
              {activeFilters.map((f) => (
                <div key={f.id} className="truncate" title={`${f.column} ${f.operator} ${f.value}`}>
                  {f.column} <span className="text-slate-500">{f.operator}</span>{" "}
                  <span className="text-amber-300">{f.value || "(empty)"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-slate-500">
              Blank fields fallback active
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onChangeSearch(e.target.value)}
            placeholder="Filter institution, status, or note..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0B0F17] border border-slate-800 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Segmented Filter Controls */}
        <div className="grid grid-cols-5 gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded">
          {filterButtons.map((btn) => {
            const active = filter === btn.id;
            return (
              <button
                key={btn.id}
                type="button"
                onClick={() => onChangeFilter(btn.id)}
                className={`py-1 px-1 text-[11px] font-medium rounded transition-colors duration-150 truncate cursor-pointer ${
                  active
                    ? "bg-[#1E293B] text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title={`${btn.label} (${btn.count})`}
              >
                {btn.label}
              </button>
            );
          })}
        </div>

        {/* Batch Action with Size Dropdown */}
        {isBatchRunning ? (
          <button
            type="button"
            onClick={onStopBatch}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold bg-rose-600/90 hover:bg-rose-600 text-white rounded transition-colors cursor-pointer"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
            Stop Queue ({batchProgress?.current ?? 0}/{batchProgress?.total ?? 0})
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Queue batch size"
              value={batchLimit}
              onChange={(e) => {
                const v = e.target.value;
                setBatchLimit(v === "all" ? "all" : (Number(v) as BatchLimitOption));
              }}
              className="px-2 py-2 text-xs font-mono bg-[#0B0F17] border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer shrink-0"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value="all">All ({batchTargetCount})</option>
            </select>
            <button
              type="button"
              onClick={() => onRunUnresolvedBatch(batchLimit)}
              disabled={batchTargetCount === 0}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5 fill-current shrink-0" />
              <span>
                Investigate (
                {batchLimit === "all"
                  ? batchTargetCount
                  : Math.min(batchLimit, batchTargetCount)}
                )
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Queue Rows */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No institutions match the current filter.
          </div>
        ) : (
          filtered.map((rec) => {
            const isSelected = rec.id === selectedId;
            const { label, colorClass, Icon } = getStateLabel(rec.triageState);
            const spinning = rec.triageState === "investigating";

            return (
              <button
                key={rec.id}
                type="button"
                onClick={() => onSelectRecord(rec.id)}
                className={`w-full text-left px-3.5 py-3 transition-colors duration-150 cursor-pointer block ${
                  isSelected ? "bg-[#161F30]" : "hover:bg-[#131B29]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100 leading-snug line-clamp-1">
                    {rec.displayName}
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                    #{rec.rowIndex + 1}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-1.5 text-[11px] min-w-0">
                  <Icon
                    className={`w-3.5 h-3.5 shrink-0 ${colorClass} ${
                      spinning ? "animate-spin" : ""
                    }`}
                  />
                  <span className={`font-medium whitespace-nowrap shrink-0 ${colorClass}`}>
                    {label}
                  </span>
                  {rec.flaggedFields.length > 0 && (
                    <>
                      <span className="text-slate-600 shrink-0" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-amber-300/90 whitespace-nowrap shrink-0">
                        {rec.flaggedFields.length} flagged
                      </span>
                    </>
                  )}
                  {rec.locationLabel && (
                    <>
                      <span className="text-slate-600 shrink-0" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-slate-400 truncate min-w-0">
                        {rec.locationLabel}
                      </span>
                    </>
                  )}
                </div>

                {rec.priorStatus && (
                  <p className="mt-1 text-[10px] font-mono text-slate-400 truncate">
                    {rec.priorStatus}
                  </p>
                )}

                {rec.priorNote && (
                  <p className="mt-1 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                    {rec.priorNote}
                  </p>
                )}

                {rec.errorMessage && (
                  <p
                    className="mt-1 text-[11px] text-rose-300 line-clamp-2 leading-snug"
                    title={rec.errorMessage}
                  >
                    {rec.errorMessage}
                  </p>
                )}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
