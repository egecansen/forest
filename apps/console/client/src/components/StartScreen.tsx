import { useEffect, useState } from 'react';
import type { RunConfig } from '../types';
import { SelectDropdown } from './SelectDropdown';
import type { DropdownOption } from './SelectDropdown';
import { FolderPicker } from './FolderPicker';

const PERMISSION_OPTIONS: DropdownOption<RunConfig['permissionPolicy']>[] = [
  {
    value: 'confirm-applies',
    label: 'confirm applies',
    badge: 'review fixes',
    description: 'Pauses for your confirmation before applying a fix to a picked cluster.',
  },
  {
    value: 'autonomous',
    label: 'auto-approve recipe fixes',
    badge: 'accept edits',
    description: 'Applies picked-cluster fixes unattended.',
  },
];

/** Mirrors server/src/validate.ts's `TB_RE = /^tb[0-9]{1,4}$/` — a client-side
 *  quick check so the form can disable submit + hint before round-tripping
 *  to the server for the authoritative validation. */
const TESTBOX_RE = /^tb[0-9]{1,4}$/;
export function isValidTestbox(testbox: string): boolean {
  return TESTBOX_RE.test(testbox.trim());
}

/** Mirrors server/src/validate.ts's report-URL checks: must parse as a URL
 *  and carry a `fullTestBuildName` query param. (The server additionally
 *  checks the host allowlist + `buildStartTime`, which need server-side kit
 *  config — those surface as a proper error from the POST /api/runs call.) */
export function isValidReportUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  return !!u.searchParams.get('fullTestBuildName');
}

interface ConsoleConfigResponse {
  configured: boolean;
  repoPath?: string;
  testbox?: string;
  reportBase?: string;
}

interface Props {
  onStart: (
    projectPath: string,
    targetUrl: string,
    testbox: string,
    permissionPolicy: RunConfig['permissionPolicy'],
    projectMode: RunConfig['projectMode']
  ) => Promise<void>;
  /** Seeds the report-URL field — set when arriving from the builds board
   *  ("triage" on a row) or a `?triage=<url>` deep link. */
  prefillReportUrl?: string;
}

export function StartScreen({ onStart, prefillReportUrl }: Props) {
  const [projectPath, setProjectPath] = useState('');
  const [targetUrl, setTargetUrl] = useState(prefillReportUrl || 'https://');
  const [testbox, setTestbox] = useState('');
  const [permissionPolicy, setPermissionPolicy] = useState<RunConfig['permissionPolicy']>('confirm-applies');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Seed project path + testbox from the console's configured defaults
  // (GET /api/config) — only when the field hasn't already been filled in
  // (e.g. by the user typing ahead of the response, or a future deep link).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const cfg = (await res.json()) as ConsoleConfigResponse;
        if (cancelled || !cfg.configured) return;
        if (cfg.repoPath) setProjectPath((p) => (p ? p : cfg.repoPath!));
        if (cfg.testbox) setTestbox((t) => (t ? t : cfg.testbox!));
      } catch {
        // offline / not yet configured — leave the fields blank, user fills them in
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const projectPathValid = projectPath.trim().length > 0;
  const testboxValid = isValidTestbox(testbox);
  const urlValid = isValidReportUrl(targetUrl);
  const canSubmit = projectPathValid && testboxValid && urlValid && !submitting;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErr(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onStart(projectPath.trim(), targetUrl.trim(), testbox.trim(), permissionPolicy, 'new');
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
          <p className="start-sub">flaky-test triage — point at a build, pick fixes, verify green.</p>

          <div className="field">
            <label htmlFor="project">project path</label>
            <div className="field-with-action">
              <input
                id="project"
                placeholder="/absolute/path/to/web-test"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="button" className="browse-btn" onClick={() => setPickerOpen(true)}>
                browse
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="url">report url</label>
            <input
              id="url"
              placeholder="https://report-with-elastic-data.example.net/web-test-s4-flaky/2127?..."
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {!urlValid && (
              <p className="field-note">must be a valid link that includes fullTestBuildName</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="testbox">testbox</label>
            <input
              id="testbox"
              placeholder="tb161"
              value={testbox}
              onChange={(e) => setTestbox(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {!testboxValid && <p className="field-note">must look like tb161 (tb + 1-4 digits)</p>}
          </div>

          <div className="field">
            <label>permissions</label>
            <SelectDropdown
              value={permissionPolicy}
              onChange={setPermissionPolicy}
              options={PERMISSION_OPTIONS}
              ariaLabel="permissions"
            />
          </div>

          {err && <p className="start-error">{err}</p>}

          <div className="start-actions">
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {submitting ? 'starting…' : 'start triage'}
            </button>
          </div>

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
