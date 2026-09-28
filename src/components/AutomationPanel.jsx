import { useEffect, useRef, useState } from 'react';
import { CLEANUP_ORDER, CLEANUP_PRESETS } from '../lib/cleanup.js';
import { formatClock } from '../lib/time.js';

/**
 * Ascolto A/B professionale: originale e pulito suonano INSIEME e sincronizzati,
 * il selettore cambia solo quale dei due si sente (confronto istantaneo, niente
 * salti o ricaricamenti).
 */
function CleanupAbPlayer({ preview, onClose }) {
  const originalRef = useRef(null);
  const cleanedRef = useRef(null);
  const [listen, setListen] = useState('cleaned');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const duration = preview.duration || 0;

  useEffect(() => {
    const original = originalRef.current;
    const cleaned = cleanedRef.current;
    if (!original || !cleaned) {
      return undefined;
    }
    original.muted = listen !== 'original';
    cleaned.muted = listen !== 'cleaned';
    return undefined;
  }, [listen]);

  useEffect(() => {
    const cleaned = cleanedRef.current;
    if (!cleaned) {
      return undefined;
    }
    const handleTime = () => {
      setPosition(cleaned.currentTime);
      const original = originalRef.current;
      if (!original) {
        return;
      }
      // Riallinea se i due elementi derivano (> 60 ms).
      if (Math.abs(original.currentTime - cleaned.currentTime) > 0.06) {
        original.currentTime = cleaned.currentTime;
      }
      // Il primo play() può fallire mentre il clip carica: si ripara da solo,
      // così passando a "Originale" si sente sempre qualcosa.
      if (!cleaned.paused && original.paused && !cleaned.ended) {
        original.play().catch(() => {});
      }
    };
    const handleEnded = () => {
      setPlaying(false);
      originalRef.current?.pause();
    };
    cleaned.addEventListener('timeupdate', handleTime);
    cleaned.addEventListener('ended', handleEnded);
    return () => {
      cleaned.removeEventListener('timeupdate', handleTime);
      cleaned.removeEventListener('ended', handleEnded);
    };
  }, [preview.cleanedUrl]);

  function togglePlay() {
    const original = originalRef.current;
    const cleaned = cleanedRef.current;
    if (!original || !cleaned) {
      return;
    }
    if (playing) {
      original.pause();
      cleaned.pause();
      setPlaying(false);
      return;
    }
    if (cleaned.ended || cleaned.currentTime >= duration - 0.05) {
      cleaned.currentTime = 0;
      original.currentTime = 0;
    }
    original.currentTime = cleaned.currentTime;
    Promise.allSettled([original.play(), cleaned.play()]).then((results) => {
      if (results[1].status === 'rejected') {
        // Autoplay bloccato: niente stato "in riproduzione" fantasma.
        original.pause();
        setPlaying(false);
      }
    });
    setPlaying(true);
  }

  function seek(event) {
    const value = Number(event.target.value);
    for (const element of [originalRef.current, cleanedRef.current]) {
      if (element) {
        element.currentTime = value;
      }
    }
    setPosition(value);
  }

  return (
    <div className="ab-player" role="group" aria-label="Confronto prima e dopo la pulizia">
      <audio ref={originalRef} src={preview.originalUrl} preload="auto" muted={listen !== 'original'} />
      <audio ref={cleanedRef} src={preview.cleanedUrl} preload="auto" muted={listen !== 'cleaned'} />
      <div className="ab-head">
        <strong>Anteprima A/B · {preview.label}</strong>
        <span>da {formatClock(preview.start)} · {Math.round(duration)} s</span>
        <button type="button" className="mini-button" onClick={onClose}>Chiudi</button>
      </div>
      <div className="ab-controls">
        <button type="button" className="transport-button transport-play ab-play" onClick={togglePlay}>
          {playing ? 'Pausa' : 'Ascolta'}
        </button>
        <div className="ab-switch" role="radiogroup" aria-label="Versione da ascoltare">
          <button
            type="button"
            role="radio"
            aria-checked={listen === 'original'}
            className={listen === 'original' ? 'ab-active' : ''}
            onClick={() => setListen('original')}
          >
            Originale
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={listen === 'cleaned'}
            className={listen === 'cleaned' ? 'ab-active' : ''}
            onClick={() => setListen('cleaned')}
          >
            Pulito
          </button>
        </div>
      </div>
      <input
        type="range"
        min="0"
        max={Math.max(0.1, duration)}
        step="0.05"
        value={Math.min(position, duration)}
        onChange={seek}
        aria-label="Posizione nell’anteprima"
      />
      <p className="helper-text">
        Cambia versione mentre ascolti: il passaggio è istantaneo e allineato al millisecondo.
      </p>
    </div>
  );
}

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
  shortenPauses,
  onShortenPausesChange,
  cleanupEstimateLabel,
  cleanupPreview,
  onCleanupPreview,
  onCloseCleanupPreview,
  onApplyCleanup,
  onRestoreOriginal,
  hasOriginalBackup,
  appliedCleanup,
  disabled,
  lastDetectionSummary,
}) {
  const activePreset = CLEANUP_PRESETS[cleanupPreset] ?? CLEANUP_PRESETS.lecture;
  const canUseCleanup = activePreset.filters.length > 0 && !disabled;

  return (
    <section className="automation">
      <article className="automation-card cleanup-card">
        <header className="automation-head">
          <p className="section-label">Pulizia audio professionale</p>
          <h3>Voce chiara, rumore giù, volume standard −16 LUFS</h3>
          <p className="helper-text">
            Riduzione rumore adattiva, EQ per la voce, de-esser, livellamento tra voce vicina e lontana,
            compressione e limiter: la stessa catena di un podcast professionale, tutta nel tuo browser.
          </p>
        </header>

        {appliedCleanup ? (
          <div className="cleanup-applied" role="status">
            <span aria-hidden="true">✓</span>
            <p>
              <strong>Pulizia applicata: {appliedCleanup.label}</strong>
              {appliedCleanup.shortenPauses ? ' · pause accorciate' : ''}
              <br />
              <span>Tagli ed export ora usano l’audio pulito.</span>
            </p>
            {hasOriginalBackup ? (
              <button type="button" className="ghost-button" onClick={onRestoreOriginal} disabled={disabled}>
                Ripristina originale
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="preset-grid" role="radiogroup" aria-label="Tipo di pulizia">
          {CLEANUP_ORDER.map((id) => {
            const preset = CLEANUP_PRESETS[id];
            const isActive = preset.id === activePreset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`preset-card ${isActive ? 'preset-card-active' : ''}`}
                onClick={() => onCleanupPresetChange(preset.id)}
                disabled={disabled}
              >
                <strong>{preset.label}</strong>
                <span className="preset-card-desc">{preset.description}</span>
                <span className="preset-badges">
                  {preset.badges.map((badge) => (
                    <em key={badge} className={badge === 'Consigliato' ? 'badge-accent' : ''}>{badge}</em>
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <label className="check-row pause-toggle">
          <input
            type="checkbox"
            checked={shortenPauses}
            onChange={(event) => onShortenPausesChange(event.target.checked)}
            disabled={disabled}
          />
          <span>
            Accorcia le pause lunghe (oltre 1,2 s)
            <em>Rende l’ascolto più scorrevole ma sposta i tempi: tagli e segnalibri verranno azzerati.</em>
          </span>
        </label>

        {cleanupEstimateLabel ? (
          <p className="preset-estimate">
            Tempo stimato su tutto il file: <strong>{cleanupEstimateLabel}</strong>
          </p>
        ) : null}

        <div className="automation-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onCleanupPreview}
            disabled={!canUseCleanup}
            title="Elabora 20 secondi dalla posizione attuale e confronta prima/dopo"
          >
            ▶ Anteprima A/B 20 s
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onApplyCleanup}
            disabled={!canUseCleanup}
          >
            Applica a tutto il file
          </button>
        </div>

        {cleanupPreview ? <CleanupAbPlayer key={cleanupPreview.cleanedUrl} preview={cleanupPreview} onClose={onCloseCleanupPreview} /> : null}
      </article>

      <article className="automation-card">
        <div>
          <p className="section-label">Capitoli automatici dalle pause</p>
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
                onChange={(event) => onSilenceDurationChange(Number(event.target.value))}
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
                onChange={(event) => onSilenceThresholdChange(Number(event.target.value))}
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
                onChange={(event) => onSilenceMinSegmentChange(Number(event.target.value))}
                disabled={disabled}
              />
              <strong>{silenceMinSegment} s</strong>
            </div>
          </label>
        </div>

        <div className="automation-actions">
          <button type="button" className="primary-button" onClick={onDetectSilences} disabled={disabled}>
            Rileva e crea tagli
          </button>
          {lastDetectionSummary ? <p className="helper-text">{lastDetectionSummary}</p> : null}
        </div>
      </article>
    </section>
  );
}
