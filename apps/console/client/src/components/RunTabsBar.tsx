import { useRef } from 'react';
import type { RunSnapshot } from '../types';
import { isTabClosable, liveRunsSummary, tabDotTone, tabLabel, type OpenRunTab } from '../run-tabs-logic';

interface Props {
  tabs: OpenRunTab[];
  activeRunId: string | null;
  /** True when the board (not a run tab) is the currently active screen. */
  boardActive: boolean;
  /** Live status lookup for a live-kind tab's runId; `null` when unknown. */
  statusFor: (runId: string) => RunSnapshot['status'] | null;
  onActivate: (runId: string) => void;
  onClose: (runId: string) => void;
  onBoard: () => void;
  onNew: () => void;
  /** Extra top clearance so the strip never sits under the fixed
   *  "what is hektor?"/"how does it work?" buttons — only needed on the
   *  board/start screens, where those buttons float over the top of the page. */
  topInset?: boolean;
}

/**
 * The run-tabs strip: one tab per open run (live or history), a `board`
 * tab-like button, a `+ new` button, and — whenever at least one tab is
 * genuinely live — a clickable "N running" indicator. Rendered once, above
 * whichever view is active, so you can always jump back to a live run.
 */
export function RunTabsBar({ tabs, activeRunId, boardActive, statusFor, onActivate, onClose, onBoard, onNew, topInset }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const summary = liveRunsSummary(tabs, statusFor);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons || buttons.length === 0) return;
    const list = Array.from(buttons);
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = (current + delta + list.length) % list.length;
    list[next].focus();
  };

  return (
    <div className={`run-tabs-bar ${topInset ? 'top-inset' : ''}`}>
      <div
        className="run-tabs-list"
        role="tablist"
        aria-label="open triage runs"
        ref={listRef}
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab) => {
          const status = statusFor(tab.runId);
          const tone = tabDotTone(tab.kind, status);
          const closable = isTabClosable(tab.kind, status);
          const isActive = tab.runId === activeRunId;
          const label = tabLabel(tab.config);
          return (
            <div key={tab.runId} className={`run-tab ${isActive ? 'is-active' : ''}`}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="run-tab-btn"
                title={tab.config.projectPath}
                onClick={() => onActivate(tab.runId)}
              >
                <span className={`run-tab-dot tone-${tone}`} aria-hidden="true" />
                <span className="run-tab-label">{label}</span>
              </button>
              {closable && (
                <button
                  type="button"
                  className="run-tab-close"
                  aria-label={`close tab ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.runId);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={boardActive}
          className={`run-tab-btn run-tab-board ${boardActive ? 'is-active' : ''}`}
          onClick={onBoard}
        >
          board
        </button>
      </div>
      <button type="button" className="run-tab-new" onClick={onNew}>
        + new
      </button>
      {summary.count > 0 && (
        <button
          type="button"
          className={`live-indicator ${summary.needsYou ? 'tone-warn' : 'tone-accent'}`}
          onClick={() => summary.focusRunId && onActivate(summary.focusRunId)}
        >
          <span className="live-indicator-dot" aria-hidden="true" />
          {summary.count} running{summary.needsYou ? ' · needs you' : ''}
        </button>
      )}
    </div>
  );
}
