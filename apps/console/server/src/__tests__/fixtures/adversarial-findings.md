# Adversarial findings

- **login-p1-01** [critical] — Race condition allows double-charge under fast double-click
  - scope: checkout
  - expected: idempotency lock prevents a second POST
  - observed: two POST /api/checkout/confirm succeed
  - coverage: tests/e2e/specs/checkout.spec.ts
- **search-p2-03** [medium] — Empty-query submission triggers 500 instead of validation
  - scope: search
  - expected: 400 with a field error
  - observed: 500 Internal Server Error
- **settings-p3-02** [info] — Toggle lacks aria-pressed (DOM-only)
  - scope: a11y
