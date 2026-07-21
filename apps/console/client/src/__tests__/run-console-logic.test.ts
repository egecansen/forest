import { describe, it, expect } from 'vitest';
import { shouldAutoSwitchToClusters } from '../components/RunConsole';

describe('shouldAutoSwitchToClusters', () => {
  it('switches on the first non-empty cluster list when the user has not picked a tab', () => {
    expect(
      shouldAutoSwitchToClusters({ clusterCount: 2, userPickedTab: false, alreadyAutoSwitched: false })
    ).toBe(true);
  });

  it('does not switch while the cluster list is still empty', () => {
    expect(
      shouldAutoSwitchToClusters({ clusterCount: 0, userPickedTab: false, alreadyAutoSwitched: false })
    ).toBe(false);
  });

  it('does not fight a manual tab pick, even on first arrival', () => {
    expect(
      shouldAutoSwitchToClusters({ clusterCount: 2, userPickedTab: true, alreadyAutoSwitched: false })
    ).toBe(false);
  });

  it('only auto-switches once — a later re-arrival does not re-trigger it', () => {
    expect(
      shouldAutoSwitchToClusters({ clusterCount: 3, userPickedTab: false, alreadyAutoSwitched: true })
    ).toBe(false);
  });
});
