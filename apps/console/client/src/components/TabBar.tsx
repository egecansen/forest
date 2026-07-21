import type { ReactNode } from 'react';

export type TabId = 'log' | 'timeline' | 'files' | 'report';

export interface TabDef {
  id: TabId;
  label: string;
  badge?: number | null;
  icon: string;     // single character glyph rendered in mono
  disabled?: boolean;
}

interface Props {
  tabs: TabDef[];
  active: TabId;
  unseen: Partial<Record<TabId, boolean>>;
  onSelect: (id: TabId) => void;
  trailing?: ReactNode;
}

export function TabBar({ tabs, active, unseen, onSelect, trailing }: Props) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          disabled={t.disabled}
          className={`tab ${t.id === active ? 'is-active' : ''} ${t.disabled ? 'is-disabled' : ''}`}
          onClick={() => !t.disabled && onSelect(t.id)}
        >
          <span className="tab-icon" aria-hidden>{t.icon}</span>
          <span className="tab-label">{t.label}</span>
          {typeof t.badge === 'number' && t.badge > 0 && (
            <span className="tab-badge">{t.badge}</span>
          )}
          {unseen[t.id] && t.id !== active && (
            <span className="tab-unseen" aria-label="new" />
          )}
        </button>
      ))}
      {trailing && <div className="tab-trailing">{trailing}</div>}
    </div>
  );
}
