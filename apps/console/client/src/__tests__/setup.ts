// Extends vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// for component tests. Harmless for plain logic tests — it only registers
// matchers, it doesn't touch the DOM at import time.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest.config.ts doesn't set `test.globals: true`, so @testing-library/react's
// automatic per-test DOM cleanup (which hooks a global `afterEach`) never fires —
// without this, a second render() in the same file leaves the first render's DOM
// behind and getByRole/getByText start matching duplicates across tests.
afterEach(() => {
  cleanup();
});
