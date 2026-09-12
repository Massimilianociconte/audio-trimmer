import { EXPORT_FORMAT_ORDER, EXPORT_FORMATS, canFastCopy, estimateExportBytes } from '../lib/export.js';
import { EXPORT_DESTINATION_ORDER, EXPORT_DESTINATIONS, getExportCapabilities } from '../lib/streamExport.js';
import { formatBytes, formatClock } from '../lib/time.js';

export function ExportPanel({
  plan,
  audioFile,
  exportFormat,
  onExportFormatChange,
  exportBitrate,
  onExportBitrateChange,
  fastCopy,
  onFastCopyChange,
  fadeSeconds,
  onFadeChange,
  exportDest,
  onExportDestChange,
  skipExisting,
  onSkipExistingChange,
  advisorNote,
  wakeHeld,
  baseName,
  onBaseNameChange,
  segmentNames,
  onSegmentNameChange,
  onPreviewSegment,
  previewIndex,
  canExport,
  isBusy,
  isExporting,
  exportProgress,
  currentSegmentIndex,
  failedExportIndex,
  onExport,
  onCancelExport,
  lastResult,
  onDownloadSingle,
  onDownloadZipAgain,
  loopRegion,
  onExportLoop,
  onCopyChapters,
  chaptersStatus,
  resumeNotice,
  disabled,
}) {
  const format = EXPORT_FORMATS[exportFormat] ?? EXPORT_FORMATS.m4a;
  const copyAvailable = canFastCopy({ formatId: format.id, sourceExtension: audioFile?.extension });
  const capabilities = getExportCapabilities();
  const totalEstimate = plan.segments.reduce(
    (sum, seg) => sum + estimateExportBytes({ durationSeconds: seg.duration, bitrateKbps: exportBitrate, formatId: format.id }),
    0,
  );
  const minSegment = plan.segments.length > 0
    ? Math.min(...plan.segments.map((segment) => segment.duration))
    : Infinity;
  const fadeIneffective = fadeSeconds > 0 && Number.isFinite(minSegment) && minSegment <= fadeSeconds * 2;

  return (
    <aside className="summary-column">
      <div className="summary-head">
        <p className="section-label">Anteprima esportazione</p>
        <strong>
          {plan.segments.length > 0 ? `${plan.segments.length} file pronti` : 'In attesa'}
        </strong>
      </div>

      <div className="export-settings">
        <label className="field">
          <span>Nome base dei file</span>
          <input
            type="text"
            className="text-input"
            value={baseName}
            onChange={(event) => onBaseNameChange(event.target.value)}
            placeholder={audioFile?.baseName ?? 'lezione'}
            disabled={disabled}
            maxLength={80}
          />
        </label>

        <div className="export-grid">
          <label className="field">
            <span>Formato</span>
            <select
              className="text-input"
              value={format.id}
              onChange={(event) => onExportFormatChange(event.target.value)}
              disabled={disabled}
            >
              {EXPORT_FORMAT_ORDER.map((id) => (
                <option key={id} value={id}>
                  {EXPORT_FORMATS[id].label}
                </option>
              ))}
            </select>
          </label>

          {format.bitrates.length > 0 ? (
            <label className="field">
              <span>Qualità</span>
              <select
                className="text-input"
                value={exportBitrate}
                onChange={(event) => onExportBitrateChange(Number(event.target.value))}
                disabled={disabled}
              >
                {format.bitrates.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} kbps
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="field">
              <span>Qualità</span>
              <strong className="lossless-badge">Lossless 16-bit</strong>
            </div>
          )}
        </div>

        <p className="helper-text">{format.description}</p>

        <div className="export-toggles">
          <label className="check-row" title={format.copyHint || 'Taglio senza ricodifica'}>
            <input
              type="checkbox"
              checked={fastCopy && copyAvailable}
              onChange={(event) => onFastCopyChange(event.target.checked)}
              disabled={disabled || !format.supportsFastCopy || !copyAvailable}
            />
            <span>
              Taglio veloce (senza ricodifica)
              {!copyAvailable && format.supportsFastCopy ? (
                <em> · non disponibile: la sorgente non è già {format.label}</em>
              ) : null}
            </span>
          </label>

          <label className="check-row">
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(event) => onSkipExistingChange(event.target.checked)}
              disabled={disabled}
            />
            <span>Salta i file già presenti (riprendi un export interrotto)</span>
          </label>

          <label className="field">
            <span>Destinazione (anti-memoria piena)</span>
            <select
              className="text-input"
              value={exportDest}
              onChange={(event) => onExportDestChange(event.target.value)}
              disabled={disabled}
            >
              {EXPORT_DESTINATION_ORDER.map((id) => (
                <option key={id} value={id}>
                  {EXPORT_DESTINATIONS[id].label}
                  {id === 'folder' && !capabilities.directoryPicker ? ' (non supportata)' : ''}
                  {id === 'zip-stream' && !capabilities.filePicker ? ' (non supportata)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="param-field">
            <span>Dissolvenza inizio/fine (fade)</span>
            <div className="param-row">
              <input
                type="range"
                min="0"
                max="2"
                step="0.25"
                value={fadeSeconds}
                onChange={(event) => onFadeChange(Number(event.target.value))}
                disabled={disabled || fastCopy}
              />
              <strong>{fadeSeconds === 0 ? 'Off' : `${fadeSeconds.toFixed(2)} s`}</strong>
            </div>
            {fadeIneffective ? (
              <em className="fade-warning">Fade disattivato sulle parti più corte di {(fadeSeconds * 2).toFixed(2)} s.</em>
            ) : null}
          </label>
        </div>

        {plan.segments.length > 0 ? (
          <p className="preset-estimate">
            Peso stimato totale: <strong>{formatBytes(totalEstimate)}</strong>
            <span className="preset-estimate-note"> · {format.label}, {plan.segments.length} parti · RAM max ≈ 1 parte</span>
          </p>
        ) : null}
        {advisorNote ? (
          <p className="helper-text">{advisorNote}</p>
        ) : null}
        {resumeNotice ? (
          <p className="preset-estimate">{resumeNotice}</p>
        ) : null}
      </div>

      {plan.segments.length > 0 ? (
        <div className="segment-stack">
          {plan.segments.map((segment) => (
            <div className="segment-row segment-editable" key={segment.index}>
              <div className="segment-main">
                <strong>
                  Parte {segment.index} · {formatClock(segment.duration)}
                </strong>
                <p>{segment.rangeLabel}</p>
                <input
                  type="text"
                  className="text-input segment-name-input"
                  value={segmentNames[segment.index] ?? ''}
                  onChange={(event) => onSegmentNameChange(segment.index, event.target.value)}
                  placeholder={`Nome opzionale (es. introduzione)`}
                  disabled={disabled}
                  maxLength={60}
                  aria-label={`Nome parte ${segment.index}`}
                />
              </div>
              <div className="segment-actions">
                <button
                  type="button"
                  className="mini-button"
                  onClick={() => onPreviewSegment(segment.index)}
                  disabled={disabled}
                  title={`Ascolta anteprima parte ${segment.index}`}
                >
                  {previewIndex === segment.index ? 'Stop' : 'Ascolta'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-text">Le parti appariranno qui appena il piano è valido.</p>
      )}

      {isExporting ? (
        <div className="export-progress">
          <div className="progress-track" aria-hidden="true">
            <span
              className="progress-bar progress-bar-busy"
              style={{ transform: `scaleX(${exportProgress})` }}
            />
          </div>
          <p className="helper-text">
            Parte {Math.min(currentSegmentIndex + 1, plan.segments.length)} di {plan.segments.length}…
            Puoi cambiare scheda: tieni questa aperta{wakeHeld ? ' (schermo attivo)' : ''}, il job continua in background.
          </p>
          <button type="button" className="ghost-button ghost-danger" onClick={onCancelExport}>
            Annulla export
          </button>
        </div>
      ) : (
        <>
        <button
          type="button"
          className="primary-button"
          onClick={onExport}
          disabled={!canExport}
        >
          {isBusy ? 'Elaborazione in corso...' : `Taglia e scarica ${format.extension.replace('.', '').toUpperCase()}`}
        </button>
        {Number.isInteger(failedExportIndex) ? (
          <p className="error-text">Ultimo errore alla parte {failedExportIndex + 1}: rilancia l’export per riprovare da lì.</p>
        ) : null}
        <div className="export-secondary-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onExportLoop}
            disabled={disabled || !loopRegion || loopRegion.end <= loopRegion.start + 0.24}
            title={loopRegion ? 'Esporta solo l’intervallo A-B come file unico' : 'Imposta prima un loop A-B nel player'}
          >
            Esporta selezione A-B
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={onCopyChapters}
            disabled={disabled || plan.segments.length === 0}
            title="Copia la scaletta mm:ss Titolo per YouTube/descrizione"
          >
            Copia scaletta capitoli
          </button>
        </div>
        {chaptersStatus ? <p className="save-status">{chaptersStatus}</p> : null}
        </>
      )}

      {lastResult?.parts?.length > 0 ? (
        <div className="last-export">
          <p className="section-label">
            Ultima esportazione
            {lastResult.destMode === 'folder' || lastResult.destMode === 'zip-stream'
              ? ' · file già su disco'
              : ' · riscarica singoli'}
          </p>
          <ul className="exported-list">
            {lastResult.parts.map((part) => (
              <li key={part.name}>
                <span className="exported-name" title={part.name}>
                  {part.name} · {formatBytes(part.size)}
                  {part.skipped ? ' · già presente' : ''}
                </span>
                {part.url ? (
                  <button
                    type="button"
                    className="mini-button"
                    onClick={() => onDownloadSingle(part)}
                  >
                    Scarica
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {lastResult.zipUrl ? (
            <button type="button" className="ghost-button" onClick={onDownloadZipAgain}>
              Riscarica ZIP
            </button>
          ) : null}
          {lastResult.retainBlobs === false ? (
            <p className="helper-text">Re-download disattivato per risparmiare memoria su questo job pesante.</p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
