import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { Telemetry } from '../types';

const TELEMETRY: Telemetry = { startedAt: null, elapsedMs: 0, tokens: 0, thinking: false };

describe('Sidebar outputs card', () => {
  it('does not render a tests stat — nothing in production driver code ever calls run.addTest', () => {
    render(
      <Sidebar
        phases={[]}
        activePhase={null}
        telemetry={TELEMETRY}
        outputs={{ files: 3, tests: 0 }}
        status="running"
      />
    );
    expect(screen.queryByText('tests')).not.toBeInTheDocument();
  });

  it('still renders the files stat', () => {
    render(
      <Sidebar
        phases={[]}
        activePhase={null}
        telemetry={TELEMETRY}
        outputs={{ files: 3, tests: 0 }}
        status="running"
      />
    );
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
