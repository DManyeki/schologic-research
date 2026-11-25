import React from "react";

export type WorkspaceTab = "triage" | "import" | "export";

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  hasRecords: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  hasRecords,
}) => {
  const navItems: Array<{ id: WorkspaceTab; label: string }> = [
    { id: "triage", label: "Triage & Diff" },
    { id: "import", label: "Import & Schema" },
    { id: "export", label: "Export Center" },
  ];

  return (
    <header className="h-14 shrink-0 border-b border-slate-800 bg-[#0F1521] px-6 flex items-center justify-between gap-8">
      <button
        type="button"
        onClick={() => onSelectTab(hasRecords ? "triage" : "import")}
        className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-sm"
      >
        VeritasHE
      </button>

      <nav className="flex items-center gap-6" aria-label="Primary workspace navigation">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`relative py-4 text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isActive
                  ? "text-sky-400"
                  : "text-slate-400 hover:text-slate-100"
              }`}
            >
              {item.label}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-sky-400"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={() => onSelectTab("export")}
          disabled={!hasRecords}
          className="px-4 py-2 text-xs font-semibold bg-sky-600 text-white rounded-md hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Export Data
        </button>
      </div>
    </header>
  );
};
