import { formatClock } from '../lib/time.js';

const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PlayerControls({
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  zoom,
  loopRegion,
  loopDraft,
  onTogglePlay,
  onSkip,
  onRateChange,
  onZoomChange,
  onSetLoopStart,
  onSetLoopEnd,
  onClearLoop,
  onAddCutHere,
  onAddBookmarkHere,
  disabled,
}) {
  const isLooping = Boolean(loopRegion);
  const waitingForEnd = loopDraft != null && !isLooping;

  return (
    <div className="player-controls">
      <div className="player-row player-row-transport">
        <button
          type="button"
          className="transport-button"
          onClick={() => onSkip(-30)}
          disabled={disabled}
          title="Indietro 30s (Shift+←)"
        >
          -30s
        </button>
        <button
          type="button"
          className="transport-button"
          onClick={() => onSkip(-5)}
          disabled={disabled}
          title="Indietro 5s (←)"
        >
          -5s
        </button>
        <button
          type="button"
          className="transport-button transport-play"
          onClick={onTogglePlay}
          disabled={disabled}
          title={isPlaying ? 'Pausa (Spazio)' : 'Play (Spazio)'}
        >
          {isPlaying ? 'Pausa' : 'Play'}
        </button>
        <button
          type="button"
          className="transport-button"
          onClick={() => onSkip(5)}
          disabled={disabled}
          title="Avanti 5s (→)"
        >
          +5s
        </button>
        <button
          type="button"
          className="transport-button"
          onClick={() => onSkip(30)}
          disabled={disabled}
          title="Avanti 30s (Shift+→)"
        >
          +30s
        </button>

        <div className="time-display">
          <strong>{formatClock(currentTime)}</strong>
          <span> / {formatClock(duration)}</span>
        </div>
      </div>

      <div className="player-row player-row-secondary">
        <div className="player-cluster">
          <label className="cluster-label">Velocità</label>
          <div className="rate-presets">
            {RATE_PRESETS.map((rate) => (
              <button
                key={rate}
                type="button"
                className={Math.abs(rate - playbackRate) < 0.01 ? 'rate-active' : ''}
                onClick={() => onRateChange(rate)}
                disabled={disabled}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>

        <div className="player-cluster">
          <label className="cluster-label" htmlFor="zoom-slider">
            Zoom
          </label>
          <input
            id="zoom-slider"
            type="range"
            min="1"
            max="400"
            step="1"
            value={zoom}
            onChange={(event) => onZoomChange(Number(event.target.value))}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="player-row player-row-tertiary">
        <div className="player-cluster">
          <label className="cluster-label">Loop A-B</label>
          <div className="loop-controls">
            <button
              type="button"
              onClick={onSetLoopStart}
              disabled={disabled}
              title="Imposta inizio loop (A)"
              className={waitingForEnd ? 'loop-waiting' : ''}
            >
              {waitingForEnd ? `A: ${formatClock(loopDraft)}` : 'Punto A'}
            </button>
            <button
              type="button"
              onClick={onSetLoopEnd}
              disabled={disabled || (!waitingForEnd && !isLooping)}
              title="Imposta fine loop (B)"
            >
              Punto B
            </button>
            <button
              type="button"
              onClick={onClearLoop}
              disabled={disabled || (!isLooping && !waitingForEnd)}
              className="loop-clear"
              title="Disattiva loop"
            >
              Reset
            </button>
            {isLooping ? (
              <span className="loop-indicator">
                {formatClock(loopRegion.start)} → {formatClock(loopRegion.end)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="player-cluster player-cluster-actions">
          <button
            type="button"
            className="action-button"
            onClick={onAddCutHere}
            disabled={disabled}
            title="Aggiungi un taglio qui (C)"
          >
            Taglia qui
          </button>
          <button
            type="button"
            className="action-button action-secondary"
            onClick={onAddBookmarkHere}
            disabled={disabled}
            title="Aggiungi segnalibro (B)"
          >
            Segnalibro
          </button>
        </div>
      </div>
    </div>
  );
}
