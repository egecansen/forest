import { useEffect, useRef, useState } from 'react';
import type { RunConfig, ProjectState } from '../types';
import { ModeDropdown } from './ModeDropdown';
import { SelectDropdown } from './SelectDropdown';
import type { DropdownOption } from './SelectDropdown';
import { FolderPicker } from './FolderPicker';
import { AuthBar } from './AuthBar';
import { continueSubmitState, modeNote } from '../start-logic';

export type CredMode = 'default' | 'apiKey' | 'oauthToken';

const RUN_MODE_OPTIONS: DropdownOption<RunConfig['runMode']>[] = [
  {
    value: 'standard',
    label: 'standard',
    badge: 'balanced',
    description: 'One balanced pass across the suite — the default depth.',
  },
  {
    value: 'depth',
    label: 'depth',
    badge: '~20× cost',
    description: 'Strict everywhere — maximum rigor, far slower and pricier.',
  },
];

const PERMISSION_OPTIONS: DropdownOption<RunConfig['permissionPolicy']>[] = [
  {
    value: 'autonomous',
    label: 'autonomous',
    badge: 'accept edits',
    description: 'Creates and edits test files and runs the pipeline unattended — recommended.',
  },
  {
    value: 'restricted',
    label: 'restricted',
    badge: 'allowlist only',
    description: 'Limited to pre-approved tools; a headless run may stop early if it needs more.',
  },
];

interface Props {
  onStart: (
    projectPath: string,
    targetUrl: string,
    mode: RunConfig['mode'],
    runMode: RunConfig['runMode'],
    permissionPolicy: RunConfig['permissionPolicy'],
    projectMode?: RunConfig['projectMode'],
    demo?: boolean,
    cred?: { mode: CredMode; secret?: string },
    record?: boolean,
    prereqCredentials?: string
  ) => Promise<void>;
}

const BOOT_LINE = 'Autonomous QA Pipeline - point. run. ship.';

function useTypewriter(text: string, charMs = 32) {
  const [out, setOut] = useState('');
  useEffect(() => {
    let i = 0;
    setOut('');
    const id = window.setInterval(() => {
      i += 1;
      setOut(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, charMs);
    return () => window.clearInterval(id);
  }, [text, charMs]);
  return { out, done: out.length === text.length };
}

export function StartScreen({ onStart }: Props) {
  const [projectPath, setProjectPath] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://');
  const [mode, setMode] = useState<RunConfig['mode']>('onboarding');
  const [runMode, setRunMode] = useState<RunConfig['runMode']>('standard');
  const [permissionPolicy, setPermissionPolicy] = useState<RunConfig['permissionPolicy']>('autonomous');
  const [projectMode, setProjectMode] = useState<'new' | 'continue'>('new');
  const [credMode, setCredMode] = useState<CredMode>('default');
  const [credSecret, setCredSecret] = useState('');
  const [record, setRecord] = useState(false);
  const [recordInfo, setRecordInfo] = useState(false);
  const [runInfo, setRunInfo] = useState(false);
  const [permInfo, setPermInfo] = useState(false);
  const [prereqCreds, setPrereqCreds] = useState('');
  const [prereqName, setPrereqName] = useState<string | null>(null);
  const [prereqOpen, setPrereqOpen] = useState(false);
  const prereqFileRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const boot = useTypewriter(BOOT_LINE);

  useEffect(() => {
    if (!projectPath.trim()) {
      setState(null);
      return;
    }
    let ignore = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/project-state?path=${encodeURIComponent(projectPath.trim())}`);
        if (!ignore) setState(res.ok ? ((await res.json()) as ProjectState) : null);
      } catch {
        if (!ignore) setState(null);
      }
    }, 400);
    return () => {
      ignore = true;
      window.clearTimeout(id);
    };
  }, [projectPath]);

  // In Continue mode, auto-fill the (disabled) fields from the project's ledger/state.
  useEffect(() => {
    if (projectMode !== 'continue' || !state) return;
    if (state.targetUrl) setTargetUrl(state.targetUrl);
    if (state.runMode) setRunMode(state.runMode);
  }, [projectMode, state]);

  // A validation error goes stale the moment the user changes the mode or the
  // path — clear it so it doesn't linger after they've moved on.
  useEffect(() => {
    setErr(null);
  }, [projectMode, projectPath]);

  const guard = continueSubmitState(projectMode, state);
  const note = modeNote(projectMode, mode, state);
  const continueDisable = projectMode === 'continue';
  // Continue can only proceed once a path is entered AND the project has a
  // resumable ledger loaded (state.hasState). New mode has no such gate.
  const canProceed = projectMode === 'continue' && !!projectPath.trim() && state?.hasState === true;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErr(null);
    if (!projectPath.trim()) {
      setErr('project path is required');
      return;
    }
    if (guard.blocked) return;
    if (projectMode === 'continue' && !canProceed) return;
    setSubmitting(true);
    try {
      // Continue always resumes the pipeline from the ledger — mode is 'onboarding'.
      const effectiveMode = projectMode === 'continue' ? 'onboarding' : mode;
      await onStart(
        projectPath.trim(),
        targetUrl.trim(),
        effectiveMode,
        runMode,
        permissionPolicy,
        projectMode,
        false,
        { mode: credMode, secret: credSecret.trim() || undefined },
        record,
        prereqCreds.trim() || undefined
      );
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  const runDemo = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      // Demo run: served by the built-in simulator — always works in one click.
      await onStart(
        '/tmp/hektor-demo',
        'https://example.com',
        'onboarding',
        'standard',
        'autonomous',
        'new',
        true
      );
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="start-screen">
      <div className="start-stack">
        <form className="start-card" onSubmit={submit}>
          <div className="start-logo">
            <div className="start-kicker"><span className="kicker-brand">sahibinden</span> › hektor</div>
            <div className="start-title">hektor</div>
          </div>
          <p className="start-sub">
            <span className="boot-prompt">›</span>
            <span className="boot-line">{boot.out}</span>
            <span className={`boot-caret ${boot.done ? 'done' : ''}`} aria-hidden />
          </p>

          <div className="mode-toggle" role="tablist" aria-label="project mode">
            <button type="button" role="tab" aria-selected={projectMode === 'new'}
              className={`mode-toggle-btn ${projectMode === 'new' ? 'is-active' : ''}`}
              onClick={() => setProjectMode('new')}>new project</button>
            <button type="button" role="tab" aria-selected={projectMode === 'continue'}
              className={`mode-toggle-btn ${projectMode === 'continue' ? 'is-active' : ''}`}
              onClick={() => setProjectMode('continue')}>continue existing</button>
          </div>

          <div className="field">
            <label htmlFor="project">project path</label>
            <div className="field-with-action">
              <input
                id="project"
                placeholder="/absolute/path/to/your/project"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="browse-btn"
                onClick={() => setPickerOpen(true)}
              >
                browse
              </button>
            </div>
          </div>

          {projectMode === 'continue' && state && (
            <div className="state-card">
              <div className="state-card-head">project state</div>
              {state.hasState ? (
                <ul className="state-card-rows">
                  <li><span>phase</span><span>{state.currentPhase ?? '—'}/8</span></li>
                  <li><span>status</span><span>{state.pipelineStatus ?? 'unknown'}</span></li>
                  <li><span>journeys</span><span>{state.journeys}</span></li>
                  <li><span>tests</span><span>{state.tests}</span></li>
                  <li><span>findings</span><span>{state.findings}</span></li>
                </ul>
              ) : (
                <div className="state-card-empty">
                  {state.installed ? 'hektor installed · no prior run state yet' : 'hektor not installed here yet — it will be installed on start'}
                </div>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor="url">target url</label>
            <input
              id="url"
              placeholder="https://your-app.example.com"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={continueDisable}
            />
          </div>

          {projectMode === 'new' ? (
            <div className="field">
              <label htmlFor="mode">mode</label>
              <ModeDropdown value={mode} onChange={setMode} />
              {note && <p className="field-note">{note}</p>}
            </div>
          ) : (
            state?.hasState && (
              <p className="field-note continue-resume-note">
                ▸ resumes the pipeline from phase {state.currentPhase ?? '—'}/8 ({state.pipelineStatus ?? 'unknown'})
              </p>
            )
          )}

          <div className="field">
            <div className="field-label-row">
              <label>run mode</label>
              <button
                type="button"
                className={`info-btn ${runInfo ? 'is-open' : ''}`}
                aria-label="what does run mode do?"
                aria-expanded={runInfo}
                onClick={() => setRunInfo((v) => !v)}
              >
                i
              </button>
            </div>
            <SelectDropdown
              value={runMode}
              onChange={setRunMode}
              options={RUN_MODE_OPTIONS}
              ariaLabel="run mode"
              disabled={continueDisable}
            />
            {runInfo && (
              <p className="field-note field-info-note">
                how thorough each pass is. <strong>standard</strong> runs one balanced pass — the right
                default for most runs. <strong>depth</strong> is strict everywhere: far more rigorous,
                but roughly 20× the time and cost.
              </p>
            )}
          </div>
          <div className="field">
            <div className="field-label-row">
              <label>permissions</label>
              <button
                type="button"
                className={`info-btn ${permInfo ? 'is-open' : ''}`}
                aria-label="what do the permission modes do?"
                aria-expanded={permInfo}
                onClick={() => setPermInfo((v) => !v)}
              >
                i
              </button>
            </div>
            <SelectDropdown
              value={permissionPolicy}
              onChange={setPermissionPolicy}
              options={PERMISSION_OPTIONS}
              ariaLabel="permissions"
              disabled={continueDisable}
            />
            {permInfo && (
              <p className="field-note field-info-note">
                how much the agent may do on its own.{' '}
                <strong>autonomous — accept edits</strong> lets it create/edit test files and run the
                pipeline unattended (recommended for a full run).{' '}
                <strong>restricted — allowlist only</strong> limits it to pre-approved tools and blocks
                changes outside them, so a headless run may stop early if it needs more access.
              </p>
            )}
          </div>

          <div className="record-toggle">
            <div className="record-toggle-row">
              <label className="record-toggle-main">
                <input
                  type="checkbox"
                  className="record-toggle-box"
                  checked={record}
                  onChange={(e) => setRecord(e.target.checked)}
                />
                <span className="record-toggle-label">record browser session (video + trace)</span>
              </label>
              <button
                type="button"
                className={`info-btn ${recordInfo ? 'is-open' : ''}`}
                aria-label="what does recording do?"
                aria-expanded={recordInfo}
                onClick={() => setRecordInfo((v) => !v)}
              >
                i
              </button>
            </div>
            {recordInfo && (
              <p className="record-toggle-note">
                captures Playwright video/trace so you can replay the session in the Recording tab
              </p>
            )}
          </div>

          <details
            className="prereq-section"
            open={prereqOpen}
            onToggle={(e) => setPrereqOpen(e.currentTarget.open)}
          >
            <summary className="prereq-summary">login credentials (optional)</summary>
            <div className="prereq-body">
              <p className="prereq-note">
                for internal/gated apps that require login, or any run needing auth material for one or
                more apps/services — upload a text file (usernames/passwords/roles, API keys, or auth
                tokens), or paste below. Most apps with open signup don&rsquo;t need this.
              </p>
              <div className="prereq-controls">
                <label className="prereq-file-btn">
                  choose file
                  <input
                    ref={prereqFileRef}
                    type="file"
                    accept=".txt,.env,.json,.csv,.md,text/*"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      setPrereqCreds(text);
                      setPrereqName(file.name);
                      setPrereqOpen(true);
                    }}
                  />
                </label>
                {prereqName && <span className="prereq-chip">loaded: {prereqName}</span>}
                {(prereqCreds || prereqName) && (
                  <button
                    type="button"
                    className="prereq-clear"
                    onClick={() => {
                      setPrereqCreds('');
                      setPrereqName(null);
                      if (prereqFileRef.current) prereqFileRef.current.value = '';
                    }}
                  >
                    clear
                  </button>
                )}
              </div>
              <textarea
                className="prereq-textarea"
                rows={3}
                placeholder="user@app.com : password : role"
                value={prereqCreds}
                onChange={(e) => setPrereqCreds(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </details>

          <details className="cred-section">
            <summary className="cred-summary">LLM credentials (optional)</summary>
            <div className="cred-body">
              <div className="cred-toggle" role="tablist" aria-label="credential mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={credMode === 'default'}
                  className={`cred-toggle-btn ${credMode === 'default' ? 'is-active' : ''}`}
                  onClick={() => setCredMode('default')}
                >
                  use signed-in account
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={credMode === 'apiKey'}
                  className={`cred-toggle-btn ${credMode === 'apiKey' ? 'is-active' : ''}`}
                  onClick={() => setCredMode('apiKey')}
                >
                  API key
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={credMode === 'oauthToken'}
                  className={`cred-toggle-btn ${credMode === 'oauthToken' ? 'is-active' : ''}`}
                  onClick={() => setCredMode('oauthToken')}
                >
                  OAuth token
                </button>
              </div>
              {credMode !== 'default' && (
                <div className="field cred-field">
                  <label htmlFor="cred-secret">{credMode === 'apiKey' ? 'anthropic api key' : 'oauth token'}</label>
                  <input
                    id="cred-secret"
                    type="password"
                    placeholder={credMode === 'apiKey' ? 'sk-ant-…' : 'paste token…'}
                    value={credSecret}
                    onChange={(e) => setCredSecret(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <p className="field-note">
                    used only for this run — your company&rsquo;s Anthropic API key; overrides the signed-in account.
                  </p>
                </div>
              )}
            </div>
          </details>

          {err && (
            <p className="start-error">{err}</p>
          )}

          {guard.blocked && (
            <div className="warn-banner" role="alert">
              <span>{guard.reason}</span>
              <button type="button" className="warn-switch" onClick={() => setProjectMode('new')}>
                switch to New project
              </button>
            </div>
          )}

          <div className="start-actions">
            {projectMode === 'continue' ? (
              <button className="btn btn-primary" type="submit" disabled={submitting || !canProceed}>
                {submitting ? 'resuming…' : 'proceed'}
              </button>
            ) : (
              <>
                <button className="btn btn-primary" type="submit" disabled={submitting}>
                  {submitting ? 'starting…' : 'start a pilot'}
                </button>
                <button
                  type="button"
                  className="btn btn-demo"
                  onClick={() => void runDemo()}
                  disabled={submitting}
                >
                  run demo
                </button>
              </>
            )}
          </div>

          <AuthBar />

          {pickerOpen && (
            <FolderPicker
              initialPath={projectPath}
              onSelect={(p) => {
                setProjectPath(p);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </form>
      </div>
    </div>
  );
}
