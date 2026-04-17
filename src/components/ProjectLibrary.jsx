import { formatBytes, formatClock } from '../lib/time.js';

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return '—';
  }
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) {
    return 'pochi secondi fa';
  }
  if (diff < hour) {
    const minutes = Math.round(diff / minute);
    return `${minutes} minut${minutes === 1 ? 'o' : 'i'} fa`;
  }
  if (diff < day) {
    const hours = Math.round(diff / hour);
    return `${hours} or${hours === 1 ? 'a' : 'e'} fa`;
  }
  const days = Math.round(diff / day);
  if (days <= 30) {
    return `${days} giorn${days === 1 ? 'o' : 'i'} fa`;
  }
  return new Date(timestamp).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function ProjectLibrary({
  projects,
  currentProjectId,
  onOpen,
  onDelete,
  onClose,
  onRefresh,
  isLoading,
  disabled,
}) {
  return (
    <section className="project-library">
      <header className="library-head">
        <div>
          <p className="section-label">Progetti salvati</p>
          <h3>Riprendi dove avevi lasciato</h3>
        </div>
        <div className="library-head-actions">
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={isLoading}>
            Aggiorna
          </button>
          {onClose ? (
            <button type="button" className="ghost-button" onClick={onClose}>
              Chiudi
            </button>
          ) : null}
        </div>
      </header>

      {isLoading ? <p className="helper-text">Carico…</p> : null}

      {!isLoading && projects.length === 0 ? (
        <p className="empty-text">
          Nessun progetto salvato. Usa il pulsante «Salva progetto» accanto all&apos;export per
          conservare un file con i tagli e i segnalibri.
        </p>
      ) : null}

      {!isLoading && projects.length > 0 ? (
        <ul className="project-list">
          {projects.map((project) => {
            const isCurrent = project.id === currentProjectId;
            return (
              <li
                key={project.id}
                className={isCurrent ? 'project-row project-current' : 'project-row'}
              >
                <button
                  type="button"
                  className="project-main"
                  onClick={() => onOpen(project.id)}
                  disabled={disabled}
                >
                  <strong>{project.name || project.audioName || 'Senza nome'}</strong>
                  <span className="project-meta">
                    <span>{formatClock(project.duration)}</span>
                    <span>{formatBytes(project.size)}</span>
                    <span>{project.cutsCount} tagli</span>
                    <span>{project.bookmarksCount} segnalibri</span>
                    <span>{formatRelativeTime(project.updatedAt)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="project-delete"
                  onClick={() => onDelete(project.id)}
                  disabled={disabled}
                  title="Elimina progetto"
                  aria-label="Elimina progetto"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
