import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal } from './ui';

/*
 * Branded, promise-based replacements for the native window.confirm / prompt / alert.
 * Native dialogs are the one piece of raw OS chrome left in the cabinet — un-themed,
 * and on phones a jarring grey system sheet. These render the same branded Modal the
 * rest of the app uses (focus trap, Escape, scroll-lock, stacking) and resolve a promise,
 * so call sites stay a one-liner: `if (await confirmDialog({ title })) …`.
 * UI only: the guarded actions and their conditions are unchanged.
 */

type Base = { title: string; body?: string; confirmText?: string };
type ConfirmReq = Base & { kind: 'confirm'; id: number; cancelText?: string; danger?: boolean; resolve: (v: boolean) => void };
type AlertReq = Base & { kind: 'alert'; id: number; resolve: () => void };
type PromptReq = Base & {
  kind: 'prompt';
  id: number;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  minLength?: number;
  /** require the typed value to equal this exactly (e.g. «введите точное название») before confirming */
  mustMatch?: string;
  mono?: boolean;
  resolve: (v: string | null) => void;
};
type Req = ConfirmReq | AlertReq | PromptReq;

let stack: Req[] = [];
const subs = new Set<() => void>();
let seq = 0;
const emit = () => {
  stack = [...stack];
  subs.forEach((s) => s());
};
const push = (r: Req) => {
  stack.push(r);
  emit();
};
const drop = (id: number) => {
  stack = stack.filter((r) => r.id !== id);
  emit();
};

export function confirmDialog(o: Omit<ConfirmReq, 'kind' | 'id' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => push({ ...o, kind: 'confirm', id: ++seq, resolve }));
}
export function alertDialog(o: Omit<AlertReq, 'kind' | 'id' | 'resolve'>): Promise<void> {
  return new Promise((resolve) => push({ ...o, kind: 'alert', id: ++seq, resolve }));
}
export function promptDialog(o: Omit<PromptReq, 'kind' | 'id' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => push({ ...o, kind: 'prompt', id: ++seq, resolve }));
}

const settleConfirm = (r: ConfirmReq, v: boolean) => {
  r.resolve(v);
  drop(r.id);
};
const settleAlert = (r: AlertReq) => {
  r.resolve();
  drop(r.id);
};
const settlePrompt = (r: PromptReq, v: string | null) => {
  r.resolve(v);
  drop(r.id);
};

function Body({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="-mt-2 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{text}</p>;
}

function ConfirmView({ req }: { req: ConfirmReq }) {
  return (
    <Modal title={req.title} onClose={() => settleConfirm(req, false)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settleConfirm(req, true);
        }}
      >
        <Body text={req.body} />
        <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={() => settleConfirm(req, false)}>
            {req.cancelText ?? 'Отмена'}
          </button>
          <button type="submit" className={req.danger ? 'btn-danger' : 'btn-primary'} autoFocus={!req.danger}>
            {req.confirmText ?? 'Подтвердить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AlertView({ req }: { req: AlertReq }) {
  return (
    <Modal title={req.title} onClose={() => settleAlert(req)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settleAlert(req);
        }}
      >
        <Body text={req.body} />
        <div className="mt-6 flex justify-end">
          <button type="submit" className="btn-primary" autoFocus>
            {req.confirmText ?? 'Понятно'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PromptView({ req }: { req: PromptReq }) {
  const [v, setV] = useState(req.defaultValue ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
      ref.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const val = v.trim();
  const ok = (req.minLength ? val.length >= req.minLength : true) && (req.mustMatch ? val === req.mustMatch.trim() : true);
  return (
    <Modal title={req.title} onClose={() => settlePrompt(req, null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) settlePrompt(req, v);
        }}
      >
        <Body text={req.body} />
        <div className="mt-4">
          {req.label && (
            <label className="label" htmlFor={`prompt-${req.id}`}>
              {req.label}
            </label>
          )}
          <input
            id={`prompt-${req.id}`}
            ref={ref}
            className={`input ${req.mono ? 'font-mono' : ''}`}
            value={v}
            placeholder={req.placeholder}
            onChange={(e) => setV(e.target.value)}
            minLength={req.minLength}
          />
          {req.minLength ? <p className="mt-1.5 text-[11.5px] text-muted-foreground">не&nbsp;короче {req.minLength}&nbsp;символов</p> : null}
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={() => settlePrompt(req, null)}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={!ok}>
            {req.confirmText ?? 'Готово'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DialogHost() {
  const s = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => stack,
    () => stack,
  );
  return (
    <>
      {s.map((r) => (r.kind === 'confirm' ? <ConfirmView key={r.id} req={r} /> : r.kind === 'alert' ? <AlertView key={r.id} req={r} /> : <PromptView key={r.id} req={r} />))}
    </>
  );
}
