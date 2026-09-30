import { useEffect, useRef, useState } from 'react';
import {
  FAST_LOAD_STAGES,
  LOAD_STAGES,
  clamp01,
  combineLoadProgress,
  formatDurationShort,
  formatSpeedFactor,
  loadStageLabel,
} from '../lib/progress.js';
import { formatBytes } from '../lib/time.js';

const APP_STEPS = ['Carica', 'Ascolta e segna', 'Definisci i tagli', 'Scarica'];
const BASE_TITLE = typeof document !== 'undefined' ? document.title : 'Audio Cutter';

/** Indicatore dei 4 passi del flusso, con stato raggiunto/corrente. */
export function StepsBar({ activeStep }) {
  const active = Math.min(Math.max(Number(activeStep) || 0, 0), APP_STEPS.length - 1);
  return (
    <ol className="steps-bar" aria-label="Passi del flusso di lavoro">
      {APP_STEPS.map((label, index) => (
        <li
          key={label}
          className={`step ${index < active ? 'step-done' : ''} ${index === active ? 'step-current' : ''}`}
          {...(index === active ? { 'aria-current': 'step' } : {})}
        >
          <span className="step-number" aria-hidden="true">{index < active ? '✓' : index + 1}</span>
          <span className="step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** CTA export sempre a portata di pollice su telefono/tablet. */
export function StickyExportBar({ visible, partsCount, formatLabel, disabled, onExport, speedHint }) {
  if (!visible) {
    return null;
  }
  return (
    <div className="sticky-cta" role="region" aria-label="Scarica le parti">
      <span className="sticky-cta-count">
        {partsCount} parti · {formatLabel}
        {speedHint ? <em className="sticky-cta-hint">{speedHint}</em> : null}
      </span>
      <button type="button" className="primary-button sticky-cta-button" onClick={onExport} disabled={disabled}>
        Taglia e scarica
      </button>
    </div>
  );
}

function percentText(frac) {
  if (frac === null || frac === undefined || !Number.isFinite(Number(frac))) {
    return null;
  }
  return `${Math.round(clamp01(frac) * 100)}%`;
}

/** Secondi trascorsi da startedAt, aggiornati ogni secondo solo mentre attivo. */
function useElapsedSeconds(startedAt, active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) {
      return undefined;
    }
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [active, startedAt]);
  if (!active || !startedAt) {
    return 0;
  }
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Descrizione leggibile dello stato del motore (download reale in byte,
 * compilazione, pronto). Unica fonte per chip, barra di caricamento e dock.
 */
export function describeEngine(engineInfo) {
  const info = engineInfo ?? { phase: 'idle' };
  switch (info.phase) {
    case 'downloading': {
      const total = Number(info.total) || 0;
      const loaded = Number(info.loaded) || 0;
      const frac = total > 0 ? clamp01(loaded / total) : null;
      const elapsedSec = info.startedAt ? (Date.now() - info.startedAt) / 1000 : 0;
      const bytesPerSec = elapsedSec > 0.5 ? loaded / elapsedSec : 0;
      const etaSeconds = bytesPerSec > 0 && total > loaded ? (total - loaded) / bytesPerSec : null;
      const parts = [`${formatBytes(loaded)} di ${formatBytes(total)}`];
      if (bytesPerSec > 0) {
        parts.push(`${formatBytes(bytesPerSec)}/s`);
      }
      if (etaSeconds !== null && etaSeconds > 1) {
        parts.push(`restano ~${formatDurationShort(etaSeconds)}`);
      }
      return {
        title: 'Scarico il motore di taglio (solo la prima volta)',
        short: frac !== null ? `Motore: download ${Math.round(frac * 100)}%` : 'Motore: download…',
        detail: parts.join(' · '),
        frac,
      };
    }
    case 'compiling':
      return {
        title: 'Preparo il motore sul dispositivo',
        short: 'Motore: preparazione…',
        detail: 'Compilazione una tantum: pochi secondi, di più sui telefoni lenti.',
        frac: null,
      };
    case 'ready':
      return { title: 'Motore pronto', short: 'Motore pronto', detail: '', frac: 1 };
    case 'error':
      return {
        title: 'Motore non disponibile',
        short: 'Motore: errore',
        detail: info.error || 'Controlla la connessione e riprova.',
        frac: null,
      };
    default:
      if (info.cached) {
        return {
          title: 'Motore già scaricato: si avvia in pochi secondi',
          short: 'Motore scaricato · pronto all’uso',
          detail: 'Si avvia in pochi secondi alla prima elaborazione.',
          frac: null,
        };
      }
      return {
        title: 'Motore di taglio',
        short: 'Motore: si attiva al primo uso',
        detail: '',
        frac: null,
      };
  }
}

/** Chip compatto nello status strip: stato del motore sempre visibile. */
export function EngineChip({ engineInfo, onRetry }) {
  const phase = engineInfo?.phase ?? 'idle';
  const described = describeEngine(engineInfo);
  const accessibleLabel = described.detail ? `${described.title}: ${described.detail}` : described.title;
  return (
    <div className={`engine-chip engine-chip-${phase}`} title={described.detail || described.title} aria-label={accessibleLabel}>
      <span className={`status-dot status-${phase === 'ready' ? 'ready' : phase === 'idle' || phase === 'error' ? 'idle' : 'loading'}`} />
      <strong>{described.short}</strong>
      {phase === 'downloading' ? (
        <span className="engine-chip-track" aria-hidden="true">
          <span className="engine-chip-fill" style={{ transform: `scaleX(${clamp01(described.frac)})` }} />
        </span>
      ) : null}
      {phase === 'error' && onRetry ? (
        <button type="button" className="mini-button" onClick={onRetry}>
          Riprova
        </button>
      ) : null}
    </div>
  );
}

function ProgressTrack({ frac, label, valueText }) {
  const determinate = frac !== null && frac !== undefined && Number.isFinite(Number(frac));
  return (
    <div
      className="loadbar-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      {...(determinate ? { 'aria-valuenow': Math.round(clamp01(frac) * 100) } : {})}
    >
      <span
        className={`loadbar-fill ${determinate ? '' : 'loadbar-fill-busy'}`}
        style={determinate ? { transform: `scaleX(${clamp01(frac)})` } : undefined}
      />
    </div>
  );
}

/**
 * Barra di CARICAMENTO file: fasi reali (metadati, eventuale motore,
 * analisi, forma d'onda) + tempo trascorso + annulla. Fase senza misura = barra animata.
 */
export function LoadingBar({ job, engineInfo, onCancel }) {
  const active = Boolean(job?.active);
  const elapsed = useElapsedSeconds(job?.startedAt, active);
  if (!active) {
    return null;
  }
  const stages = Array.isArray(job.stages) && job.stages.length > 0 ? job.stages : LOAD_STAGES;
  const stageIndex = Math.max(0, stages.indexOf(job.stage));
  let stageFrac = job.frac ?? null;
  let detail = job.detail ?? '';
  if (job.stage === 'engine') {
    const engine = describeEngine(engineInfo);
    detail = engine.detail || engine.title;
    stageFrac = engine.frac;
  }
  // Fase senza misura → barra animata (mai una % inventata).
  const frac = stageFrac === null || stageFrac === undefined
    ? null
    : combineLoadProgress({ stage: job.stage, stageFrac, stages });
  if (job.stage === 'waveform' && !detail) {
    detail = stages === FAST_LOAD_STAGES || stages.length === 2
      ? 'Puoi già ascoltare e segnare i tagli mentre disegno la forma d’onda.'
      : 'Disegno la forma d’onda: puoi già ascoltare e segnare i tagli.';
  }
  const pct = percentText(frac);

  return (
    <div className="loadbar" role="status" aria-live="polite">
      <div className="loadbar-steps" aria-hidden="true">
        {stages.map((stage, index) => (
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

      <ProgressTrack
        frac={frac}
        label={`${loadStageLabel(job.stage)}${job.fileName ? `: ${job.fileName}` : ''}`}
        valueText={pct ? `${pct} — ${loadStageLabel(job.stage)}` : `${loadStageLabel(job.stage)} in corso`}
      />

      <div className="loadbar-meta">
        <strong>{loadStageLabel(job.stage)}{pct ? ` · ${pct}` : '…'}</strong>
        <span className="loadbar-elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
        {onCancel ? (
          <button type="button" className="mini-button" onClick={onCancel}>
            Annulla
          </button>
        ) : null}
      </div>
      {detail ? <p className="loadbar-detail">{detail}</p> : null}
    </div>
  );
}

const PART_STATE_LABEL = {
  todo: 'in coda',
  active: 'in corso',
  done: 'pronta',
  skipped: 'già presente',
};

/**
 * Barra di SCARICAMENTO/export: fase (motore → parti → finalizzazione),
 * parte i/N con stato per parte, % su secondi audio reali, velocità ×, ETA.
 */
export function ExportProgressBar({ detail, engineInfo, wakeHeld, onCancel }) {
  const active = Boolean(detail?.active);
  const elapsed = useElapsedSeconds(detail?.startedAt, active);
  if (!active) {
    return null;
  }
  const engine = detail.stage === 'engine' && engineInfo?.phase !== 'ready' ? describeEngine(engineInfo) : null;
  const frac = engine ? engine.frac : detail.stage === 'finalizing' ? null : detail.frac;
  const pct = percentText(frac);
  const speed = formatSpeedFactor(detail.speed);
  const eta = detail.etaMs !== null && detail.etaMs !== undefined ? formatDurationShort(detail.etaMs / 1000) : null;
  const partNumber = Math.min(detail.segIndex + 1, detail.segCount);
  let headline = `Parte ${partNumber} di ${detail.segCount}${pct ? ` · ${pct}` : ''}`;
  let subline = [
    detail.bytesDone > 0 ? `${formatBytes(detail.bytesDone)} scritti` : null,
    speed ? `${speed} tempo reale` : null,
    eta ? `restano ~${eta}` : null,
  ].filter(Boolean).join(' · ');
  if (engine) {
    headline = engine.title;
    subline = engine.detail;
  } else if (detail.stage === 'finalizing') {
    headline = detail.finalizingLabel || 'Finalizzo lo ZIP…';
    subline = `${detail.segCount} parti pronte`;
  }
  const parts = Array.isArray(detail.parts) ? detail.parts : [];

  return (
    <div className="exportbar" role="status" aria-live="polite">
      <ProgressTrack
        frac={frac}
        label="Avanzamento export"
        valueText={`${headline}${subline ? ` — ${subline}` : ''}`}
      />

      <div className="loadbar-meta">
        <strong>{headline}</strong>
        <span className="loadbar-elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
      </div>
      {subline ? <p className="loadbar-detail">{subline}</p> : null}

      {parts.length > 0 && parts.length <= 60 ? (
        <ol className="part-chips" aria-label="Stato delle parti">
          {parts.map((state, index) => (
            <li
              key={`part-${index + 1}`}
              className={`part-chip part-chip-${state}`}
              title={`Parte ${index + 1}: ${PART_STATE_LABEL[state] ?? state}`}
            >
              <span aria-hidden="true">{state === 'done' || state === 'skipped' ? '✓' : index + 1}</span>
              <span className="sr-only">Parte {index + 1}: {PART_STATE_LABEL[state] ?? state}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <p className="helper-text">
        Puoi cambiare scheda: tieni questa aperta{wakeHeld ? ' (schermo tenuto acceso)' : ''}, il lavoro continua.
      </p>

      {onCancel ? (
        <button type="button" className="ghost-button ghost-danger" onClick={onCancel}>
          Annulla export
        </button>
      ) : null}
    </div>
  );
}

/**
 * Pannello fisso in basso (sempre visibile, anche scorrendo la pagina) per
 * qualunque operazione lunga: titolo, dettaglio misurato, barra, tempo
 * trascorso che scorre ogni secondo (mai uno schermo "muto") e annulla.
 * Aggiorna anche il titolo della scheda per chi cambia tab.
 */
export function ActivityDock({ activity, done = null }) {
  const active = Boolean(activity);
  const elapsed = useElapsedSeconds(activity?.startedAt, active);
  const pct = active ? percentText(activity.frac) : null;
  const titleRef = useRef('');

  useEffect(() => {
    if (!active) {
      if (titleRef.current) {
        document.title = BASE_TITLE;
        titleRef.current = '';
      }
      return;
    }
    const next = pct ? `(${pct}) ${activity.title}` : `⏳ ${activity.title}`;
    if (next !== titleRef.current) {
      titleRef.current = next;
      document.title = next;
    }
  }, [active, pct, activity?.title]);

  useEffect(() => () => {
    document.title = BASE_TITLE;
  }, []);

  if (!active) {
    if (!done) {
      return null;
    }
    return (
      <div className="activity-dock activity-dock-done" role="status" aria-live="polite" key={done.at}>
        <div className="activity-head">
          <span className="activity-spinner activity-spinner-done" aria-hidden="true">✓</span>
          <div className="activity-text">
            <strong>{done.title}</strong>
            {done.detail ? <span>{done.detail}</span> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-dock" role="status" aria-live="polite" aria-atomic="false">
      <div className="activity-head">
        <span className={`activity-spinner ${pct ? '' : 'activity-spinner-busy'}`} aria-hidden="true">
          {pct ?? ''}
        </span>
        <div className="activity-text">
          <strong>{activity.title}</strong>
          {activity.detail ? <span>{activity.detail}</span> : null}
        </div>
        {activity.onCancel ? (
          <button type="button" className="mini-button activity-cancel" onClick={activity.onCancel}>
            {activity.cancelLabel || 'Annulla'}
          </button>
        ) : null}
      </div>
      <ProgressTrack
        frac={activity.frac}
        label={activity.title}
        valueText={`${activity.title}${pct ? ` ${pct}` : ''}${activity.detail ? ` — ${activity.detail}` : ''}`}
      />
      <p className="activity-elapsed" aria-hidden="true">
        In corso da {formatElapsed(elapsed)}
        {activity.hint ? ` · ${activity.hint}` : ''}
      </p>
    </div>
  );
}
