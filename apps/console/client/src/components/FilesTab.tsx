import { useEffect, useMemo, useState } from 'react';
import type { FileChange, PhaseState, TestArtifact, WorktreeResult } from '../types';
import { diffAnchorId, diffLineClass, parseUnifiedDiff } from '../worktree-diff';

const POLL_MS = 10_000;

interface Props {
  files: FileChange[];
  tests: TestArtifact[];
  /** Phase state for `scaffold` — kept for API compatibility with callers;
   *  no longer drives the tab's empty state (the working-tree diff is the
   *  primary content now, independent of the scaffold phase). */
  phase?: PhaseState;
  /** Run id — used to fetch the working-tree diff from the project on disk. */
  runId: string;
  /** True while the run is genuinely live (see consoleAlerts.isRunLive):
   *  polls the worktree endpoint every 10s. False (finished run / history
   *  view) fetches it exactly once. */
  live: boolean;
}

type WorktreeView =
  | { state: 'loading' }
  | { state: 'ok'; data: WorktreeResult }
  | { state: 'error' };

export function FilesTab({ files, tests, runId, live }: Props) {
  const [worktree, setWorktree] = useState<WorktreeView>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/worktree`);
        if (!res.ok) throw new Error(`could not load working tree (${res.status})`);
        const data = (await res.json()) as WorktreeResult;
        if (!cancelled) setWorktree({ state: 'ok', data });
      } catch {
        if (!cancelled) setWorktree({ state: 'error' });
      }
    };
    void load();
    if (!live) return () => { cancelled = true; };
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [runId, live]);

  const segments = useMemo(
    () => (worktree.state === 'ok' ? parseUnifiedDiff(worktree.data.diff) : []),
    [worktree]
  );

  const scrollToHunk = (path: string) => {
    document.getElementById(diffAnchorId(path))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="worktree-tab">
      <div className="worktree-main">
        {worktree.state === 'loading' && (
          <div className="files-empty-mini">reading the working tree…</div>
        )}
        {worktree.state === 'error' && (
          <div className="files-empty-mini">
            working-tree diff unavailable — the run's project may no longer exist on disk.
          </div>
        )}
        {worktree.state === 'ok' && (
          <>
            <div className="worktree-summary">
              {worktree.data.files.length} files changed in the working tree — review before committing
            </div>
            <div className="worktree-body">
              <div className="worktree-namestatus">
                {worktree.data.files.length === 0 ? (
                  <div className="files-empty-mini">clean working tree — nothing to review</div>
                ) : (
                  worktree.data.files.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className={`worktree-file-row status-${f.status[0]}`}
                      title={f.path}
                      onClick={() => scrollToHunk(f.path)}
                    >
                      <span className="worktree-file-status">{f.status}</span>
                      <span className="worktree-file-path">{f.path}</span>
                    </button>
                  ))
                )}
              </div>
              {segments.length > 0 && (
                <pre className="worktree-diff file-viewer-pre">
                  {segments.map((seg) => (
                    <div key={seg.path} id={diffAnchorId(seg.path)} className="worktree-hunk">
                      {seg.lines.map((line, i) => (
                        <div key={i} className={`diff-line diff-${diffLineClass(line)}`}>
                          {line}
                        </div>
                      ))}
                    </div>
                  ))}
                </pre>
              )}
              {worktree.data.truncated && (
                <div className="field-note worktree-truncated">diff truncated at 512KB</div>
              )}
            </div>
          </>
        )}
      </div>

      <AgentTouchedSection files={files} tests={tests} />
    </div>
  );
}

/** The pre-existing "files the agent itself reported writing/editing" list —
 *  now a small secondary section (the working-tree diff above is the primary
 *  review surface), shown only when there's something to show. */
function AgentTouchedSection({ files, tests }: { files: FileChange[]; tests: TestArtifact[] }) {
  if (files.length === 0) return null;
  // Drop directory-shaped deliverables (trailing slash) and pathless entries —
  // they render as blank rows and aren't real files.
  const realFiles = files.filter((f) => f.path && !f.path.endsWith('/') && f.path.split('/').pop() !== '');
  return (
    <div className="files-secondary">
      <div className="files-secondary-head">
        <span className="files-pane-title">agent-touched files</span>
        <span className="files-pane-count">{realFiles.length}</span>
      </div>
      <ul className="files-secondary-list">
        {realFiles.map((f) => (
          <li key={f.id} className={`tree-line file kind-${f.kind}`}>
            <span className="tree-glyph">{f.kind === 'created' ? '+' : f.kind === 'modified' ? '~' : '−'}</span>
            <span className="tree-name" title={f.path}>{f.path}</span>
          </li>
        ))}
      </ul>
      {tests.length > 0 && (
        <ul className="tests-list">
          {tests.map((t) => (
            <li key={t.id} className="test-row">
              <span className={`test-status status-${t.status}`}>{t.status === 'wrote' ? '+' : '~'}</span>
              <span className="test-name">{t.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
