import { CLEANUP_ORDER, CLEANUP_PRESETS } from '../lib/cleanup.js';

export function AutomationPanel({
  silenceThresholdDb,
  silenceMinDuration,
  silenceMinSegment,
  onSilenceThresholdChange,
  onSilenceDurationChange,
  onSilenceMinSegmentChange,
  onDetectSilences,
  cleanupPreset,
  onCleanupPresetChange,
  onApplyCleanup,
  onRestoreOriginal,
  hasOriginalBackup,
  hasCleanedAudio,
  disabled,
  lastDetectionSummary,
}) {
  const activePreset = CLEANUP_PRESETS[cleanupPreset] ?? CLEANUP_PRESETS.none;
  const canApplyCleanup = cleanupPreset !== 'none' && !disabled;

  return (
    <section className="automation">
      <header className="automation-head">
        <p className="section-label">Automazione lezione</p>
        <h3>Lascia che il motore trovi e ripulisca per te</h3>
      </header>

      <div className="automation-grid">
        <article className="automation-card">
          <div>
            <p className="section-label">Rileva silenzi → capitoli</p>
            <p className="helper-text">
              Trova le pause del relatore e piazza un taglio a ogni cambio di argomento.
            </p>
          </div>

          <div className="automation-params">
            <label className="param-field">
              <span>Pausa minima</span>
              <div className="param-row">
                <input
                  type="range"
                  min="0.5"
                  max="6"
                  step="0.1"
                  value={silenceMinDuration}
                  onChange={(event) =>
                    onSilenceDurationChange(Number(event.target.value))
                  }
                  disabled={disabled}
                />
                <strong>{silenceMinDuration.toFixed(1)} s</strong>
              </div>
            </label>

            <label className="param-field">
              <span>Soglia silenzio</span>
              <div className="param-row">
                <input
                  type="range"
                  min="-60"
                  max="-10"
                  step="1"
                  value={silenceThresholdDb}
                  onChange={(event) =>
                    onSilenceThresholdChange(Number(event.target.value))
                  }
                  disabled={disabled}
                />
                <strong>{silenceThresholdDb} dB</strong>
              </div>
            </label>

            <label className="param-field">
              <span>Parte minima</span>
              <div className="param-row">
                <input
                  type="range"
                  min="1"
                  max="120"
                  step="1"
                  value={silenceMinSegment}
                  onChange={(event) =>
                    onSilenceMinSegmentChange(Number(event.target.value))
                  }
                  disabled={disabled}
                />
                <strong>{silenceMinSegment} s</strong>
              </div>
            </label>
          </div>

          <div className="automation-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onDetectSilences}
              disabled={disabled}
            >
              Rileva e crea tagli
            </button>
            {lastDetectionSummary ? (
              <p className="helper-text">{lastDetectionSummary}</p>
            ) : null}
          </div>
        </article>

        <article className="automation-card">
          <div>
            <p className="section-label">Pulisci l’audio</p>
            <p className="helper-text">
              Normalizza il volume, attenua il rumore e opzionalmente taglia le pause
              lunghe prima di esportare.
            </p>
          </div>

          <div className="preset-chooser">
            {CLEANUP_ORDER.map((id) => {
              const preset = CLEANUP_PRESETS[id];
              const isActive = preset.id === cleanupPreset;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={isActive ? 'preset-chip preset-chip-active' : 'preset-chip'}
                  onClick={() => onCleanupPresetChange(preset.id)}
                  disabled={disabled}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <p className="preset-description">{activePreset.description}</p>

          <div className="automation-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onApplyCleanup}
              disabled={!canApplyCleanup}
              title={
                cleanupPreset === 'none'
                  ? 'Seleziona un preset per attivare la pulizia'
                  : 'Applica il preset al file caricato'
              }
            >
              Applica pulizia ora
            </button>
            {hasOriginalBackup ? (
              <button
                type="button"
                className="ghost-button"
                onClick={onRestoreOriginal}
                disabled={disabled || !hasCleanedAudio}
              >
                Ripristina originale
              </button>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}
