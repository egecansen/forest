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

        <div className="info-kicker">readme &middot; v1</div>

        <section className="info-section">
          <h2 className="info-h">what is hektor?</h2>
          <p className="info-p">
            hektor is an autonomous QA pipeline. Point it at your project, give it a
            URL, and it spins up an end-to-end testing engine that maps your app,
            writes Playwright tests, hunts bugs, and produces a stakeholder-ready
            report — without you writing a single test.
          </p>
        </section>

        <section className="info-section">
          <h2 className="info-h">how to run</h2>
          <ol className="info-steps">
            <li>
              <span className="info-num">01</span>
              <div className="info-step-body">
                <div className="info-step-label">project path</div>
                <p className="info-p">
                  Absolute path to a directory where hektor can install tests and
                  write its scaffold.
                </p>
                <div className="info-example">▸ /Users/you/work/my-app</div>
              </div>
            </li>
            <li>
              <span className="info-num">02</span>
              <div className="info-step-body">
                <div className="info-step-label">target url</div>
                <p className="info-p">
                  The deployed URL of the app you want tested. Must be reachable from
                  this machine.
                </p>
                <div className="info-example">▸ https://staging.your-app.com</div>
              </div>
            </li>
            <li>
              <span className="info-num">03</span>
              <div className="info-step-body">
                <div className="info-step-label">mode</div>
                <p className="info-p">
                  Pick what kind of run you want — see the five modes below. For a
                  fresh project, choose <em>onboarding</em>.
                </p>
              </div>
            </li>
            <li>
              <span className="info-num">04</span>
              <div className="info-step-body">
                <div className="info-step-label">start</div>
                <p className="info-p">
                  Hit <span className="kbd">start a pilot</span> and watch the console
                  for live progress. Interrupt anytime with{' '}
                  <span className="kbd">esc</span>.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="info-section">
          <h2 className="info-h">modes</h2>
          <dl className="info-modes">
            <div className="info-mode-row">
              <dt>
                onboarding <span className="info-badge">full pipeline</span>
              </dt>
              <dd>
                Zero → maintained suite, eight phases end-to-end. Use this the first
                time on a new app.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>
                coverage expansion <span className="info-badge">grow</span>
              </dt>
              <dd>
                Iterates the journey map and grows the test suite per journey. Use
                after onboarding to deepen coverage.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>
                bug discovery <span className="info-badge">hunt</span>
              </dt>
              <dd>
                Adversarial pass that produces a deduplicated findings ledger. Use to
                break the app and surface edge cases.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>
                suite repair <span className="info-badge">fix</span>
              </dt>
              <dd>
                Batch-clusters failing tests and heals them by shared root cause. Use
                after an app change broke many tests.
              </dd>
            </div>
            <div className="info-mode-row">
              <dt>
                companion <span className="info-badge">verify</span>
              </dt>
              <dd>
                Single-task evidence-first verification with screenshots + trace. Use
                for daily QA tasks needing proof.
              </dd>
            </div>
          </dl>
        </section>

        <section className="info-section">
          <h2 className="info-h">what to expect</h2>
          <ul className="info-bullets">
            <li>
              Live streaming updates with timestamps as phases tick through:{' '}
              <span className="info-mono">
                groundwork → crawl → automate → map → cover → hunt → repair → report
              </span>
              .
            </li>
            <li>
              Interrupt anytime with <span className="kbd">esc</span>.
            </li>
            <li>
              When the run finishes, the <em>findings</em>, <em>files</em>, and{' '}
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
