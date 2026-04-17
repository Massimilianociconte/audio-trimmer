import { useEffect, useState } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import { formatClock } from '../lib/time.js';

export function Recorder({ onRecorded, disabled, onClose }) {
  const recorder = useRecorder();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    return () => {
      if (recorder.isRecording) {
        recorder.cancel();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStopAndSave() {
    setSubmitting(true);
    try {
      const result = await recorder.stop();
      if (result && result.blob && result.blob.size > 0) {
        const extension = result.extension || 'webm';
        const timestamp = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const baseName = `Registrazione ${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}.${pad(timestamp.getMinutes())}`;
        const fileName = `${baseName}.${extension}`;
        const file = new File([result.blob], fileName, { type: result.mimeType });
        onRecorded?.(file);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const progressWidth = Math.min(100, Math.round(recorder.level * 180));

  return (
    <div className="recorder">
      <div className="recorder-head">
        <div>
          <p className="section-label">Registra dal microfono</p>
          <h3>
            {recorder.isRecording
              ? recorder.isPaused
                ? 'Registrazione in pausa'
                : 'Registrazione in corso'
              : 'Pronto a registrare'}
          </h3>
        </div>
        {onClose ? (
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={recorder.isRecording || submitting}
          >
            Chiudi
          </button>
        ) : null}
      </div>

      <div className="recorder-body">
        <div className="recorder-timer">
          <span className="recorder-dot" data-active={recorder.isRecording && !recorder.isPaused} />
          <strong>{formatClock(recorder.elapsedSeconds)}</strong>
        </div>
        <div className="recorder-level" aria-hidden="true">
          <span style={{ width: `${progressWidth}%` }} />
        </div>
      </div>

      {recorder.error ? <p className="error-text">{recorder.error}</p> : null}

      <div className="recorder-actions">
        {!recorder.isRecording ? (
          <button
            type="button"
            className="primary-button"
            onClick={recorder.start}
            disabled={disabled || submitting}
          >
            Inizia registrazione
          </button>
        ) : (
          <>
            {recorder.isPaused ? (
              <button
                type="button"
                className="ghost-button"
                onClick={recorder.resume}
                disabled={submitting}
              >
                Riprendi
              </button>
            ) : (
              <button
                type="button"
                className="ghost-button"
                onClick={recorder.pause}
                disabled={submitting}
              >
                Pausa
              </button>
            )}
            <button
              type="button"
              className="primary-button"
              onClick={handleStopAndSave}
              disabled={submitting}
            >
              {submitting ? 'Elaboro...' : 'Stop e usa questo audio'}
            </button>
            <button
              type="button"
              className="ghost-button ghost-danger"
              onClick={recorder.cancel}
              disabled={submitting}
            >
              Annulla
            </button>
          </>
        )}
      </div>
    </div>
  );
}
