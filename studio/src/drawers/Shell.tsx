import type { ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { useStudio } from '../ctx';

/** Right-hand drawer on desktop, bottom sheet on phones (as in the Atlas design). */
export function Shell(props: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean; label: string }) {
  const { mobile, close } = useStudio();
  const head = (
    <div className="drawer-head">
      <div className="tt">
        <div className="t">{props.title}</div>
        {props.sub && <div className="s">{props.sub}</div>}
      </div>
      <div className="acts">
        {props.actions}
        <button className="icon-btn" aria-label="Close" onClick={close}>
          <X size={mobile ? 17 : 15} />
        </button>
      </div>
    </div>
  );
  if (mobile) {
    return (
      <>
        <div className="sheet-backdrop" onClick={close} />
        <div className="sheet" role="dialog" aria-modal="true" aria-label={props.label}>
          <div className="grabber" />
          {head}
          <div className="drawer-body" style={{ paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            {props.children}
          </div>
        </div>
      </>
    );
  }
  return (
    <aside className={`drawer${props.wide ? ' wide' : ''}`} aria-label={props.label}>
      {head}
      <div className="drawer-body">{props.children}</div>
    </aside>
  );
}
