import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveRunsDirSync, DEFAULT_ROOT } from '../persistence.js';

describe('resolveRunsDirSync', () => {
  it('resolves the runs dir under the given root', () => {
    expect(resolveRunsDirSync('/tmp/x')).toBe(path.join('/tmp/x', 'runs'));
  });

  it('defaults to the hektor home root', () => {
    expect(resolveRunsDirSync()).toBe(path.join(DEFAULT_ROOT, 'runs'));
  });
});
