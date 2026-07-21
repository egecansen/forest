import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowseResult } from '../types';

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

const RECENT_KEY = 'hektor-console.recentFolders';
const RECENT_MAX = 6;

/** Case-insensitive substring filter over a folder's dir listing. Pure — testable in isolation. */
export function filterDirs(
  dirs: BrowseResult['dirs'],
  query: string,
): BrowseResult['dirs'] {
  const q = query.trim().toLowerCase();
  if (!q) return dirs;
  return dirs.filter((d) => d.name.toLowerCase().includes(q));
}

/** Splits an absolute path into clickable breadcrumb segments, each carrying its ancestor path. */
export function pathSegments(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/').filter(Boolean);
  if (!isAbsolute) {
    return [{ label: path, path }];
  }
  const segments: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

/** Prepends `path` to `list`, dedupes, and caps length. Pure — testable in isolation. */
export function pushRecent(list: string[], path: string, max = RECENT_MAX): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const base = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return base || '/';
}

function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecentFolders(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // private-mode / quota-exceeded — recent folders are a convenience, not critical
  }
}

async function fetchBrowse(path: string): Promise<BrowseResult> {
  const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error('browse request failed');
  return (await res.json()) as BrowseResult;
}

export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [current, setCurrent] = useState(initialPath ?? '');
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [recent, setRecent] = useState<string[]>(() => loadRecentFolders());
  const filterRef = useRef<HTMLInputElement>(null);

  const navigate = (path: string) => setCurrent(path);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    (async () => {
      try {
        const json = await fetchBrowse(current);
        if (ignore) return;
        setData(json);
        setLoading(false);
      } catch {
        if (ignore) return;
        // Fall back to home so the picker is never stuck empty with no way to navigate.
        if (current !== '') {
          try {
            const home = await fetchBrowse('');
            if (ignore) return;
            setData(home);
            setNotice("couldn't open that path — showing home");
            setLoading(false);
            return;
          } catch {
            // fall through to the plain error below
          }
        }
        if (!ignore) {
          setError('cannot read this folder');
          setLoading(false);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [current]);

  // Clear the filter (and refocus it) whenever we navigate into a new folder.
  useEffect(() => {
    setFilterText('');
    filterRef.current?.focus();
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const breadcrumb = useMemo(() => pathSegments(data?.path ?? current), [data, current]);
  const visibleDirs = useMemo(
    () => (data ? filterDirs(data.dirs, filterText) : []),
    [data, filterText],
  );

  return (
    <div className="folder-picker-overlay" onClick={onClose} aria-hidden={false}>
      <div
        className="folder-picker-panel"
        role="dialog"
        aria-label="browse for a project folder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="folder-picker-head">
          <span className="folder-picker-label">select a folder</span>
          {breadcrumb.length > 0 ? (
            <div className="folder-picker-breadcrumb" aria-label="current path">
              {breadcrumb.map((seg, i) => (
                <span key={seg.path} className="folder-picker-crumb-group">
                  {i > 0 && <span className="folder-picker-crumb-sep">/</span>}
                  <button
                    type="button"
                    className="folder-picker-crumb"
                    onClick={() => navigate(seg.path)}
                  >
                    {seg.label}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="folder-picker-path">…</div>
          )}
          {notice && <div className="folder-picker-notice">{notice}</div>}
        </div>

        {recent.length > 0 && (
          <div className="folder-picker-recent">
            <span className="folder-picker-recent-label">recent:</span>
            {recent.map((p) => (
              <button
                key={p}
                type="button"
                className="folder-picker-chip"
                title={p}
                onClick={() => navigate(p)}
              >
                {basename(p)}
              </button>
            ))}
          </div>
        )}

        <input
          ref={filterRef}
          type="text"
          className="folder-picker-filter"
          placeholder="filter this folder…"
          aria-label="filter folders"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />

        <div className="folder-picker-list">
          {loading && <div className="folder-picker-empty">loading…</div>}
          {!loading && error && (
            <div className="folder-picker-empty folder-picker-error">{error}</div>
          )}
          {!loading && !error && data && (
            <>
              {data.parent !== null && (
                <button
                  type="button"
                  className="folder-picker-row folder-picker-row-up"
                  onClick={() => navigate(data.parent as string)}
                >
                  ⤴ ..
                </button>
              )}
              {data.dirs.length === 0 && data.parent === null && (
                <div className="folder-picker-empty">no subfolders</div>
              )}
              {data.dirs.length > 0 && visibleDirs.length === 0 && (
                <div className="folder-picker-empty">no matches</div>
              )}
              {visibleDirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  className="folder-picker-row"
                  onClick={() => navigate(dir.path)}
                >
                  {dir.name}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="folder-picker-footer">
          <div className="folder-picker-current" title={data?.path ?? current}>
            {data?.path ?? current}
          </div>
          <div className="folder-picker-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!data}
              onClick={() => {
                if (!data) return;
                const updated = pushRecent(loadRecentFolders(), data.path);
                saveRecentFolders(updated);
                setRecent(updated);
                onSelect(data.path);
                onClose();
              }}
            >
              select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
