import { formatClock } from '../lib/time.js';

export function BookmarksPanel({
  bookmarks,
  onJump,
  onRemove,
  onNoteChange,
  disabled,
}) {
  if (bookmarks.length === 0) {
    return (
      <div className="bookmarks-panel bookmarks-empty">
        <p className="section-label">Segnalibri</p>
        <p className="empty-text">
          Nessun segnalibro. Premi <kbd>B</kbd> durante l&apos;ascolto per marcare un
          passaggio importante e aggiungere una nota.
        </p>
      </div>
    );
  }

  return (
    <div className="bookmarks-panel">
      <p className="section-label">Segnalibri</p>
      <ul className="bookmark-list">
        {bookmarks.map((bookmark) => (
          <li key={bookmark.id} className="bookmark-row">
            <button
              type="button"
              className="bookmark-timestamp"
              onClick={() => onJump(bookmark.id)}
              disabled={disabled}
              title="Salta a questo punto"
            >
              {formatClock(bookmark.position)}
            </button>
            <input
              type="text"
              className="bookmark-note"
              value={bookmark.note}
              placeholder="Nota rapida…"
              onChange={(event) => onNoteChange(bookmark.id, event.target.value)}
              disabled={disabled}
            />
            <button
              type="button"
              className="bookmark-remove"
              onClick={() => onRemove(bookmark.id)}
              disabled={disabled}
              title="Rimuovi segnalibro"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
