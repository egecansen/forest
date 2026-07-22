import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StartScreen } from '../components/StartScreen';
import { RunConflictError } from '../run-conflict';

const CONFIG_RESPONSE = {
  configured: true,
  repoPath: '/repo/web-test',
  testbox: 'tb161',
  reportBase: 'https://report.example',
};

function stubConfigFetch(body: unknown = CONFIG_RESPONSE) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const GOOD_URL = 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=abc';

describe('StartScreen', () => {
  it('prefills project path + testbox from GET /api/config', async () => {
    stubConfigFetch();
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/project path/i)).toHaveValue('/repo/web-test'));
    expect(screen.getByLabelText(/testbox/i)).toHaveValue('tb161');
  });

  it('prefills the report URL from prefillReportUrl over any config default', async () => {
    stubConfigFetch();
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} prefillReportUrl={GOOD_URL} />);
    expect(screen.getByLabelText(/report url/i)).toHaveValue(GOOD_URL);
  });

  it('prefills the testbox from prefillTestbox, taking precedence over the config default', async () => {
    stubConfigFetch(); // config default testbox is 'tb161'
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} prefillTestbox="tb307" />);
    expect(screen.getByLabelText(/testbox/i)).toHaveValue('tb307');
    // Let the config fetch resolve — its untouched-guard must not clobber the prefill.
    await waitFor(() => expect(screen.getByLabelText(/project path/i)).toHaveValue('/repo/web-test'));
    expect(screen.getByLabelText(/testbox/i)).toHaveValue('tb307');
  });

  it('disables submit and shows a hint for a malformed testbox', async () => {
    stubConfigFetch({ configured: false });
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} prefillReportUrl={GOOD_URL} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/x');
    const testboxInput = screen.getByLabelText(/testbox/i);
    await user.type(testboxInput, 'tb99999');
    expect(screen.getByRole('button', { name: /start triage/i })).toBeDisabled();
    expect(screen.getByText(/tb161/i)).toBeInTheDocument(); // field-note hint mentions the expected shape
  });

  it('disables submit and shows a hint for a report URL missing fullTestBuildName', async () => {
    stubConfigFetch({ configured: false });
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/x');
    await user.type(screen.getByLabelText(/testbox/i), 'tb161');
    await user.clear(screen.getByLabelText(/report url/i));
    await user.type(screen.getByLabelText(/report url/i), 'https://report.example/x?buildStartTime=1');
    expect(screen.getByRole('button', { name: /start triage/i })).toBeDisabled();
    expect(screen.getByText(/fulltestbuildname/i)).toBeInTheDocument();
  });

  it('enables submit once every field is valid, and posts the full body on submit', async () => {
    stubConfigFetch({ configured: false });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<StartScreen onStart={onStart} onBrowseBuilds={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
    await user.type(screen.getByLabelText(/testbox/i), 'tb161');
    await user.clear(screen.getByLabelText(/report url/i));
    await user.type(screen.getByLabelText(/report url/i), GOOD_URL);

    const submit = screen.getByRole('button', { name: /start triage/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onStart).toHaveBeenCalledWith('/tmp/web-test', GOOD_URL, 'tb161', 'confirm-applies', 'new', false);
  });

  it('maps the policy dropdown labels to the right permissionPolicy values', async () => {
    stubConfigFetch({ configured: false });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<StartScreen onStart={onStart} onBrowseBuilds={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
    await user.type(screen.getByLabelText(/testbox/i), 'tb161');
    await user.clear(screen.getByLabelText(/report url/i));
    await user.type(screen.getByLabelText(/report url/i), GOOD_URL);

    await user.click(screen.getByRole('button', { name: 'permissions' }));
    expect(screen.getByRole('option', { name: /confirm applies/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /auto-approve recipe fixes/i }));

    await user.click(screen.getByRole('button', { name: /start triage/i }));
    expect(onStart).toHaveBeenCalledWith('/tmp/web-test', GOOD_URL, 'tb161', 'autonomous', 'new', false);
  });

  it('renders a "latest builds →" button that navigates to the builds board', async () => {
    stubConfigFetch({ configured: false });
    const onBrowseBuilds = vi.fn();
    render(<StartScreen onStart={vi.fn()} onBrowseBuilds={onBrowseBuilds} />);
    await userEvent.click(screen.getByRole('button', { name: /latest builds/i }));
    expect(onBrowseBuilds).toHaveBeenCalledTimes(1);
  });

  describe('demo toggle', () => {
    const DEMO_URL = 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=demo';

    afterEach(() => {
      window.history.pushState(null, '', '/');
    });

    it('is not rendered for an ordinary triage session', async () => {
      stubConfigFetch({ configured: false });
      render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} prefillReportUrl={GOOD_URL} />);
      expect(screen.queryByRole('checkbox', { name: /demo/i })).not.toBeInTheDocument();
    });

    it('renders when the deep-linked report URL carries fullTestBuildName=demo', async () => {
      stubConfigFetch({ configured: false });
      render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} prefillReportUrl={DEMO_URL} />);
      expect(screen.getByRole('checkbox', { name: /demo/i })).toBeInTheDocument();
    });

    it('renders when the page URL carries ?demo', async () => {
      window.history.pushState(null, '', '/?demo');
      stubConfigFetch({ configured: false });
      render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} />);
      expect(screen.getByRole('checkbox', { name: /demo/i })).toBeInTheDocument();
    });

    it('checking it relaxes URL/testbox validation and posts demo: true', async () => {
      stubConfigFetch({ configured: false });
      const onStart = vi.fn().mockResolvedValue(undefined);
      render(<StartScreen onStart={onStart} onBrowseBuilds={vi.fn()} prefillReportUrl={DEMO_URL} />);
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/^project path$/i), '/tmp/demo-project');
      // Deliberately malformed testbox — a real triage session would block on this.
      await user.type(screen.getByLabelText(/testbox/i), 'not-a-testbox');
      const submit = screen.getByRole('button', { name: /start triage/i });
      expect(submit).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /demo/i }));
      expect(submit).toBeEnabled();

      await user.click(submit);
      expect(onStart).toHaveBeenCalledWith(
        '/tmp/demo-project',
        DEMO_URL,
        'not-a-testbox',
        'confirm-applies',
        'new',
        true
      );
    });
  });

  describe('same-projectPath 409 conflict', () => {
    it('hands off to onConflict (with a working retry) instead of showing an inline error', async () => {
      stubConfigFetch({ configured: false });
      const onStart = vi.fn();
      onStart.mockRejectedValueOnce(new RunConflictError('conflicting-run-id'));
      onStart.mockResolvedValueOnce(undefined); // the retry (override) succeeds
      const onConflict = vi.fn();
      render(<StartScreen onStart={onStart} onBrowseBuilds={vi.fn()} onConflict={onConflict} prefillReportUrl={GOOD_URL} />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
      await user.type(screen.getByLabelText(/testbox/i), 'tb161');

      await user.click(screen.getByRole('button', { name: /start triage/i }));

      await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
      expect(onConflict).toHaveBeenCalledWith('conflicting-run-id', expect.any(Function));
      // No dead-end inline error banner underneath what should be a dialog.
      expect(screen.queryByText(/conflicting-run-id/i)).not.toBeInTheDocument();

      // The retry closure re-submits the same fields with override: true.
      const retry = onConflict.mock.calls[0][1] as () => Promise<void>;
      await retry();
      expect(onStart).toHaveBeenLastCalledWith('/tmp/web-test', GOOD_URL, 'tb161', 'confirm-applies', 'new', false, true);
    });

    it('falls back to the plain inline error when no onConflict handler is wired up', async () => {
      stubConfigFetch({ configured: false });
      const onStart = vi.fn().mockRejectedValueOnce(new RunConflictError('conflicting-run-id'));
      render(<StartScreen onStart={onStart} onBrowseBuilds={vi.fn()} prefillReportUrl={GOOD_URL} />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
      await user.type(screen.getByLabelText(/testbox/i), 'tb161');
      await user.click(screen.getByRole('button', { name: /start triage/i }));
      expect(await screen.findByText(/already running/i)).toBeInTheDocument();
    });
  });

  describe('banner and afterForm slots', () => {
    it('renders an optional banner above the form and afterForm content below it', () => {
      stubConfigFetch({ configured: false });
      render(
        <StartScreen
          onStart={vi.fn()}
          onBrowseBuilds={vi.fn()}
          banner={<div>1 triage running — view</div>}
          afterForm={<div>previous triages go here</div>}
        />
      );
      expect(screen.getByText('1 triage running — view')).toBeInTheDocument();
      expect(screen.getByText('previous triages go here')).toBeInTheDocument();
    });

    it('renders neither slot when not provided', () => {
      stubConfigFetch({ configured: false });
      render(<StartScreen onStart={vi.fn()} onBrowseBuilds={vi.fn()} />);
      expect(screen.queryByText(/triage running/i)).not.toBeInTheDocument();
    });
  });
});
