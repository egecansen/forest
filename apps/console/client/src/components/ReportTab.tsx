import type { ReactNode } from 'react';
import type { Cluster, Telemetry } from '../types';
import { clusterStateChip } from './ClustersTab';
import { EmptyState } from './FindingsTab';
import { costSplit, fmtCost, fmtTokens, formatDuration } from '../telemetry-format';
import { parseReportMarkdown, type InlineToken } from '../report-markdown';

interface Props {
  reportUrl: string | null;
  reportReady: boolean;        // report phase done?
  reportIsReal: boolean;       // true when reportUrl points at a real served deck (/api/...)
  clusters: Cluster[];
  /** The agent's final result message (server-set on a successful run via
   *  Run.setReportText — see run-store.ts / driver.ts). */
  reportText?: string;
  /** Powers the footer's "took <elapsed> · <tokens> tok · $<cost>" line. */
  telemetry: Telemetry;
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
 * run finishes), show the cluster scoreboard + slim outcome rows + the
 * agent's final message, rendered as the triage record.
 */
export function ReportTab({ reportUrl, reportReady, reportIsReal, clusters, reportText, telemetry }: Props) {
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

  const cost = costSplit(telemetry).total;

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
        <div className="report-outcomes">
          {clusters.map((c) => (
            <div key={c.id} className={`report-outcome-row cluster-${c.state}`}>
              <span className="cluster-id">{c.id}</span>
              <span className="report-outcome-bucket">{c.bucket}</span>
              <span className="report-outcome-chip">{clusterStateChip(c)}</span>
              <span className="report-outcome-count">
                {c.tests.length} test{c.tests.length === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="report-section">
        <div className="report-section-head">Final report</div>
        {reportText ? (
          <ReportMarkdown text={reportText} />
        ) : (
          <p className="field-note">The agent finished without a final message.</p>
        )}
      </div>

      <div className="report-footer">
        took {formatDuration(telemetry.elapsedMs)} · {fmtTokens(telemetry.tokens)} tok · {fmtCost(cost)} — review the working-tree diff in Files before committing.
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

/** Minimal, safe markdown rendering for the agent's final report text — no
 *  markdown library, no `dangerouslySetInnerHTML`. See report-markdown.ts
 *  for the parser; this just turns its typed blocks into React elements, so
 *  anything unrecognized stays literal (auto-escaped) text. */
function ReportMarkdown({ text }: { text: string }) {
  const blocks = parseReportMarkdown(text);
  return (
    <div className="report-markdown">
      {blocks.map((block, i) =>
        block.kind === 'bullets' ? (
          <ul key={i} className="report-md-list">
            {block.items.map((item, j) => (
              <li key={j}>{renderTokens(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i} className="report-md-p">
            {renderTokens(block.tokens)}
          </p>
        )
      )}
    </div>
  );
}

function renderTokens(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((t, i) => {
    if (t.kind === 'bold') return <strong key={i}>{t.value}</strong>;
    if (t.kind === 'code') return <code key={i}>{t.value}</code>;
    return t.value;
  });
}
