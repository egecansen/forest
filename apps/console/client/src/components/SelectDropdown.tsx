import { useEffect, useRef, useState } from 'react';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  badge?: string;
  description?: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: DropdownOption<T>[];
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Generic custom dropdown that shares the MODE dropdown's look (.dropdown*
 * classes). Used for run-mode and permissions so every selector on the start
 * screen is visually consistent.
 */
export function SelectDropdown<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: Props<T>) {
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

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`dropdown-button ${open ? 'open' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="dropdown-current">
          <span className="dropdown-label">{current.label}</span>
          {current.badge && <span className="dropdown-badge">{current.badge}</span>}
        </span>
        <span className="dropdown-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map((o) => (
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
                {o.badge && <span className="dropdown-badge">{o.badge}</span>}
              </span>
              {o.description && <span className="dropdown-item-desc">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
