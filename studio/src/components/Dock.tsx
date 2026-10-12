import { Archive, Clock, Lightning, Scroll, TerminalWindow, UsersThree } from '@phosphor-icons/react';
import type { ComponentType } from 'react';
import { useStudio } from '../ctx';
import type { Drawer } from '../types';

type Tool = { id: 'sql' | 'users' | 'storage' | 'functions' | 'cron' | 'service'; label: string; Icon: ComponentType<{ size?: number }> };

const TOOLS: Tool[] = [
  { id: 'sql', label: 'SQL', Icon: TerminalWindow },
  { id: 'users', label: 'Users', Icon: UsersThree },
  { id: 'storage', label: 'Storage', Icon: Archive },
  { id: 'functions', label: 'Functions', Icon: Lightning },
  { id: 'cron', label: 'Jobs', Icon: Clock },
  { id: 'service', label: 'Logs', Icon: Scroll },
];

export function Dock({ drawer, mobile = false }: { drawer: Drawer | null; mobile?: boolean }) {
  const { open, close, containers } = useStudio();
  const tools = mobile ? TOOLS.slice(0, 4) : TOOLS;
  return (
    <nav className={mobile ? 'm-dock' : 'dock'} aria-label="Tools">
      {tools.map(({ id, label, Icon }) => {
        const active = drawer?.kind === id;
        return (
          <button
            key={id}
            aria-pressed={active}
            aria-label={label}
            onClick={() => {
              if (active) return close();
              if (id === 'service') open({ kind: 'service', service: containers[0]?.service || 'keel-db' });
              else open({ kind: id } as Drawer);
            }}
          >
            <Icon size={mobile ? 18 : 16} />
            <span className="lbl">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
