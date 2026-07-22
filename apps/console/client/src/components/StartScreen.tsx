import { useEffect, useState, type ReactNode } from 'react';
import type { RunConfig } from '../types';
import { SelectDropdown } from './SelectDropdown';
import type { DropdownOption } from './SelectDropdown';
import { FolderPicker } from './FolderPicker';
import { RunConflictError } from '../run-conflict';

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
}

interface Props {
  onStart: (
    projectPath: string,
    targetUrl: string,
    testbox: string,
    permissionPolicy: RunConfig['permissionPolicy'],
    projectMode: RunConfig['projectMode'],
    demo: boolean,
    /** Bypasses the server's same-projectPath 409 guard — only ever passed
     *  by this component's own conflict-retry closure below, never by direct
     *  user action. */
    override?: boolean
  ) => Promise<void>;
  /** Seeds the report-URL field — set when arriving from the builds board
   *  ("triage" on a row) or a `?triage=<url>` deep link. */
  prefillReportUrl?: string;
  /** Seeds the testbox field — set when the builds-board build being
   *  triaged carries a `params.TESTBOX`. Same untouched-guard precedence as
   *  prefillReportUrl: wins over the GET /api/config default, loses to
   *  anything the user has already typed. */
  prefillTestbox?: string;
  /** Navigates to the builds board — the form is the landing view, this is
   *  its escape hatch to browse/triage from live Jenkins state instead. */
  onBrowseBuilds: () => void;
  /**
   * Called instead of showing the plain inline error when `onStart` rejects
   * with a same-projectPath 409 (RunConflictError) — hands the conflicting
   * run's id plus a ready-to-call retry (the same submission, with
   * `override: true`) up to a host that can render a proper dialog. Falls
   * back to the inline error banner when omitted.
   */
  onConflict?: (conflictRunId: string, retry: () => Promise<void>) => void;
  /** Rendered above the form — e.g. a "N triage(s) running — view" banner. */
  banner?: ReactNode;
  /** Rendered below the form — e.g. the "previous triages" section. */
  afterForm?: ReactNode;
}

/** The demo toggle is dev/demo-only surface — only shown when there's a
 *  clear signal this is a demo session: an explicit `?demo` on the page URL,
 *  or a `?triage=` deep link whose report URL already carries the scripted
 *  demo's `fullTestBuildName=demo` marker (see server/src/driver.ts's
 *  makeDemoQueryFn and validate.ts, which both key off `demo: true`/that
 *  marker). Never shown for an ordinary triage session. */
function computeShowDemoToggle(prefillReportUrl: string | undefined): boolean {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')) return true;
  return !!prefillReportUrl && prefillReportUrl.includes('fullTestBuildName=demo');
}

export function StartScreen({ onStart, prefillReportUrl, prefillTestbox, onBrowseBuilds, onConflict, banner, afterForm }: Props) {
  const [projectPath, setProjectPath] = useState('');
  const [targetUrl, setTargetUrl] = useState(prefillReportUrl || 'https://');
  const [testbox, setTestbox] = useState(prefillTestbox || '');
  const [permissionPolicy, setPermissionPolicy] = useState<RunConfig['permissionPolicy']>('confirm-applies');
  const [demo, setDemo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const showDemoToggle = computeShowDemoToggle(prefillReportUrl);

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
  // The demo report URL/testbox are synthetic (a scripted run, no real
  // Jenkins/ES lookup happens) — don't block a demo submission on the same
  // shape checks a real triage session's URL/testbox must satisfy. The
  // server (validate.ts's normalizeRunBody) also skips these shape checks
  // for `demo: true` bodies, so a malformed demo submission isn't blocked
  // here only to 400 server-side.
  const testboxValid = demo || isValidTestbox(testbox);
  const urlValid = demo || isValidReportUrl(targetUrl);
  const canSubmit = projectPathValid && testboxValid && urlValid && !submitting;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErr(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onStart(projectPath.trim(), targetUrl.trim(), testbox.trim(), permissionPolicy, 'new', demo);
    } catch (e) {
      if (e instanceof RunConflictError && onConflict) {
        onConflict(e.conflictRunId, () =>
          onStart(projectPath.trim(), targetUrl.trim(), testbox.trim(), permissionPolicy, 'new', demo, true)
        );
      } else {
        setErr((e as Error).message);
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="start-screen">
      <div className="start-stack">
        {banner}
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

          {showDemoToggle && (
            <label className="demo-toggle">
              <input
                type="checkbox"
                checked={demo}
                onChange={(e) => setDemo(e.target.checked)}
              />
              demo mode — scripted run, no SDK or network needed
            </label>
          )}

          {err && <p className="start-error">{err}</p>}

          <div className="start-actions">
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {submitting ? 'starting…' : 'start triage'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onBrowseBuilds}>
              latest builds →
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
        {afterForm}
      </div>
    </div>
  );
}
