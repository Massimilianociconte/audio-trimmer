import { LOAD_STAGES, clamp01, formatEtaClock, loadStageLabel } from '../lib/progress.js';
import { formatBytes } from '../lib/time.js';

function percentText(frac) {
  if (frac === null || frac === undefined || !Number.isFinite(Number(frac))) {
    return null;
  }
  return `${Math.round(clamp01(frac) * 100)}%`;
}

/**
 * Barra di CARICAMENTO file: fasi reali (lettura bytes, download motore,
 * analisi, waveform) + annulla. Mai % inventate: fase senza misura = spinner.
 */
export function LoadingBar({ job, onCancel }) {
  if (!job || !job.active) {
    return null;
  }
  const stageIndex = Math.max(0, LOAD_STAGES.indexOf(job.stage));
  const pct = percentText(job.frac);
  const determinate = pct !== null;
  const bytesLine = Number.isFinite(job.totalBytes) && job.totalBytes > 0
    ? `${formatBytes(job.bytesRead || 0)} di ${formatBytes(job.totalBytes)}`
    : null;

  return (
    <div className="loadbar" role="status" aria-live="polite">
      <div className="loadbar-steps" aria-hidden="true">
        {LOAD_STAGES.map((stage, index) => (
          <span
            key={stage}
            className={
              `loadbar-step ${index < stageIndex ? 'loadbar-step-done' : ''} `
              + `${index === stageIndex ? 'loadbar-step-active' : ''}`
            }
            title={loadStageLabel(stage)}
          >
            <span className="loadbar-dot">{index < stageIndex ? '✓' : index + 1}</span>
            <span className="loadbar-step-label">{loadStageLabel(stage)}</span>
          </span>
        ))}
      </div>

      <div
        className="loadbar-track"
        role="progressbar"
        aria-label={`${loadStageLabel(job.stage)}${job.fileName ? `: ${job.fileName}` : ''}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(determinate ? { 'aria-valuenow': Math.round(clamp01(job.frac) * 100) } : {})}
      >
        <span
          className={`loadbar-fill ${determinate ? '' : 'loadbar-fill-busy'}`}
          style={determinate ? { transform: `scaleX(${clamp01(job.frac)})` } : undefined}
        />
      </div>

      <div className="loadbar-meta">
        <strong>{loadStageLabel(job.stage)}{determinate ? ` · ${pct}` : '…'}</strong>
        {bytesLine ? <span>{bytesLine}</span> : null}
        {onCancel ? (
          <button type="button" className="mini-button" onClick={onCancel}>
            Annulla
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Barra di SCARICAMENTO/export: segmento i/N + % reale da bytes +
 * avanzamento ffmpeg, throughput ed ETA misurati. Mai timer finti.
 */
export function ExportProgressBar({ detail, wakeHeld, onCancel }) {
  if (!detail || !detail.active) {
    return null;
  }
  const pct = percentText(detail.frac);
  const eta = formatEtaClock(detail.etaMs);
  const speed = Number(detail.throughputBps) > 0 ? `${formatBytes(detail.throughputBps)}/s` : null;

  return (
    <div className="exportbar" role="status" aria-live="polite">
      <div
        className="loadbar-track"
        role="progressbar"
        aria-label={`Export parte ${detail.segIndex + 1} di ${detail.segCount}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp01(detail.frac) * 100)}
      >
        <span
          className="loadbar-fill"
          style={{ transform: `scaleX(${clamp01(detail.frac)})` }}
        />
      </div>

      <div className="loadbar-meta">
        <strong>
          Parte {Math.min(detail.segIndex + 1, detail.segCount)} di {detail.segCount}
          {pct ? ` · ${pct}` : ''}
        </strong>
        <span>
          {formatBytes(detail.bytesDone || 0)} di {formatBytes(detail.bytesTotal || 0)}
          {speed ? ` · ${speed}` : ''}
          {eta ? ` · restano ~${eta}` : ''}
        </span>
      </div>

      <p className="helper-text">
        Puoi cambiare scheda: tieni questa aperta{wakeHeld ? ' (schermo attivo)' : ''}, il job continua in background.
      </p>

      {onCancel ? (
        <button type="button" className="ghost-button ghost-danger" onClick={onCancel}>
          Annulla export
        </button>
      ) : null}
    </div>
  );
}
