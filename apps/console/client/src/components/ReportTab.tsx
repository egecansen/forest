import type { Cluster } from '../types';
import { ClustersTab } from './ClustersTab';
import { EmptyState } from './FindingsTab';

interface Props {
  reportUrl: string | null;
  reportReady: boolean;        // report phase done?
  reportIsReal: boolean;       // true when reportUrl points at a real served deck (/api/...)
  clusters: Cluster[];
  /** The agent's final result message (server-set on a successful run via
   *  Run.setReportText — see run-store.ts / driver.ts). */
  reportText?: string;
}

type ScoreboardState = 'green' | 'app-bug' | 'error' | 'skipped';
const SCOREBOARD_STATES: ScoreboardState[] = ['green', 'app-bug', 'error', 'skipped'];

function isScoreboardState(state: Cluster['state']): state is ScoreboardState {
  return (SCOREBOARD_STATES as string[]).includes(state);
}

/**
 * When the run is backed by the real engine, reportUrl points at an
 * actual qa-summary-deck.html served by the server — iframe it directly.
 * Otherwise (the common triage case — reportUrl is always null once the
 * run finishes), show the cluster scoreboard + the agent's final message.
 */
export function ReportTab({ reportUrl, reportReady, reportIsReal, clusters, reportText }: Props) {
  if (reportReady && reportIsReal && reportUrl) {
    return (
      <div className="report-tab report-tab-real">
        <div className="report-real-bar">
          <span className="dim">qa-summary-deck.html</span>
          <a className="report-open" href={reportUrl} target="_blank" rel="noreferrer">open ↗</a>
        </div>
        <iframe className="report-frame" title="QA summary deck" src={reportUrl} />
      </div>
    );
  }

  if (!reportReady) {
    return (
      <EmptyState
        glyph="◷"
        tone="waiting"
        title="Report not ready yet"
        body="The scoreboard lands here when the run completes."
      />
    );
  }

  const counts = clusters.reduce(
    (acc, c) => {
      if (isScoreboardState(c.state)) acc[c.state] += 1;
      return acc;
    },
    { green: 0, 'app-bug': 0, error: 0, skipped: 0 } as Record<ScoreboardState, number>
  );

  return (
    <div className="report-tab">
      <div className="report-section">
        <div className="report-section-head">Cluster scoreboard</div>
        <div className="report-grid">
          <ReportStat label="green" value={String(counts.green)} accent="accent" />
          <ReportStat label="app-bug" value={String(counts['app-bug'])} accent={counts['app-bug'] > 0 ? 'warn' : 'neutral'} />
          <ReportStat label="error" value={String(counts.error)} accent={counts.error > 0 ? 'warn' : 'neutral'} />
          <ReportStat label="skipped" value={String(counts.skipped)} accent="neutral" />
        </div>
        <ClustersTab clusters={clusters} />
      </div>

      <div className="report-section">
        <div className="report-section-head">Final report</div>
        {/* file-viewer-pre: reuses the Files tab's mono/preformatted block
            styling (see FilesTab.tsx) rather than introducing a new rule. */}
        <pre className="report-text file-viewer-pre">{reportText || 'The agent finished without a final message.'}</pre>
      </div>
    </div>
  );
}

function ReportStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'accent' | 'warn' | 'neutral';
}) {
  return (
    <div className={`report-stat accent-${accent ?? 'neutral'}`}>
      <div className="report-stat-label">{label}</div>
      <div className="report-stat-value">{value}</div>
    </div>
  );
}
