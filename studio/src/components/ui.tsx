import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, CircleNotch, Copy, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import { copyText } from '../lib/hooks';

// ------------------------------------------------------------------ toasts
type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 6000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>
            {t.err ? <WarningCircle size={16} /> : <CheckCircle size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ small bits
export function Spinner({ size = 16 }: { size?: number }) {
  return <CircleNotch size={size} className="spin" aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner /> <span style={{ marginLeft: 8 }}>{label}</span>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode }) {
  const Icon = kind === 'warn' ? Warning : kind === 'err' ? WarningCircle : kind === 'ok' ? CheckCircle : Info;
  return (
    <div className={`notice ${kind === 'info' ? '' : kind}`}>
      <Icon size={15} />
      <div>{children}</div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className = 'pill sm' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } else toast('Could not copy to the clipboard', true);
      }}
    >
      {className.includes('btn-dark') && <Copy size={15} />}
      {done ? 'Copied' : label}
    </button>
  );
}

// ------------------------------------------------------------------ modal & confirm
export function Modal({ onClose, children, label, wide }: { onClose: () => void; children: ReactNode; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-dark');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Rendered at the page root, so a modal opened from inside a drawer isn't clipped or stacked under it.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} ref={ref}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the button. */
  typeToConfirm?: string;
};

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setTyped('');
    setState({ ...o, resolve });
  }), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const blocked = !!state?.typeToConfirm && typed !== state.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal onClose={() => close(false)} label={state.title}>
          <h2>{state.title}</h2>
          {state.body && <div className="muted">{state.body}</div>}
          {state.typeToConfirm && (
            <label className="field">
              <span>
                Type <b className="mono">{state.typeToConfirm}</b> to confirm
              </span>
              <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
          )}
          <div className="acts">
            <button type="button" className="pill md" onClick={() => close(false)}>
              Cancel
            </button>
            <button type="button" className={`btn-dark md${state.danger ? ' danger' : ''}`} disabled={blocked} onClick={() => close(true)}>
              {state.confirm || 'Confirm'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

/** Wraps an async action with busy state and error toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const out = await fn();
        if (success) toast(success);
        return out;
      } catch (e) {
        toast((e as Error).message || 'Something went wrong', true);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
