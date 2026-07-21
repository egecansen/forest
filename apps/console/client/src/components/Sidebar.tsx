import { useEffect, useState } from 'react';
import type { PhaseId, PhaseState, RunSnapshot, Telemetry } from '../types';
import { PHASES } from '../phases';
import { contextGauge, costSplit, fmtCost, fmtTokens } from '../telemetry-format';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => window.clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

interface Outputs {
  files: number;
  tests: number;
  findings: number;
}

interface Props {
  phases: PhaseState[];
  activePhase: PhaseId | null;
  telemetry: Telemetry;
  outputs: Outputs;
  status: RunSnapshot['status'];
}

export function Sidebar({ phases, telemetry, outputs, status }: Props) {
  return (
    <aside className="sidebar">
      <OutputsCard outputs={outputs} />
      <TelemetryCard telemetry={telemetry} />
      <PipelineCard phases={phases} status={status} />
    </aside>
  );
}

function OutputsCard({ outputs }: { outputs: Outputs }) {
  const total = outputs.files + outputs.tests + outputs.findings;
  return (
    <div className="card outputs-card">
      <div className="card-label">
        <span>Outputs</span>
        <span className="card-counter">{total > 0 ? `${total} total` : '—'}</span>
      </div>
      <div className="outputs-grid">
        <OutputStat n={outputs.files} label="files" tone="accent" />
        <OutputStat n={outputs.tests} label="tests" tone="info" />
        <OutputStat n={outputs.findings} label="findings" tone="warn" />
      </div>
    </div>
  );
}

function OutputStat({ n, label, tone }: { n: number; label: string; tone: 'accent' | 'info' | 'warn' }) {
  const isZero = n === 0;
  return (
    <div className={`out-stat tone-${tone} ${isZero ? 'is-zero' : ''}`}>
      <div className="out-stat-num">{n}</div>
      <div className="out-stat-label">{label}</div>
    </div>
  );
}

function TelemetryCard({ telemetry }: { telemetry: Telemetry }) {
  // Two distinct meters, clearly split (#14): CONTEXT occupancy (how full the
  // window is right now — the real near-limit signal) and lifetime PROCESSED
  // throughput (the cache-inclusive cumulative sum, which balloons and must never
  // drive the limit warning). Cost is the SDK's real figure, not a token estimate.
  const prior = telemetry.priorElapsedMs ?? 0;
  const hasPrior = prior > 0 || (telemetry.priorTokens ?? 0) > 0;
  const currentMs = hasPrior ? Math.max(0, telemetry.elapsedMs - prior) : telemetry.elapsedMs;
  const { m, s } = splitElapsed(currentMs);
  const spinner = useSpinner(telemetry.thinking);
  const gauge = contextGauge(telemetry);
  const cost = costSplit(telemetry);
  return (
    <div className="card telemetry-card">
      <div className="card-label">
        <span>Run telemetry</span>
        <span className="card-counter">{hasPrior ? 'this session' : 'elapsed'}</span>
      </div>
      <div className="telemetry-clock">
        <span className="telemetry-clock-val">
          {m}m {String(s).padStart(2, '0')}s
        </span>
        {telemetry.thinking && (
          <span className="telemetry-clock-status">
            <span className="spinner" aria-hidden>
              {spinner}
            </span>
            thinking
          </span>
        )}
      </div>

      <div className="telemetry-meters">
        {gauge && (
          <div className={`telem-meter ctx-${gauge.level}`}>
            <div className="telem-meter-head">
              <span className="telem-meter-k">context</span>
              <span className="telem-meter-v">
                {fmtTokens(gauge.tokens)} / {fmtTokens(gauge.window)}
                {gauge.level === 'danger' && <span className="telem-chip danger">near limit</span>}
                {gauge.level === 'warn' && <span className="telem-chip warn">high</span>}
              </span>
            </div>
            <div className="telem-bar" aria-hidden>
              <div className="telem-bar-fill" style={{ width: `${Math.min(100, gauge.pct * 100)}%` }} />
            </div>
          </div>
        )}
        <div className="telem-line">
          <span className="telem-line-k">processed</span>
          <span className="telem-line-v">{fmtTokens(telemetry.tokens)} tok</span>
        </div>
        {(cost.current > 0 || !cost.estimated) && (
          // This-session cost, to match the card's "this session" clock + processed.
          // The full previous / this / total split lives in the Timeline. (#14)
          <div className="telem-line">
            <span className="telem-line-k">cost{cost.estimated ? ' (est)' : ''}</span>
            <span className="telem-line-v">{fmtCost(cost.current)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PipelineCard({ phases, status: runStatus }: { phases: PhaseState[]; status: RunSnapshot['status'] }) {
  const doneCount = phases.filter((p) => p.status === 'done').length;
  // Once the run is over, phases that never started didn't "queue" — they
  // simply didn't run. Show that instead of a permanent "queued". (finding #6)
  const runOver = runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'completed';
  return (
    <div className="card">
      <div className="card-label">
        <span>Pipeline</span>
        <span className="card-counter">{doneCount} / {PHASES.length}</span>
      </div>
      <div className="pipeline">
        {PHASES.map((p) => {
          const state = phases.find((x) => x.id === p.id);
          const status = state?.status ?? 'queued';
          return (
            <div
              key={p.id}
              className={`pipeline-row ${status === 'active' ? 'active' : status === 'done' ? 'done' : ''}`}
              title={p.description}
            >
              <span className="pipeline-num">{String(p.number).padStart(2, '0')}</span>
              <span className="pipeline-name">
                {p.label}
                {state?.reviewerVerdict && state.reviewerVerdict !== 'pending' && (
                  <span className={`rev-chip rev-${state.reviewerVerdict}`}>{state.reviewerVerdict}</span>
                )}
              </span>
              <PipelineStatusBadge status={status} runOver={runOver} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineStatusBadge({ status, runOver }: { status: PhaseState['status']; runOver?: boolean }) {
  // A never-started phase on a finished run: "didn't run", not "queued".
  if (status === 'queued' && runOver) {
    return (
      <span className="pipeline-status">
        <span className="status-dot queued" /> didn&rsquo;t run
      </span>
    );
  }
  switch (status) {
    case 'active':
      return (
        <span className="pipeline-status status-active">
          <span className="status-dot" /> active
        </span>
      );
    case 'done':
      return (
        <span className="pipeline-status status-done">
          <span className="status-dot done" /> done
        </span>
      );
    case 'failed':
      return (
        <span className="pipeline-status status-failed">
          <span className="status-dot" /> failed
        </span>
      );
    case 'blocked':
      return (
        <span className="pipeline-status status-blocked">
          <span className="status-dot" /> blocked
        </span>
      );
    case 'skipped':
      return (
        <span className="pipeline-status">
          <span className="status-dot queued" /> skipped
        </span>
      );
    default:
      return (
        <span className="pipeline-status">
          <span className="status-dot queued" /> queued
        </span>
      );
  }
}

function splitElapsed(ms: number): { m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { m: Math.floor(total / 60), s: total % 60 };
}
