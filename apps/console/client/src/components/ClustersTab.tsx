import { useState } from 'react';
import type { Cluster } from '../types';

export const CHIP: Record<Cluster['state'], string> = {
  proposed: '· proposed', picked: '◇ picked', skipped: '– skipped', fixing: '⚒ fixing',
  verifying: '', green: '✅ green', 'app-bug': '🐞 app-bug', error: '⚠ error',
};

/** State-chip text for a cluster — shared with ReportTab's slim outcome rows
 *  so the two views never drift on how a cluster's disposition reads. */
export function clusterStateChip(c: Cluster): string {
  return c.state === 'verifying' ? `verifying ${c.passes ?? 0}/${c.runs ?? '?'}` : CHIP[c.state];
}

/**
 * Each cluster is an expandable row: collapsed shows the same one-line
 * summary the table used to (title clamped to 2 lines via CSS), expanded
 * reveals the full title, the agent's `detail` explanation, and the
 * complete test list. Auto-collapsed by default; any number of rows can be
 * open at once (independent per-row state, not an accordion).
 */
export function ClustersTab({ clusters }: { clusters: Cluster[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  if (clusters.length === 0) return <p className="field-note">no clusters yet — they appear after the cluster phase</p>;

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="clusters-list">
      {clusters.map((c) => {
        const isOpen = openIds.has(c.id);
        return (
          <div key={c.id} className={`cluster-row cluster-${c.state} ${isOpen ? 'is-open' : ''}`}>
            <button
              type="button"
              className="cluster-row-head"
              aria-expanded={isOpen}
              onClick={() => toggle(c.id)}
            >
              <span className="cluster-chevron" aria-hidden>{isOpen ? '▾' : '▸'}</span>
              <span className="cluster-id">{c.id}</span>
              <span className="cluster-title-clamp">{c.title}</span>
              <span className="cluster-bucket">{c.bucket}</span>
              <span className="cluster-tests-count">
                {c.tests.length === 1 ? c.tests[0] : `${c.tests.length} tests`}
              </span>
              <span className="cluster-state-chip">
                {clusterStateChip(c)}
                {c.note ? <span className="field-note"> · {c.note}</span> : null}
              </span>
            </button>
            {isOpen && (
              <div className="cluster-row-body">
                <div className="cluster-full-title">{c.title}</div>
                {c.detail && <pre className="cluster-detail file-viewer-pre">{c.detail}</pre>}
                <ul className="cluster-test-list">
                  {c.tests.map((t) => (
                    <li key={t} className="cluster-test-item">{t}</li>
                  ))}
                </ul>
                {c.divergent && c.divergent.length > 0 && (
                  <ul className="cluster-divergent-list">
                    {c.divergent.map((d) => (
                      <li key={d.fqcn} className={`cluster-divergent-item is-${d.status}`}>
                        <span className="cluster-divergent-fqcn">{d.fqcn}</span>
                        <span className="cluster-divergent-chip">{d.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
