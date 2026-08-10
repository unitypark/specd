'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * The one confirmation primitive. Destructive actions never fire straight
 * from the click — the dialog restates what will actually happen, and the
 * irreversible ones demand the name typed back, because muscle memory clicks
 * through buttons but does not type through them.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  requireText,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** When set, the confirm button unlocks only once this exact text is typed. */
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const locked = requireText ? typed !== requireText : false;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <>
      <button type="button" className="scrim" onClick={onCancel} aria-label="Close" />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h4>{title}</h4>
        <div className="body">{body}</div>
        {requireText && (
          <div className="field">
            <label htmlFor="confirm-text">
              Type <b className="mono">{requireText}</b> to confirm
            </label>
            <input
              id="confirm-text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        {error && <div className="err">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy || locked} onClick={onConfirm}>
            {busy && <span className="spinner" />} {confirmLabel}
          </button>
        </div>
      </div>
      <style jsx>{`
        .scrim {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          border: none;
          z-index: 60;
          cursor: default;
        }
        .dialog {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 61;
          width: min(28rem, calc(100vw - 2rem));
          background: var(--panel);
          border: 1px solid var(--line-2);
          border-radius: var(--radius);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
          padding: 1.2rem 1.3rem 1.1rem;
        }
        h4 {
          font: 600 1.1rem/1.3 var(--sans);
          margin: 0 0 0.5rem;
        }
        .body {
          font-size: 0.94rem;
          color: var(--ink-2);
          line-height: 1.6;
          margin-bottom: 0.9rem;
        }
        .body :global(b) {
          color: var(--ink);
        }
        .mono {
          font-family: var(--mono);
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-top: 1rem;
        }
        .actions :global(.spinner) {
          margin-right: 0.35rem;
        }
      `}</style>
    </>
  );
}
