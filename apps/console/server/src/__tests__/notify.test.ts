import { describe, expect, it, vi } from 'vitest';
import { makeNotifier } from '../notify.js';

describe('notify', () => {
  it('shells out to osascript on darwin', () => {
    const exec = vi.fn();
    vi.stubEnv('NODE_ENV', 'dev');
    const n = makeNotifier('darwin', exec);
    n.decision('clusters ready');
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toBe('osascript');
    expect(exec.mock.calls[0][1].join(' ')).toContain('clusters ready');
  });
  it('no-ops elsewhere', () => {
    const exec = vi.fn();
    makeNotifier('linux', exec).decision('x');
    expect(exec).not.toHaveBeenCalled();
  });
  it('escapes double quotes out of the message', () => {
    const exec = vi.fn();
    vi.stubEnv('NODE_ENV', 'dev');
    makeNotifier('darwin', exec).decision('say "hi" \\');
    expect(exec.mock.calls[0][1].join(' ')).not.toContain('"hi"');
  });
});
