import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StartScreen } from '../components/StartScreen';

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
    render(<StartScreen onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/project path/i)).toHaveValue('/repo/web-test'));
    expect(screen.getByLabelText(/testbox/i)).toHaveValue('tb161');
  });

  it('prefills the report URL from prefillReportUrl over any config default', async () => {
    stubConfigFetch();
    render(<StartScreen onStart={vi.fn()} prefillReportUrl={GOOD_URL} />);
    expect(screen.getByLabelText(/report url/i)).toHaveValue(GOOD_URL);
  });

  it('disables submit and shows a hint for a malformed testbox', async () => {
    stubConfigFetch({ configured: false });
    render(<StartScreen onStart={vi.fn()} prefillReportUrl={GOOD_URL} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/x');
    const testboxInput = screen.getByLabelText(/testbox/i);
    await user.type(testboxInput, 'tb99999');
    expect(screen.getByRole('button', { name: /start triage/i })).toBeDisabled();
    expect(screen.getByText(/tb161/i)).toBeInTheDocument(); // field-note hint mentions the expected shape
  });

  it('disables submit and shows a hint for a report URL missing fullTestBuildName', async () => {
    stubConfigFetch({ configured: false });
    render(<StartScreen onStart={vi.fn()} />);
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
    render(<StartScreen onStart={onStart} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
    await user.type(screen.getByLabelText(/testbox/i), 'tb161');
    await user.clear(screen.getByLabelText(/report url/i));
    await user.type(screen.getByLabelText(/report url/i), GOOD_URL);

    const submit = screen.getByRole('button', { name: /start triage/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onStart).toHaveBeenCalledWith('/tmp/web-test', GOOD_URL, 'tb161', 'confirm-applies', 'new');
  });

  it('maps the policy dropdown labels to the right permissionPolicy values', async () => {
    stubConfigFetch({ configured: false });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<StartScreen onStart={onStart} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^project path$/i), '/tmp/web-test');
    await user.type(screen.getByLabelText(/testbox/i), 'tb161');
    await user.clear(screen.getByLabelText(/report url/i));
    await user.type(screen.getByLabelText(/report url/i), GOOD_URL);

    await user.click(screen.getByRole('button', { name: 'permissions' }));
    expect(screen.getByRole('option', { name: /confirm applies/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /auto-approve recipe fixes/i }));

    await user.click(screen.getByRole('button', { name: /start triage/i }));
    expect(onStart).toHaveBeenCalledWith('/tmp/web-test', GOOD_URL, 'tb161', 'autonomous', 'new');
  });
});
