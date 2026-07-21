import { useState } from 'react';
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
    label: 'autonomous',
    badge: 'accept edits',
    description: 'Applies picked-cluster fixes unattended.',
  },
];

interface Props {
  onStart: (
    projectPath: string,
    targetUrl: string,
    testbox: string,
    permissionPolicy: RunConfig['permissionPolicy']
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

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErr(null);
    if (!projectPath.trim()) {
      setErr('project path is required');
      return;
    }
    setSubmitting(true);
    try {
      await onStart(projectPath.trim(), targetUrl.trim(), testbox.trim(), permissionPolicy);
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
            <button className="btn btn-primary" type="submit" disabled={submitting}>
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
