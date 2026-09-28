import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeProbeText,
  hasAudioStreamText,
  parseFfmpegInputLog,
  decideAudioAcceptance,
} from './probe.js';

describe('decodeProbeText', () => {
  it('decodifica Uint8Array invece di "97,117,..."', () => {
    const bytes = new TextEncoder().encode('audio\nvideo\n');
    assert.equal(decodeProbeText(bytes), 'audio\nvideo\n');
    // Regressione: String(Uint8Array) non deve mai passare da qui
    assert.notEqual(String(bytes), 'audio\nvideo\n');
  });

  it('passa stringhe e valori nulli', () => {
    assert.equal(decodeProbeText('Audio'), 'Audio');
    assert.equal(decodeProbeText(null), '');
    assert.equal(decodeProbeText(undefined), '');
  });
});

describe('hasAudioStreamText', () => {
  it('rileva audio case-insensitive', () => {
    assert.equal(hasAudioStreamText('audio'), true);
    assert.equal(hasAudioStreamText('AUDIO\n'), true);
    assert.equal(hasAudioStreamText('video\nsubtitle\n'), false);
    assert.equal(hasAudioStreamText(''), false);
  });
});

describe('parseFfmpegInputLog', () => {
  it('trova Audio, Video e Duration', () => {
    const log = `
Input #0, mp3, from 'lezione.mp3':
  Duration: 00:05:23.45, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg, yuvj420p, 300x300
`;
    const parsed = parseFfmpegInputLog(log);
    assert.equal(parsed.hasAudio, true);
    assert.equal(parsed.hasVideo, true);
    assert.ok(Math.abs(parsed.durationSeconds - 323.45) < 0.01);
  });

  it('video-only senza audio', () => {
    const parsed = parseFfmpegInputLog('Stream #0:0: Video: h264');
    assert.equal(parsed.hasAudio, false);
    assert.equal(parsed.hasVideo, true);
    assert.ok(Number.isNaN(parsed.durationSeconds));
  });
});

describe('decideAudioAcceptance (bug produzione)', () => {
  it('BUG: ffprobe fallita + browser ok => NON blocca più', () => {
    // Prima del fix: streamExit !== 0 → streamRaw='' → throw "Nessuna traccia".
    const decision = decideAudioAcceptance({
      ffprobeOk: false,
      ffprobeHasAudio: false,
      ffmpegLogHasAudio: false,
      ffmpegLogHasVideo: false,
      browserDurationOk: true,
    });
    assert.equal(decision.accept, true);
    assert.equal(decision.reason, 'browser-duration-fallback');
  });

  it('ffprobe ok con audio => accept', () => {
    const decision = decideAudioAcceptance({
      ffprobeOk: true,
      ffprobeHasAudio: true,
      ffmpegLogHasAudio: false,
      ffmpegLogHasVideo: false,
      browserDurationOk: true,
    });
    assert.equal(decision.accept, true);
  });

  it('ffprobe ok SENZA audio => reject vero positivo', () => {
    const decision = decideAudioAcceptance({
      ffprobeOk: true,
      ffprobeHasAudio: false,
      ffmpegLogHasAudio: false,
      ffmpegLogHasVideo: false,
      browserDurationOk: false,
    });
    assert.equal(decision.accept, false);
    assert.match(decision.error, /Nessuna traccia audio/);
  });

  it('fallback ffmpeg -i con Audio => accept anche se ffprobe ko', () => {
    const decision = decideAudioAcceptance({
      ffprobeOk: false,
      ffprobeHasAudio: false,
      ffmpegLogHasAudio: true,
      ffmpegLogHasVideo: false,
      browserDurationOk: false,
    });
    assert.equal(decision.accept, true);
  });

  it('fallback video-only => reject', () => {
    const decision = decideAudioAcceptance({
      ffprobeOk: false,
      ffprobeHasAudio: false,
      ffmpegLogHasAudio: false,
      ffmpegLogHasVideo: true,
      browserDurationOk: false,
    });
    assert.equal(decision.accept, false);
    assert.match(decision.error, /Nessuna traccia audio/);
  });

  it('tutto inconclusivo senza browser => errore distinto da "nessuna traccia"', () => {
    const decision = decideAudioAcceptance({
      ffprobeOk: false,
      ffprobeHasAudio: false,
      ffmpegLogHasAudio: false,
      ffmpegLogHasVideo: false,
      browserDurationOk: false,
    });
    assert.equal(decision.accept, false);
    assert.match(decision.error, /Impossibile verificare/);
  });
});
