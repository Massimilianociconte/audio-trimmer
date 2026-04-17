import { startTransition, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { buildDownloadName, buildPlan, buildVirtualSegmentName } from './lib/segments.js';
import {
  clamp,
  formatBytes,
  formatClock,
  getExtension,
  parseTimeInput,
  stripExtension,
} from './lib/time.js';

const ACCEPTED_AUDIO_TYPES = [
  'audio/*',
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.amr',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
].join(',');

const INITIAL_MESSAGE = 'Carica un file audio e preparerò tutte le parti in un unico passaggio.';

function createPointId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAudioMime(file, extension) {
  if (file?.type) {
    return file.type;
  }

  const mimeByExtension = {
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  };

  return mimeByExtension[extension] ?? 'application/octet-stream';
}

function getFormatLabel(file, extension) {
  if (file?.type?.startsWith('audio/')) {
    return file.type.replace('audio/', '').toUpperCase();
  }

  if (extension) {
    return extension.slice(1).toUpperCase();
  }

  return 'audio';
}

function readAudioDurationFromBrowser(objectUrl) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    let settled = false;

    const timeoutId = window.setTimeout(() => {
      finalize(() => reject(new Error('Timeout metadata browser')));
    }, 15000);

    function finalize(callback) {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.onloadedmetadata = null;
      audio.onerror = null;
      callback();
    }

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;

      if (Number.isFinite(duration) && duration > 0) {
        finalize(() => resolve(duration));
        return;
      }

      finalize(() => reject(new Error('Durata browser non valida')));
    };

    audio.onerror = () => {
      finalize(() => reject(new Error('Metadata browser non disponibili')));
    };

    audio.src = objectUrl;
  });
}

async function safeDelete(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    return false;
  }

  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function formatFfmpegTime(seconds) {
  return Math.max(0, seconds).toFixed(3);
}

export default function App() {
  const ffmpegRef = useRef(null);
  const audioRef = useRef(null);
  const inputRef = useRef(null);
  const objectUrlRef = useRef('');
  const activeInputRef = useRef('');
  const activeProbeRef = useRef('');
  const dragDepthRef = useRef(0);

  const [engineState, setEngineState] = useState('idle');
  const [statusText, setStatusText] = useState(INITIAL_MESSAGE);
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [technicalLog, setTechnicalLog] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [mode, setMode] = useState('equal');
  const [equalParts, setEqualParts] = useState(2);
  const [customCuts, setCustomCuts] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [audioFile, setAudioFile] = useState(null);

  const plan = buildPlan({
    duration: audioFile?.duration ?? 0,
    mode,
    equalParts,
    customCuts,
  });

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }

      if (ffmpegRef.current) {
        ffmpegRef.current.terminate();
        ffmpegRef.current = null;
      }

      activeInputRef.current = '';
      activeProbeRef.current = '';
    };
  }, []);

  async function ensureEngineReady() {
    let ffmpeg = ffmpegRef.current;

    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        const compactMessage = message.trim();
        if (compactMessage) {
          setTechnicalLog(compactMessage);
        }
      });
      ffmpeg.on('progress', ({ progress }) => {
        setPhaseProgress((current) => Math.max(current, progress));
      });
      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpeg.loaded) {
      setEngineState('loading');
      setStatusText('Carico il motore locale di taglio. Succede solo la prima volta.');
      setPhaseProgress(0.08);

      await ffmpeg.load({
        coreURL: ffmpegCoreUrl,
        wasmURL: ffmpegWasmUrl,
      });

      setEngineState('ready');
      setStatusText('Motore pronto. Ora puoi analizzare e tagliare il file.');
      setPhaseProgress(0);
    }

    return ffmpeg;
  }

  async function analyzeFile(file) {
    if (!file) {
      return;
    }

    let objectUrl = '';
    let keepObjectUrl = false;

    setErrorText('');
    setLastResult(null);
    setIsBusy(true);
    setStatusText('Analizzo il file e recupero la durata esatta...');
    setPhaseProgress(0.12);

    try {
      const extension = getExtension(file.name);
      const outputExtension = extension || '.audio';
      const baseName = stripExtension(file.name);
      const virtualInputName = `source-${Date.now()}${outputExtension}`;
      const probeOutputName = `probe-${Date.now()}.json`;
      let duration = NaN;
      let technicalMessage = 'File pronto.';
      let formatLabel = getFormatLabel(file, outputExtension);

      objectUrl = URL.createObjectURL(file);

      try {
        duration = await readAudioDurationFromBrowser(objectUrl);
        technicalMessage = 'Durata recuperata direttamente dal browser.';
      } catch {
        technicalMessage = 'Il browser non legge la durata, provo con ffprobe.';
      }

      const ffmpeg = await ensureEngineReady();

      if (activeInputRef.current) {
        await safeDelete(ffmpeg, activeInputRef.current);
      }
      if (activeProbeRef.current) {
        await safeDelete(ffmpeg, activeProbeRef.current);
      }

      await ffmpeg.writeFile(virtualInputName, await fetchFile(file));
      activeInputRef.current = virtualInputName;

      if (!Number.isFinite(duration) || duration <= 0) {
        activeProbeRef.current = probeOutputName;

        const exitCode = await ffmpeg.ffprobe([
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          virtualInputName,
          '-o',
          probeOutputName,
        ]);

        if (exitCode !== 0) {
          throw new Error('Impossibile leggere i metadati del file audio.');
        }

        const probeRaw = await ffmpeg.readFile(probeOutputName, 'utf8');
        duration = Number(String(probeRaw).trim());
        technicalMessage = 'Durata recuperata con ffprobe.';
      }

      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Durata non valida. Prova con un file audio differente.');
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = objectUrl;
      keepObjectUrl = true;

      startTransition(() => {
        setAudioFile({
          baseName,
          duration,
          extension: outputExtension,
          formatLabel,
          mimeType: getAudioMime(file, outputExtension),
          name: file.name,
          objectUrl,
          size: file.size,
          virtualInputName,
        });
        setMode('equal');
        setEqualParts(2);
        setCustomCuts([]);
        setCurrentTime(0);
      });

      setStatusText('File pronto. Scegli il tipo di taglio e scarica tutte le parti insieme.');
      setPhaseProgress(0);
      setTechnicalLog(technicalMessage);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Non sono riuscito ad analizzare il file.');
      setStatusText('Qualcosa è andato storto durante l’analisi del file.');
      setPhaseProgress(0);
    } finally {
      if (objectUrl && !keepObjectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      setIsBusy(false);
    }
  }

  async function handleInputChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && !isBusy) {
      await analyzeFile(file);
    }
  }

  function handleDragEnter(event) {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (!isBusy) {
      setDragActive(true);
    }
  }

  function handleDragLeave(event) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);

    if (isBusy) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file) {
      await analyzeFile(file);
    }
  }

  function addCutAt(seconds) {
    if (!audioFile?.duration) {
      return;
    }

    const safeSeconds = clamp(seconds, 0.25, Math.max(0.25, audioFile.duration - 0.25));
    setMode('custom');
    setCustomCuts((previous) => [
      ...previous,
      {
        id: createPointId(),
        value: formatClock(safeSeconds),
      },
    ]);
  }

  function updateCutPoint(id, value) {
    setCustomCuts((previous) =>
      previous.map((point) => (point.id === id ? { ...point, value } : point)),
    );
  }

  function removeCutPoint(id) {
    setCustomCuts((previous) => previous.filter((point) => point.id !== id));
  }

  async function processAndDownload() {
    if (!audioFile || plan.error || plan.segments.length < 2) {
      setErrorText(plan.error || 'Definisci almeno due parti prima di esportare.');
      return;
    }

    setErrorText('');
    setLastResult(null);
    setIsBusy(true);
    setPhaseProgress(0.05);
    setStatusText('Sto tagliando il file e preparando lo ZIP...');

    const runPrefix = `segment-${Date.now()}`;
    let ffmpeg = null;
    const createdVirtualNames = [];
    let exportMode = 'multi-copy';
    let outputExtension = audioFile.extension;

    try {
      ffmpeg = await ensureEngineReady();
      const segmentTimes = plan.cutPoints.map((value) => value.toFixed(3)).join(',');
      const outputPattern = `${runPrefix}-%03d${outputExtension}`;

      async function cleanupExports() {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }

        createdVirtualNames.length = 0;
      }

      const batchExitCode = await ffmpeg.exec([
        '-i',
        audioFile.virtualInputName,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_times',
        segmentTimes,
        '-reset_timestamps',
        '1',
        outputPattern,
      ]);

      if (batchExitCode === 0) {
        for (let index = 0; index < plan.segments.length; index += 1) {
          createdVirtualNames.push(buildVirtualSegmentName(runPrefix, index, outputExtension));
        }
      } else {
        exportMode = 'single-copy';
        setTechnicalLog(
          'Il taglio multiplo in blocco non è supportato da questo contenitore. Passo al taglio diretto parte per parte.',
        );
        setStatusText('Questo formato richiede un taglio diretto parte per parte. Continuo automaticamente...');
        setPhaseProgress(0.18);

        for (let index = 0; index < plan.segments.length; index += 1) {
          await safeDelete(ffmpeg, buildVirtualSegmentName(runPrefix, index, outputExtension));
        }

        for (let index = 0; index < plan.segments.length; index += 1) {
          const segment = plan.segments[index];
          const virtualName = buildVirtualSegmentName(runPrefix, index, outputExtension);
          const segmentExitCode = await ffmpeg.exec([
            '-ss',
            formatFfmpegTime(segment.start),
            '-t',
            formatFfmpegTime(segment.duration),
            '-i',
            audioFile.virtualInputName,
            '-map',
            '0',
            '-c',
            'copy',
            '-reset_timestamps',
            '1',
            '-avoid_negative_ts',
            'make_zero',
            virtualName,
          ]);

          if (segmentExitCode !== 0) {
            await cleanupExports();
            exportMode = 'lossy-aac';
            outputExtension = '.m4a';
            setTechnicalLog(
              'La copia diretta non è riuscita. Passo a un export AAC in M4A per completare il taglio con file più leggeri.',
            );
            setStatusText('Questo file richiede una nuova codifica AAC in M4A. Continuo automaticamente...');
            setPhaseProgress(0.32);

            for (let fallbackIndex = 0; fallbackIndex < plan.segments.length; fallbackIndex += 1) {
              const fallbackSegment = plan.segments[fallbackIndex];
              const fallbackName = buildVirtualSegmentName(runPrefix, fallbackIndex, outputExtension);
              const fallbackExitCode = await ffmpeg.exec([
                '-ss',
                formatFfmpegTime(fallbackSegment.start),
                '-t',
                formatFfmpegTime(fallbackSegment.duration),
                '-i',
                audioFile.virtualInputName,
                '-map',
                '0:a:0',
                '-c:a',
                'aac',
                '-b:a',
                '160k',
                fallbackName,
              ]);

              if (fallbackExitCode !== 0) {
                await cleanupExports();
                exportMode = 'lossless-flac';
                outputExtension = '.flac';
                setTechnicalLog(
                  'Il fallback AAC non è riuscito. Passo a un export FLAC lossless come ultima opzione.',
                );
                setStatusText('Il file richiede un export FLAC lossless come ultima opzione...');
                setPhaseProgress(0.45);

                for (
                  let losslessIndex = 0;
                  losslessIndex < plan.segments.length;
                  losslessIndex += 1
                ) {
                  const losslessSegment = plan.segments[losslessIndex];
                  const losslessName = buildVirtualSegmentName(
                    runPrefix,
                    losslessIndex,
                    outputExtension,
                  );
                  const losslessExitCode = await ffmpeg.exec([
                    '-ss',
                    formatFfmpegTime(losslessSegment.start),
                    '-t',
                    formatFfmpegTime(losslessSegment.duration),
                    '-i',
                    audioFile.virtualInputName,
                    '-map',
                    '0:a:0',
                    '-c:a',
                    'flac',
                    losslessName,
                  ]);

                  if (losslessExitCode !== 0) {
                    throw new Error(
                      'Non sono riuscito a tagliare questo file nel browser neanche con il fallback finale.',
                    );
                  }

                  createdVirtualNames.push(losslessName);
                  setStatusText(
                    `Preparo parte ${losslessIndex + 1} di ${plan.segments.length} in FLAC lossless...`,
                  );
                  setPhaseProgress(0.45 + ((losslessIndex + 1) / plan.segments.length) * 0.25);
                }

                break;
              }

              createdVirtualNames.push(fallbackName);
              setStatusText(
                `Preparo parte ${fallbackIndex + 1} di ${plan.segments.length} in AAC M4A...`,
              );
              setPhaseProgress(0.32 + ((fallbackIndex + 1) / plan.segments.length) * 0.38);
            }

            break;
          }

          createdVirtualNames.push(virtualName);
          setStatusText(
            `Preparo parte ${index + 1} di ${plan.segments.length} senza ricodifica...`,
          );
          setPhaseProgress(0.18 + ((index + 1) / plan.segments.length) * 0.52);
        }
      }

      setStatusText('Creo l’archivio ZIP finale con tutte le parti rinominate...');
      setPhaseProgress(0.78);

      const zip = new JSZip();
      const exportedParts = [];

      for (let index = 0; index < plan.segments.length; index += 1) {
        const virtualName = createdVirtualNames[index];
        const outputData = await ffmpeg.readFile(virtualName);
        const downloadName = buildDownloadName(audioFile.baseName, index + 1, outputExtension);

        zip.file(downloadName, outputData, { binary: true });
        exportedParts.push({
          name: downloadName,
          size: outputData.byteLength,
          duration: plan.segments[index].duration,
        });
      }

      const archiveName = `${audioFile.baseName} - parti.zip`;
      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE',
        },
        ({ percent }) => {
          setPhaseProgress(0.78 + percent / 100 * 0.22);
        },
      );

      downloadBlob(zipBlob, archiveName);

      setLastResult({
        archiveName,
        parts: exportedParts,
      });
      setStatusText('Fatto. Ho scaricato tutte le parti in un solo ZIP, già rinominate.');
      setTechnicalLog(
        exportMode === 'multi-copy'
          ? `Esportazione completata in copia diretta: ${exportedParts.length} file pronti.`
          : exportMode === 'single-copy'
            ? `Esportazione completata con fallback parte per parte: ${exportedParts.length} file pronti.`
            : exportMode === 'lossy-aac'
              ? `Esportazione completata con fallback AAC M4A: ${exportedParts.length} file pronti.`
              : `Esportazione completata con fallback FLAC lossless: ${exportedParts.length} file pronti.`,
      );
      setPhaseProgress(1);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Non sono riuscito a esportare le parti.');
      setStatusText('Esportazione non completata.');
      setPhaseProgress(0);
    } finally {
      if (ffmpeg) {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }
      }

      setIsBusy(false);
    }
  }

  const canExport = Boolean(audioFile) && !plan.error && plan.segments.length >= 2 && !isBusy;
  const helperChips = [
    'Locale nel browser',
    'Un solo upload',
    'Copia diretta senza ricodifica',
  ];

  return (
    <div className="shell">
      <div className="aurora aurora-left" />
      <div className="aurora aurora-right" />

      <header className="topbar">
        <div>
          <p className="eyebrow">Audio cutter pensato per GitHub Pages</p>
          <h1>
            Taglia una volta,
            <span> scarica tutto subito.</span>
          </h1>
        </div>
        <p className="lead">
          Carichi un audio una sola volta, scegli il taglio e scarichi tutte le parti
          già rinominate come <strong>parte 1</strong>, <strong>parte 2</strong>,
          <strong>parte 3</strong>.
        </p>
      </header>

      <main className="workspace">
        <section className="stage">
          <div className="stage-header">
            <div className="pill-group">
              {helperChips.map((chip) => (
                <span className="pill" key={chip}>
                  {chip}
                </span>
              ))}
            </div>

            <button
              className="ghost-button"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isBusy}
            >
              Scegli un file
            </button>
          </div>

          <label
            className={`dropzone ${dragActive ? 'dropzone-active' : ''} ${isBusy ? 'dropzone-busy' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_AUDIO_TYPES}
              onChange={handleInputChange}
              disabled={isBusy}
              hidden
            />
            <span className="dropzone-kicker">Drag & drop oppure click</span>
            <strong>Carica un file audio</strong>
            <p>
              Supporto pensato per i formati più comuni. Il file resta locale e non viene
              caricato su server esterni.
            </p>
          </label>

          <div className="status-strip">
            <div>
              <span className={`status-dot status-${engineState}`} />
              <strong>{engineState === 'ready' ? 'Motore pronto' : 'Motore locale'}</strong>
            </div>
            <p>{statusText}</p>
          </div>

          <div className="progress-track" aria-hidden="true">
            <span
              className={`progress-bar ${isBusy ? 'progress-bar-busy' : ''}`}
              style={{ transform: `scaleX(${phaseProgress || 0.02})` }}
            />
          </div>

          {audioFile ? (
            <div className="loaded-file">
              <div>
                <p className="section-label">File caricato</p>
                <h2>{audioFile.name}</h2>
                <div className="meta-row">
                  <span>{formatClock(audioFile.duration)}</span>
                  <span>{formatBytes(audioFile.size)}</span>
                  <span>{audioFile.formatLabel}</span>
                </div>
              </div>
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={audioFile.objectUrl}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            </div>
          ) : null}

          <div className="editor-grid">
            <div className="editor-column">
              <div className="mode-switch">
                <button
                  type="button"
                  className={mode === 'equal' ? 'mode-active' : ''}
                  onClick={() => setMode('equal')}
                >
                  Parti uguali
                </button>
                <button
                  type="button"
                  className={mode === 'custom' ? 'mode-active' : ''}
                  onClick={() => setMode('custom')}
                >
                  Punti personalizzati
                </button>
              </div>

              {mode === 'equal' ? (
                <div className="control-panel">
                  <div className="quick-presets">
                    {[2, 3, 4].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={equalParts === value ? 'preset-active' : ''}
                        onClick={() => setEqualParts(value)}
                      >
                        {value} parti
                      </button>
                    ))}
                  </div>

                  <label className="field">
                    <span>Numero di parti uguali</span>
                    <input
                      type="range"
                      min="2"
                      max="12"
                      value={equalParts}
                      onChange={(event) => setEqualParts(Number(event.target.value))}
                    />
                    <strong>{equalParts} parti</strong>
                  </label>
                </div>
              ) : (
                <div className="control-panel">
                  <div className="custom-actions">
                    <button type="button" onClick={() => addCutAt(currentTime)}>
                      Usa la posizione corrente
                    </button>
                    <button
                      type="button"
                      onClick={() => addCutAt((audioFile?.duration ?? 0) / 2)}
                    >
                      Inserisci un taglio a metà
                    </button>
                  </div>

                  <p className="helper-text">
                    Puoi scrivere i punti in secondi oppure in formato <code>mm:ss</code>{' '}
                    o <code>hh:mm:ss</code>.
                  </p>

                  <div className="cut-list">
                    {customCuts.length === 0 ? (
                      <p className="empty-text">
                        Nessun punto inserito. Premi un pulsante sopra oppure aggiungi un
                        tempo manuale.
                      </p>
                    ) : null}

                    {customCuts.map((point) => (
                      <div className="cut-row" key={point.id}>
                        <input
                          type="text"
                          value={point.value}
                          onChange={(event) => updateCutPoint(point.id, event.target.value)}
                          placeholder="00:30"
                        />
                        <input
                          type="range"
                          min="0"
                          max={audioFile?.duration ?? 0}
                          step="0.1"
                          value={clamp(
                            parseTimeInput(point.value) ?? currentTime,
                            0,
                            audioFile?.duration ?? 0,
                          )}
                          onChange={(event) =>
                            updateCutPoint(point.id, formatClock(Number(event.target.value)))
                          }
                        />
                        <button type="button" onClick={() => removeCutPoint(point.id)}>
                          Rimuovi
                        </button>
                      </div>
                    ))}

                    <button
                      type="button"
                      className="add-manual"
                      onClick={() =>
                        setCustomCuts((previous) => [
                          ...previous,
                          { id: createPointId(), value: '' },
                        ])
                      }
                    >
                      Aggiungi un punto manuale
                    </button>
                  </div>
                </div>
              )}
            </div>

            <aside className="summary-column">
              <div className="summary-head">
                <p className="section-label">Anteprima esportazione</p>
                <strong>
                  {plan.segments.length > 0 ? `${plan.segments.length} file pronti` : 'In attesa'}
                </strong>
              </div>

              {plan.error ? <p className="error-text">{plan.error}</p> : null}
              {errorText ? <p className="error-text">{errorText}</p> : null}

              {plan.segments.length > 0 ? (
                <div className="segment-stack">
                  {plan.segments.map((segment) => (
                    <div className="segment-row" key={segment.index}>
                      <div>
                        <strong>
                          {buildDownloadName(
                            audioFile?.baseName ?? 'audio',
                            segment.index,
                            audioFile?.extension ?? '',
                          )}
                        </strong>
                        <p>{segment.rangeLabel}</p>
                      </div>
                      <span>{formatClock(segment.duration)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-text">Le parti appariranno qui appena il piano è valido.</p>
              )}

              <button
                type="button"
                className="primary-button"
                onClick={processAndDownload}
                disabled={!canExport}
              >
                {isBusy ? 'Elaborazione in corso...' : 'Taglia e scarica tutto'}
              </button>

              <p className="helper-text">
                Il download genera uno ZIP senza comprimere di nuovo l’audio, per restare più
                rapido possibile.
              </p>
            </aside>
          </div>
        </section>

        <section className="details">
          <div className="detail">
            <p className="section-label">Perché è più veloce</p>
            <strong>Un solo file in ingresso, tutte le parti in uscita.</strong>
            <p>
              Il sito analizza il file una volta sola, applica tutti i punti di taglio in un
              unico passaggio e prepara subito l’archivio finale.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Qualità</p>
            <strong>Nessuna ricodifica quando il formato lo consente.</strong>
            <p>
              La strategia predefinita usa copia diretta dei flussi audio per evitare perdite
              di qualità e tempi morti di esportazione.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Stato tecnico</p>
            <strong>{technicalLog || 'In attesa del prossimo passaggio.'}</strong>
            <p>
              {lastResult
                ? `Ultimo ZIP creato: ${lastResult.archiveName}`
                : 'Qui comparirà l’ultimo messaggio utile del motore di elaborazione.'}
            </p>
          </div>
        </section>

        {lastResult ? (
          <section className="result-banner">
            <p className="section-label">Ultima esportazione</p>
            <h3>{lastResult.archiveName}</h3>
            <div className="result-list">
              {lastResult.parts.map((part) => (
                <span key={part.name}>
                  {part.name} · {formatBytes(part.size)} · {formatClock(part.duration)}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
