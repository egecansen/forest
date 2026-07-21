import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function InfoDrawer({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`info-backdrop ${open ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`info-drawer ${open ? 'open' : ''}`}
        aria-hidden={!open}
        aria-label="hektor readme"
        role="dialog"
      >
        <button
          type="button"
          className="info-close"
          onClick={onClose}
          aria-label="close readme"
        >
          ✕
        </button>

        <div className="info-kicker">README · V1</div>

        <section className="info-section">
          <h2 className="info-h">what is hektor?</h2>
          <p className="info-p">
            hektor is a flaky-triage console. point it at a red selenium build and
            it re-runs the failures on your testbox, clusters them by root cause,
            and — once you pick the clusters worth fixing — repairs them
            end-to-end, proven green over repeated runs. suspected app bugs get
            flagged with evidence, never masked.
          </p>
        </section>

        <section className="info-section">
          <h2 className="info-h">how to run</h2>
          <ol className="info-steps">
            <li>
              <span className="info-num">01</span>
              <div className="info-step-body">
                <div className="info-step-label">pick a build</div>
                <p className="info-p">
                  the board lists the latest flaky and tag runs. anything red with
                  a report lands in needs triage.
                </p>
                <div className="info-example">▸ needs triage → triage</div>
                <p className="info-p">no board? paste an s-report url instead.</p>
              </div>
            </li>
            <li>
              <span className="info-num">02</span>
              <div className="info-step-body">
                <div className="info-step-label">confirm the session</div>
                <p className="info-p">
                  repo path, testbox (prefilled from the build's own parameters),
                  and the apply policy — confirm every apply, or auto-approve known
                  recipe fixes.
                </p>
                <div className="info-example">▸ tb161 · confirm applies</div>
              </div>
            </li>
            <li>
              <span className="info-num">03</span>
              <div className="info-step-body">
                <div className="info-step-label">make the pick</div>
                <p className="info-p">
                  the agent ingests the report, re-runs the fails on the box, and
                  presents one table, easy fix → likely bug. you choose which
                  clusters to take. that is the only required decision.
                </p>
                <div className="info-example">
                  ▸ which clusters? → onetrust, vrt-drift
                </div>
              </div>
            </li>
            <li>
              <span className="info-num">04</span>
              <div className="info-step-body">
                <div className="info-step-label">watch it converge</div>
                <p className="info-p">
                  fix → verify → report. green-proof means passing every one of N
                  reruns, not once. desktop notifications fire only when a decision
                  is needed; esc interrupts, paused runs resume.
                </p>
                <div className="info-example">▸ verifying 3/3 · ✅ green</div>
              </div>
            </li>
          </ol>
        </section>

        <section className="info-section">
          <h2 className="info-h">what it never does</h2>
          <dl className="info-modes">
            <div className="info-mode-row">
              <dt>commit</dt>
              <dd>the diff stays in your working tree. you review, you commit.</dd>
            </div>
            <div className="info-mode-row">
              <dt>file tickets</dt>
              <dd>
                app bugs are flagged with evidence, in the report — nothing is
                filed anywhere.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>disable tests</dt>
              <dd>
                no @ScheduledDisable, ever. a test is fixed green or handed back
                with a verdict.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>touch prod</dt>
              <dd>
                testbox only. the suite, the reruns, the dom captures — all on
                your box.
              </dd>
            </div>
          </dl>
        </section>

        <section className="info-section">
          <h2 className="info-h">what to expect</h2>
          <ul className="info-bullets">
            <li>
              live streaming updates with timestamps as phases tick through:{' '}
              <span className="info-mono">
                ingest → cluster → pick → fix → verify → report
              </span>
              .
            </li>
            <li>
              interrupt anytime with <span className="kbd">esc</span>.
            </li>
            <li>
              when the run finishes, the <em>clusters</em>, <em>files</em>, and{' '}
              <em>report</em> tabs are populated with shareable evidence.
            </li>
          </ul>
        </section>

        <footer className="info-foot">
          press <span className="kbd">esc</span> or click outside to close
        </footer>
      </aside>
    </>
  );
}
