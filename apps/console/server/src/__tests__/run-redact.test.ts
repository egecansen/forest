import { describe, expect, it } from 'vitest';
import { runStore } from '../run-store.js';
import { makeRedactor } from '../redact.js';
import type { Cluster, ServerEvent } from '../types.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

const SECRET = 'sekret-token-123';

describe('Run redaction', () => {
  it('redacts a secret out of a log line in both the emitted event and the snapshot', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.log({ kind: 'info', text: `using token ${SECRET} to authenticate` });

    const logEvent = events.find((e) => e.type === 'log');
    expect(logEvent && logEvent.type === 'log' ? logEvent.entry.text : undefined).toBe(
      'using token «redacted» to authenticate'
    );
    expect(run.snapshot.log[run.snapshot.log.length - 1].text).toBe(
      'using token «redacted» to authenticate'
    );
    expect(JSON.stringify(run.snapshot)).not.toContain(SECRET);
  });

  it('redacts a secret out of log detail', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    run.log({ kind: 'info', text: 'auth attempt', detail: `token=${SECRET}` });
    expect(run.snapshot.log[run.snapshot.log.length - 1].detail).toBe('token=«redacted»');
  });

  it('defaults to identity when no redactor is provided', () => {
    const run = runStore.create(cfg);
    run.log({ kind: 'info', text: `using token ${SECRET} to authenticate` });
    expect(run.snapshot.log[run.snapshot.log.length - 1].text).toBe(
      `using token ${SECRET} to authenticate`
    );
  });

  it('redacts setReportText', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setReportText(`report generated using ${SECRET}`);

    expect(run.snapshot.reportText).toBe('report generated using «redacted»');
    const reportEvent = events.find((e) => e.type === 'reportText');
    expect(reportEvent && reportEvent.type === 'reportText' ? reportEvent.reportText : undefined).toBe(
      'report generated using «redacted»'
    );
  });

  it('redacts cluster title/detail/note via setClusters and updateCluster', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    const cluster: Cluster = {
      id: 'onetrust',
      title: `leaked ${SECRET} in title`,
      bucket: 'easy-fix',
      tests: ['com.x.FooTest'],
      state: 'proposed',
      detail: `detail with ${SECRET}`,
    };
    run.setClusters([cluster]);
    expect(run.snapshot.clusters[0].title).toBe('leaked «redacted» in title');
    expect(run.snapshot.clusters[0].detail).toBe('detail with «redacted»');

    run.updateCluster('onetrust', { note: `note with ${SECRET}` });
    expect(run.snapshot.clusters[0].note).toBe('note with «redacted»');
  });

  it('redacts every text field of a pending question — question, header, option label/description', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setPendingQuestion({
      questionId: 'q1',
      questions: [
        {
          question: `pick a cluster (leaked ${SECRET})`,
          header: `header ${SECRET}`,
          multiSelect: false,
          options: [{ label: `label ${SECRET}`, description: `desc with ${SECRET} leaked` }],
        },
      ],
    });

    const stored = run.snapshot.pendingQuestion!;
    expect(stored.questions[0].question).toBe('pick a cluster (leaked «redacted»)');
    expect(stored.questions[0].header).toBe('header «redacted»');
    expect(stored.questions[0].options[0].label).toBe('label «redacted»');
    expect(stored.questions[0].options[0].description).toBe('desc with «redacted» leaked');

    const questionEvent = events.find((e) => e.type === 'question');
    expect(questionEvent && questionEvent.type === 'question' ? questionEvent.question.questions[0].options[0].description : undefined).toBe(
      'desc with «redacted» leaked'
    );
    expect(JSON.stringify(run.snapshot)).not.toContain(SECRET);
  });

  it('redacts setSubStage', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setSubStage(`stage with ${SECRET} leaked`);

    expect(run.snapshot.currentSubStage).toBe('stage with «redacted» leaked');
    const subStageEvent = events.find((e) => e.type === 'subStage');
    expect(subStageEvent && subStageEvent.type === 'subStage' ? subStageEvent.subStage : undefined).toBe(
      'stage with «redacted» leaked'
    );
  });

  it('redacts setPhase stage/subStage text', () => {
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    run.setPhase('ingest', 'active', { stage: `stage ${SECRET}`, subStage: `sub ${SECRET}` });
    const phase = run.snapshot.phases.find((p) => p.id === 'ingest')!;
    expect(phase.stage).toBe('stage «redacted»');
    expect(phase.subStage).toBe('sub «redacted»');
  });
});
