import { useEffect, useMemo, useState } from 'react';
import type { FileChange, PhaseState, TestArtifact } from '../types';
import { EmptyState } from './FindingsTab';
import { phaseWaitState } from '../consoleAlerts';
import { phaseById } from '../phases';
import { romanize } from '../roman';

const SCAFFOLD = phaseById('scaffold');

interface Props {
  files: FileChange[];
  tests: TestArtifact[];
  /** Phase state for `scaffold` — the earliest phase to write files — sharpens the empty-state copy. */
  phase?: PhaseState;
  /** Run id — used to fetch a clicked file's contents from the project on disk. */
  runId: string;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  files: FileChange[];
}

/** Right-pane file-content view state. */
type FileView =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; content: string; truncated: boolean; bytes: number }
  | { state: 'binary'; bytes: number }
  | { state: 'error'; error: string };

function newNode(name: string, fullPath: string): TreeNode {
  return { name, fullPath, children: new Map(), files: [] };
}

function buildTree(files: FileChange[]): TreeNode {
  const root = newNode('', '');
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!cur.children.has(seg)) {
        cur.children.set(seg, newNode(seg, parts.slice(0, i + 1).join('/')));
      }
      cur = cur.children.get(seg)!;
    }
    cur.files.push(f);
  }
  return root;
}

export function FilesTab({ files, tests, phase, runId }: Props) {
  // Drop directory-shaped deliverables (trailing slash) and pathless entries —
  // they render as blank rows and 404 on click (they aren't files). Proper fix
  // is server-side in the ledger deliverable parse; this guards the view.
  const realFiles = useMemo(
    () => files.filter((f) => f.path && !f.path.endsWith('/') && f.path.split('/').pop() !== ''),
    [files]
  );
  const tree = useMemo(() => buildTree(realFiles), [realFiles]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<FileView>({ state: 'idle' });
  // Collapsed directories, keyed by fullPath. Default: everything expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  // Fetch the selected file's text content. Guarded server-side (path-traversal
  // + size cap + binary sniff); the run may be over and the file gone → error.
  useEffect(() => {
    if (!selected) {
      setView({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setView({ state: 'loading' });
    fetch(`/api/runs/${runId}/file?path=${encodeURIComponent(selected)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`could not load file (${r.status})`);
        return r.json() as Promise<{ content?: string; truncated?: boolean; bytes: number; binary?: boolean }>;
      })
      .then((d) => {
        if (cancelled) return;
        setView(
          d.binary
            ? { state: 'binary', bytes: d.bytes }
            : { state: 'ok', content: d.content ?? '', truncated: !!d.truncated, bytes: d.bytes }
        );
      })
      .catch((e) => {
        if (!cancelled) setView({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, runId]);

  if (realFiles.length === 0 && tests.length === 0) {
    const wait = phaseWaitState(phase);
    const phaseLabel = `Phase ${romanize(SCAFFOLD?.number ?? 1)} · ${SCAFFOLD?.label ?? 'Scaffold'}`;
    if (wait === 'running') {
      return (
        <EmptyState
          glyph="∅"
          tone="waiting"
          title="Scaffold in progress"
          body="hektor is writing the Playwright config, fixtures, and page repository now — files and tests will appear here as they're created."
        />
      );
    }
    if (wait === 'settled') {
      return (
        <EmptyState
          glyph="∅"
          title="No files yet"
          body="The run hasn't produced any file changes yet. Check the Log tab if this seems unexpected."
        />
      );
    }
    return (
      <EmptyState
        glyph="∅"
        tone="waiting"
        title="Waiting for scaffold"
        body={`${phaseLabel} hasn't run yet. Files appear here as they're created — playwright config, fixtures, page repository, spec files. Tests show their fully-qualified name.`}
      />
    );
  }

  return (
    <div className="files-tab">
      <div className="files-pane">
        <div className="files-pane-head">
          <span className="files-pane-title">files</span>
          <span className="files-pane-count">{realFiles.length}</span>
        </div>
        <div className="files-tree">
          {realFiles.length === 0 ? (
            <div className="files-empty-mini">no files yet</div>
          ) : (
            <TreeView
              node={tree}
              depth={0}
              selected={selected}
              onSelect={setSelected}
              collapsed={collapsed}
              onToggleDir={toggleDir}
            />
          )}
        </div>
      </div>
      <div className="files-pane">
        {selected ? (
          <FileViewer path={selected} view={view} onClose={() => setSelected(null)} />
        ) : (
          <>
            <div className="files-pane-head">
              <span className="files-pane-title">tests</span>
              <span className="files-pane-count">{tests.length}</span>
            </div>
            <ul className="tests-list">
              {tests.length === 0 ? (
                <li className="files-empty-mini">no tests yet · click a file to view it</li>
              ) : (
                tests.map((t) => (
                  <li key={t.id} className="test-row">
                    <span className={`test-status status-${t.status}`}>{t.status === 'wrote' ? '+' : '~'}</span>
                    <span className="test-name">{t.name}</span>
                    <span className="test-path">{shortenPath(t.path)}</span>
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function FileViewer({ path, view, onClose }: { path: string; view: FileView; onClose: () => void }) {
  const name = path.split('/').pop() ?? path;
  return (
    <>
      <div className="files-pane-head file-viewer-head">
        <span className="files-pane-title" title={path}>{name}</span>
        {view.state === 'ok' && (
          <span className="files-pane-count">
            {formatBytes(view.bytes)}
            {view.truncated ? ' · truncated' : ''}
          </span>
        )}
        <button type="button" className="file-viewer-close" onClick={onClose} aria-label="close file">
          ×
        </button>
      </div>
      <div className="file-viewer-body">
        {view.state === 'loading' && <div className="files-empty-mini">loading…</div>}
        {view.state === 'error' && <div className="files-empty-mini">{view.error}</div>}
        {view.state === 'binary' && (
          <div className="files-empty-mini">binary file ({formatBytes(view.bytes)}) — not shown</div>
        )}
        {view.state === 'ok' && <pre className="file-viewer-pre">{view.content}</pre>}
      </div>
    </>
  );
}

function TreeView({
  node,
  depth,
  selected,
  onSelect,
  collapsed,
  onToggleDir,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
}) {
  const dirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  const isCollapsed = depth > 0 && collapsed.has(node.fullPath);
  return (
    <>
      {depth > 0 && (
        <button
          type="button"
          className="tree-line dir"
          style={{ paddingLeft: depth * 14 }}
          onClick={() => onToggleDir(node.fullPath)}
          aria-expanded={!isCollapsed}
          title={node.fullPath}
        >
          <span className="tree-glyph">{isCollapsed ? '▸' : '▾'}</span>
          <span className="tree-name">{node.name}/</span>
        </button>
      )}
      {!isCollapsed && dirs.map((d) => (
        <TreeView
          key={d.fullPath}
          node={d}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggleDir={onToggleDir}
        />
      ))}
      {!isCollapsed && files.map((f) => {
        const fileName = f.path.split('/').pop() ?? f.path;
        const isSel = selected === f.path;
        return (
          <button
            key={f.id}
            type="button"
            className={`tree-line file kind-${f.kind} ${isSel ? 'is-selected' : ''}`}
            style={{ paddingLeft: (depth + 1) * 14 }}
            title={f.path}
            onClick={() => onSelect(f.path)}
          >
            <span className="tree-glyph">{f.kind === 'created' ? '+' : f.kind === 'modified' ? '~' : '−'}</span>
            <span className="tree-name">{fileName}</span>
            {typeof f.bytes === 'number' && <span className="tree-meta">{formatBytes(f.bytes)}</span>}
          </button>
        );
      })}
    </>
  );
}

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}kB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
