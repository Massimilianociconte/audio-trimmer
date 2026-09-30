import { formatClock } from '../lib/time.js';

export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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
  nativeMode,
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
          <span aria-hidden="true">{isPlaying ? '❚❚' : '▶'}</span> {isPlaying ? 'Pausa' : 'Ascolta'}
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

      <div className="player-row player-row-actions player-cluster-actions">
        <button
          type="button"
          className="action-button"
          onClick={onAddCutHere}
          disabled={disabled}
          title="Aggiungi un taglio nel punto che stai ascoltando (C)"
        >
          <span aria-hidden="true">✂</span> Taglia qui
        </button>
        <button
          type="button"
          className="action-button action-secondary"
          onClick={onAddBookmarkHere}
          disabled={disabled}
          title="Segna questo punto per ritrovarlo (B)"
        >
          <span aria-hidden="true">★</span> Segnalibro
        </button>
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
                aria-pressed={Math.abs(rate - playbackRate) < 0.01}
                aria-label={`Velocità ${rate}x`}
                onClick={() => onRateChange(rate)}
                disabled={disabled}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>

        {nativeMode ? null : (
          <div className="player-cluster">
            <label className="cluster-label" htmlFor="zoom-slider">
              Zoom
            </label>
            <input
              id="zoom-slider"
              type="range"
              min="0"
              max="400"
              step="1"
              value={zoom}
              onChange={(event) => onZoomChange(Number(event.target.value))}
              disabled={disabled}
              aria-valuetext={zoom === 0 ? 'Adattato alla larghezza' : `${zoom} pixel al secondo`}
            />
            <span className="zoom-value">{zoom === 0 ? 'Adatta' : `${zoom} px/s`}</span>
          </div>
        )}
      </div>

      <details className="loop-disclosure" open={isLooping || waitingForEnd || undefined}>
        <summary>
          Ripeti un tratto (A-B)
          {isLooping ? (
            <span className="loop-indicator">
              {formatClock(loopRegion.start)} → {formatClock(loopRegion.end)}
            </span>
          ) : null}
        </summary>
        <div className="loop-controls">
          <button
            type="button"
            onClick={onSetLoopStart}
            disabled={disabled}
            title="Imposta inizio del tratto (A)"
            className={waitingForEnd ? 'loop-waiting' : ''}
          >
            {waitingForEnd ? `A: ${formatClock(loopDraft)}` : 'Inizio (A)'}
          </button>
          <button
            type="button"
            onClick={onSetLoopEnd}
            disabled={disabled || (!waitingForEnd && !isLooping)}
            title="Imposta fine del tratto (B)"
          >
            Fine (B)
          </button>
          <button
            type="button"
            onClick={onClearLoop}
            disabled={disabled || (!isLooping && !waitingForEnd)}
            className="loop-clear"
            title="Smetti di ripetere"
          >
            Stop ripetizione
          </button>
        </div>
        <p className="helper-text loop-help">
          Premi «Inizio» e «Fine» mentre ascolti: il tratto si ripete finché non premi «Stop».
          Puoi anche scaricarlo da solo nel passo 03.
        </p>
      </details>
    </div>
  );
}
