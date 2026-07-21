import { describe, expect, it } from 'vitest';
import { makeCanUseTool } from '../driver-can-use-tool.js';
import { pendingAnswers } from '../pending-answers.js';
import { runStore } from '../run-store.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

describe('question bridge', () => {
  it('AskUserQuestion blocks on the operator answer, then allows with updatedInput', async () => {
    const run = runStore.create(cfg);
    const canUseTool = makeCanUseTool(run);
    const input = { questions: [{ question: 'Which clusters?', header: 'Pick', multiSelect: true,
      options: [{ label: 'onetrust' }, { label: 'vrt-drift' }] }] };
    const p = canUseTool('AskUserQuestion', input, {});
    // The run is now awaiting input with a pending question:
    await new Promise((r) => setTimeout(r, 0));
    const q = run.snapshot.pendingQuestion!;
    expect(run.snapshot.status).toBe('awaiting-input');
    expect(q.questions[0].options.map((o) => o.label)).toEqual(['onetrust', 'vrt-drift']);
    // Operator answers via the HTTP route's registry:
    pendingAnswers.resolve(run.snapshot.config!.runId, q.questionId, { 'Which clusters?': ['onetrust'] });
    const result = await p;
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow')
      expect((result.updatedInput as { answers: unknown }).answers).toEqual({ 'Which clusters?': ['onetrust'] });
    expect(run.snapshot.pendingQuestion).toBeNull();
    expect(run.snapshot.phases.find((ph) => ph.id === 'pick')?.status).toBe('done');
  });

  it('a stopped run rejects the pending question → deny', async () => {
    const run = runStore.create(cfg);
    const canUseTool = makeCanUseTool(run);
    const p = canUseTool('AskUserQuestion', { questions: [{ question: 'q', header: 'h', multiSelect: false,
      options: [{ label: 'a' }] }] }, {});
    await new Promise((r) => setTimeout(r, 0));
    run.stop();  // rejectAll unblocks the bridge
    const result = await p;
    expect(result.behavior).toBe('deny');
  });

  it('non-question tools pass through', async () => {
    const run = runStore.create(cfg);
    const result = await makeCanUseTool(run)('Bash', { command: 'ls' }, {});
    expect(result.behavior).toBe('allow');
  });
});
