/**
 * Avvisi fissi in alto: ogni conferma o errore resta visibile qualunque sia
 * il punto della pagina in cui si trova l'utente (su telefono l'errore sotto
 * al pannello finiva fuori schermo e sembrava che "non succedesse niente").
 * Errori: restano finché non si chiudono. Conferme: spariscono da sole.
 */
const ICONS = { error: '!', success: '✓', info: 'i' };

export function Toaster({ toasts, onDismiss }) {
  if (!toasts.length) {
    return null;
  }
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-icon" aria-hidden="true">{ICONS[toast.kind] ?? ICONS.info}</span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.detail ? <span>{toast.detail}</span> : null}
          </div>
          <div className="toast-actions">
            {toast.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.action.onClick();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(toast.id)}
              aria-label="Chiudi avviso"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
