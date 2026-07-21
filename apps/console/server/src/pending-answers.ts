type Pending = { questionId: string; resolve: (answers: Record<string, unknown>) => void; reject: () => void };

/**
 * Bridges the in-process `canUseTool` callback (which is `await`-blocked on
 * an operator answer) with the HTTP `POST /api/runs/:runId/answer` route
 * running in a completely separate request. One pending question per run at
 * a time — the driver only ever asks one AskUserQuestion at once.
 */
class PendingAnswers {
  private byRun = new Map<string, Pending>();

  register(runId: string, questionId: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const prev = this.byRun.get(runId);
      if (prev) prev.reject();
      this.byRun.set(runId, { questionId, resolve: (a) => resolve(a), reject });
    });
  }

  resolve(runId: string, questionId: string, answers: Record<string, unknown>): boolean {
    const p = this.byRun.get(runId);
    if (!p || p.questionId !== questionId) return false;
    this.byRun.delete(runId);
    p.resolve(answers);
    return true;
  }

  rejectAll(runId: string): void {
    const p = this.byRun.get(runId);
    if (p) {
      this.byRun.delete(runId);
      p.reject();
    }
  }
}

export const pendingAnswers = new PendingAnswers();
