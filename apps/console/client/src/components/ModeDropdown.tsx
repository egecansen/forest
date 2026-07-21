import { useEffect, useRef, useState } from 'react';
import type { RunConfig } from '../types';

interface ModeOption {
  value: RunConfig['mode'];
  label: string;
  description: string;
  badge: string;
}

const OPTIONS: ModeOption[] = [
  {
    value: 'onboarding',
    label: 'Onboarding',
    description: 'Zero → maintained suite, eight phases end-to-end.',
    badge: 'full pipeline',
  },
  {
    value: 'coverage-expansion',
    label: 'Coverage expansion',
    description: 'Iterates the journey map and grows the suite per journey.',
    badge: 'grow',
  },
  {
    value: 'bug-discovery',
    label: 'Bug discovery',
    description: 'Adversarial pass that produces a deduplicated findings ledger.',
    badge: 'hunt',
  },
  {
    value: 'repair',
    label: 'Suite repair',
    description: 'Batch-cluster failing tests and heal them by shared root cause.',
    badge: 'fix',
  },
  {
    value: 'companion',
    label: 'Companion mode',
    description: 'Single-task evidence-first verification with screenshots + trace.',
    badge: 'verify',
  },
];

interface Props {
  value: RunConfig['mode'];
  onChange: (v: RunConfig['mode']) => void;
}

export function ModeDropdown({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`dropdown-button ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="dropdown-current">
          <span className="dropdown-label">{current.label}</span>
          <span className="dropdown-badge">{current.badge}</span>
        </span>
        <span className="dropdown-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-item ${o.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="dropdown-item-head">
                <span className="dropdown-item-label">{o.label}</span>
                <span className="dropdown-badge">{o.badge}</span>
              </span>
              <span className="dropdown-item-desc">{o.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { OPTIONS as MODE_OPTIONS };
