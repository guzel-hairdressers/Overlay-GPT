/**
 * Real-time Audio Noise Level Analyzer & Voice Activity Detector (VAD)
 * Features:
 *  1. 1.5-Second Dedicated Calibration Phase (samples ambient background room noise for 1500ms without speech detection)
 *  2. Noise Floor Freeze during Speech (prevents loud speech audio from ever elevating the background noise floor)
 *  3. Dual-Threshold Hysteresis VAD (Onset +8.0 dB, Offset +3.5 dB to prevent premature cutoff)
 *  4. Stable Silence Timer (1.6s continuous silence triggers auto-submission)
 */
class AudioNoiseAnalyzer {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.onsetThresholdDb = options.onsetThresholdDb ?? 8.0;    // dB above noise floor to START speech
    this.offsetThresholdDb = options.offsetThresholdDb ?? 3.5;   // dB above noise floor to END speech
    this.silenceMs = options.silenceMs ?? 1600;                 // ms of silence after speech to trigger callback
    this.calibrationDurationMs = options.calibrationDurationMs ?? 1500; // 1.5s dedicated ambient noise calibration
    this.minSpeechFrames = 4;                                    // ~70ms quick onset confirmation
    
    this.onSilence = options.onSilence || null;
    this.onSpeechStart = options.onSpeechStart || null;
    this.onVolumeChange = options.onVolumeChange || null;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    if (this.audioCtx.createMediaStreamTrackSource && stream.getAudioTracks && stream.getAudioTracks().length > 0) {
      this.source = this.audioCtx.createMediaStreamTrackSource(stream.getAudioTracks()[0]);
    } else {
      this.source = this.audioCtx.createMediaStreamSource(stream);
    }
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.3;
    this.source.connect(this.analyser);

    this.dataArray = new Float32Array(this.analyser.frequencyBinCount);
    
    this.isAnalyzing = false;
    this.isCalibrated = false;
    this.calibrationStart = null;
    this.calibrationSamples = [];

    this.speechFrameCount = 0;
    this.hasSpoken = false;
    this.isSpeaking = false;
    this.noiseFloorDb = -60;
    this.silenceStart = null;
    this.animFrameId = null;

    this.start();
  }

  start() {
    if (this.isAnalyzing) return;
    this.isAnalyzing = true;
    this.calibrationStart = Date.now();
    this.loop();
  }

  stop() {
    this.isAnalyzing = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (e) {}
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try { this.audioCtx.close(); } catch (e) {}
    }
  }

  resetSpeechState() {
    this.speechFrameCount = 0;
    this.hasSpoken = false;
    this.isSpeaking = false;
    this.silenceStart = null;
  }

  loop = () => {
    if (!this.isAnalyzing) return;

    this.analyser.getFloatTimeDomainData(this.dataArray);

    // Compute Root Mean Square (RMS)
    let sumSquares = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const val = this.dataArray[i];
      sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / this.dataArray.length);
    
    // Convert RMS to dBFS (-90 dB to 0 dB)
    let currentDb = rms > 0.00003 ? 20 * Math.log10(rms) : -90;
    currentDb = Math.max(-90, Math.min(0, currentDb));

    // Phase 1: Dedicated 1.5-Second Ambient Noise Calibration
    const elapsedCalib = Date.now() - this.calibrationStart;
    if (elapsedCalib < this.calibrationDurationMs) {
      this.calibrationSamples.push(currentDb);
      const sum = this.calibrationSamples.reduce((a, b) => a + b, 0);
      this.noiseFloorDb = sum / this.calibrationSamples.length;

      const remainingCalibSec = Math.max(0, (this.calibrationDurationMs - elapsedCalib) / 1000).toFixed(1);

      if (this.onVolumeChange) {
        this.onVolumeChange({
          currentDb: Math.round(currentDb),
          noiseFloorDb: Math.round(this.noiseFloorDb),
          onsetThresholdDb: this.onsetThresholdDb,
          offsetThresholdDb: this.offsetThresholdDb,
          isCalibrating: true,
          calibrationRemainingSec: remainingCalibSec,
          isSpeech: false,
          hasSpoken: false,
          silenceElapsedMs: 0,
          silenceMs: this.silenceMs
        });
      }
      this.animFrameId = requestAnimationFrame(this.loop);
      return;
    }

    if (!this.isCalibrated) {
      this.isCalibrated = true;
    }

    // Dynamic Noise Floor Update: ONLY update when current volume is at or below baseline (true room quiet)
    // NEVER update noise floor during speech or speech spikes!
    if (!this.isSpeaking && currentDb <= (this.noiseFloorDb + 2.0)) {
      this.noiseFloorDb = this.noiseFloorDb * 0.95 + currentDb * 0.05;
    }

    // Dynamic Thresholds
    const onsetLevel = this.noiseFloorDb + this.onsetThresholdDb;
    const offsetLevel = this.noiseFloorDb + this.offsetThresholdDb;

    // Phase 2: Speech Onset / Offset Detection
    if (!this.isSpeaking) {
      if (currentDb > onsetLevel) {
        this.speechFrameCount++;
        if (this.speechFrameCount >= this.minSpeechFrames) {
          // Confirmed speech onset!
          this.isSpeaking = true;
          this.silenceStart = null;
          if (!this.hasSpoken) {
            this.hasSpoken = true;
            if (this.onSpeechStart) this.onSpeechStart();
          }
        }
      } else {
        this.speechFrameCount = 0;
      }
    } else {
      // Currently speaking — keep speaking unless volume drops below offsetLevel
      if (currentDb <= offsetLevel) {
        this.isSpeaking = false;
        this.speechFrameCount = 0;
        this.silenceStart = Date.now();
      } else {
        this.silenceStart = null;
      }
    }

    // Phase 3: Silence Countdown after Speech (1.0s silence triggers chunk flush, continues listening)
    if (this.hasSpoken && !this.isSpeaking) {
      if (!this.silenceStart) {
        this.silenceStart = Date.now();
      } else {
        const elapsedSilence = Date.now() - this.silenceStart;
        if (elapsedSilence >= this.silenceMs) {
          this.resetSpeechState();
          if (this.onSilence) this.onSilence();
        }
      }
    }

    const silenceElapsedMs = (this.hasSpoken && !this.isSpeaking && this.silenceStart)
      ? (Date.now() - this.silenceStart) : 0;

    if (this.onVolumeChange) {
      this.onVolumeChange({
        currentDb: Math.round(currentDb),
        noiseFloorDb: Math.round(this.noiseFloorDb),
        onsetThresholdDb: this.onsetThresholdDb,
        offsetThresholdDb: this.offsetThresholdDb,
        isCalibrating: false,
        isSpeech: this.isSpeaking,
        hasSpoken: this.hasSpoken,
        silenceElapsedMs,
        silenceMs: this.silenceMs
      });
    }

    this.animFrameId = requestAnimationFrame(this.loop);
  };
}

if (typeof module !== 'undefined') {
  module.exports = AudioNoiseAnalyzer;
} else {
  window.AudioNoiseAnalyzer = AudioNoiseAnalyzer;
}
