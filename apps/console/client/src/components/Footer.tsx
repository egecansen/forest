import type { ConnectionState } from '../useRunStream';
import type { RunSnapshot } from '../types';

interface Props {
  status: RunSnapshot['status'];
  conn: ConnectionState;
  /** A past, persisted run being viewed read-only: no live WS, nothing to interrupt. */
  readOnly?: boolean;
}

const TERMINAL_WORD: Partial<Record<RunSnapshot['status'], string>> = {
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
};

export function Footer({ status, conn, readOnly = false }: Props) {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const modeLabel = status === 'running' ? 'auto mode on' : `mode: ${status}`;
  return (
    <div className="term-footer">
      <div className="hints">
        {readOnly ? (
          '→ read-only — viewing a past run from history'
        ) : terminal ? (
          <>
            → run {TERMINAL_WORD[status] ?? status} · <span>new run</span> to start another
          </>
        ) : (
          <>
            {/* Only real affordances — `shift+tab to cycle` and `ctrl+t to hide
                tasks` were TUI cargo-cult with no handlers (finding F4). */}
            → {modeLabel} · <span>esc</span> to interrupt
          </>
        )}
      </div>
      {!readOnly &&
        // While the run is live the indicator reflects the WS connection; once
        // the run reaches a terminal status it must NOT keep reading "live"
        // just because the socket is still open — show the ended state instead.
        (terminal ? (
          <div className={`conn ended tone-${status}`}>
            <span className="dot" />
            {TERMINAL_WORD[status] ?? status}
          </div>
        ) : (
          <div className={`conn ${conn === 'open' ? '' : conn === 'connecting' ? 'offline' : 'error'}`}>
            <span className="dot" />
            {conn === 'open' && 'live'}
            {conn === 'connecting' && 'connecting…'}
            {conn === 'closed' && 'disconnected'}
            {conn === 'error' && 'connection error'}
          </div>
        ))}
    </div>
  );
}
