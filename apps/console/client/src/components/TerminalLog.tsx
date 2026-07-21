import type { LogEntry } from '../types';

interface Props {
  entries: LogEntry[];
}

export function TerminalLog({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="log-entry kind-info">
        <span className="log-ts">[--:--:--]</span>
        <div className="log-body">
          <span className="bullet">·</span>
          <span className="dim">waiting for backend events…</span>
        </div>
      </div>
    );
  }
  return (
    <>
      {groupEntries(entries).map((g) =>
        g.kind === 'command' ? (
          <CommandBlock key={g.head.id} head={g.head} progress={g.progress} />
        ) : (
          <LogRow key={g.entry.id} entry={g.entry} />
        )
      )}
    </>
  );
}


type Group =
  | { kind: 'single'; entry: LogEntry }
  | { kind: 'command'; head: LogEntry; progress: LogEntry | null };

/**
 * Collapse the (bash → progress) pattern into a single visual block so
 * the command and its progress bar belong together instead of floating
 * between unrelated lines.
 */
function groupEntries(entries: LogEntry[]): Group[] {
  const out: Group[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'bash') {
      const next = entries[i + 1];
      if (next && next.kind === 'progress') {
        out.push({ kind: 'command', head: e, progress: next });
        i++;
        continue;
      }
      out.push({ kind: 'command', head: e, progress: null });
      continue;
    }
    out.push({ kind: 'single', entry: e });
  }
  return out;
}

function CommandBlock({ head, progress }: { head: LogEntry; progress: LogEntry | null }) {
  return (
    <div className="command-block">
      <div className="log-entry kind-bash">
        <span className="log-ts">{fmtTime(head.ts)}</span>
        <div className="log-body">
          <span className="bullet">●</span>
          <span className="key">Bash</span>
          <span className="dim">(</span>
          <span title={head.detail ?? head.text}>{head.text}</span>
          <span className="dim">)</span>
        </div>
      </div>
      {progress && progress.progress && (
        <div className="log-entry kind-progress command-progress-row">
          <span className="log-ts" />
          <div className="log-body">
            <div className="log-progress">
              <div className="bar">
                <div style={{ width: `${Math.min(100, progress.progress.percent)}%` }} />
              </div>
              <span className="pct">
                {progress.progress.label ?? `${progress.progress.percent.toFixed(0)}%`}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const cls = `log-entry kind-${entry.kind}`;
  if (entry.kind === 'progress' && entry.progress) {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <div className="log-progress">
            <div className="bar">
              <div style={{ width: `${Math.min(100, entry.progress.percent)}%` }} />
            </div>
            <span className="pct">
              {entry.progress.label ?? `${entry.progress.percent.toFixed(0)}%`}
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (entry.kind === 'skill') {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <span className="bullet">●</span>
          <span className="key">Skill</span>
          <span className="dim">(</span>
          <span>{entry.text}</span>
          <span className="dim">)</span>
          {entry.detail && <div className="log-detail">{entry.detail}</div>}
        </div>
      </div>
    );
  }
  if (entry.kind === 'warn') {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <span className="bullet">⚠</span>
          <span>{entry.text}</span>
        </div>
      </div>
    );
  }
  if (entry.kind === 'error') {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <span className="bullet">✕</span>
          <span>{entry.text}</span>
        </div>
      </div>
    );
  }
  if (entry.kind === 'success') {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <span className="bullet">✓</span>
          <span>{renderInline(entry.text)}</span>
          {entry.detail && <div className="log-detail">{entry.detail}</div>}
        </div>
      </div>
    );
  }
  if (entry.kind === 'active') {
    return (
      <div className={cls}>
        <span className="log-ts">{fmtTime(entry.ts)}</span>
        <div className="log-body">
          <span className="bullet">▸</span>
          <span>{renderInline(entry.text)}</span>
          {entry.detail && <div className="log-detail">{entry.detail}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <span className="log-ts">{fmtTime(entry.ts)}</span>
      <div className="log-body">
        <span className="bullet">·</span>
        <span>{renderInline(entry.text)}</span>
        {entry.detail && (
          <span className="log-affordance">
            <span className="chevron">▸</span>
            {entry.detail}
          </span>
        )}
      </div>
    </div>
  );
}

function renderInline(text: string) {
  // Bolden uppercase phase words like Scaffold, Phase 1, Stage 1, etc.
  const parts = text.split(/(Phase \d+|Stage \d+|Scaffold|Groundwork)/g);
  return parts.map((p, i) =>
    /^(Phase \d+|Stage \d+|Scaffold|Groundwork)$/.test(p) ? (
      <span key={i} className="strong">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}
