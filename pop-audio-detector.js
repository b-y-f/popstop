/*
 * PopStop's live-audio transient detector.
 *
 * The browser-facing code supplies one set of measurements per analyser frame.
 * Keeping the detector state here makes its thresholds and re-arming behaviour
 * testable without a microphone or DOM.
 */
(function exposePopAudioDetector(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PopStopAudio = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPopAudioDetector() {
  const DEFAULT_AUDIO_DETECTOR_CONFIG = Object.freeze({
    initialNoiseFloor: 0.006,
    minimumNoiseFloor: 0.0008,
    minimumRms: 0.0035,
    minimumPeak: 0.009,
    rmsMultiplier: 1.42,
    rmsOffset: 0.0008,
    peakMultiplier: 2.05,
    peakOffset: 0.001,
    rmsRiseMultiplier: 0.18,
    minimumRmsRise: 0.0011,
    peakRiseMultiplier: 0.45,
    minimumPeakRise: 0.0035,
    minimumHighEnergyRise: 0.0045,
    minimumSpectralFlux: 0.0035,
    minimumPeakAttackCrest: 1.75,
    minimumImpulseCrest: 2.05,
    impulseRmsMultiplier: 1.03,
    cooldownMs: 90,
    baselineRiseAlpha: 0.055,
    baselineFallAlpha: 0.01,
    detectedBaselineAlpha: 0.003,
    baselineRiseLimitMultiplier: 1.8,
    baselineRiseLimitOffset: 0.003,
    detectedRiseLimitMultiplier: 1.3,
    detectedRiseLimitOffset: 0.001,
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finiteOrZero(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  class PopAudioDetector {
    constructor(config = {}) {
      this.config = { ...DEFAULT_AUDIO_DETECTOR_CONFIG, ...config };
      this.reset(this.config.initialNoiseFloor);
    }

    reset(noiseFloor = this.config.initialNoiseFloor) {
      this.noiseFloor = Math.max(this.config.minimumNoiseFloor, finiteOrZero(noiseFloor));
      this.previousRms = null;
      this.previousPeak = null;
      this.previousHighEnergy = null;
      this.lastDetectedAt = null;
    }

    setNoiseFloor(noiseFloor) {
      if (!Number.isFinite(noiseFloor)) return;
      this.noiseFloor = Math.max(this.config.minimumNoiseFloor, noiseFloor);
    }

    processFrame(frame = {}) {
      const timestamp = Number(frame.timestamp);
      const rms = finiteOrZero(frame.rms);
      const peak = finiteOrZero(frame.peak);
      const highEnergy = finiteOrZero(frame.highEnergy);
      const spectralFlux = finiteOrZero(frame.spectralFlux);
      const background = Math.max(this.config.minimumNoiseFloor, this.noiseFloor);

      const rmsThreshold = Math.max(
        this.config.minimumRms,
        background * this.config.rmsMultiplier + this.config.rmsOffset,
      );
      const peakThreshold = Math.max(
        this.config.minimumPeak,
        background * this.config.peakMultiplier + this.config.peakOffset,
      );

      // The first frame primes the onset comparison. Treating microphone start-up
      // as a pop would contaminate both the counter and the phase tracker.
      if (
        this.previousRms === null ||
        this.previousPeak === null ||
        this.previousHighEnergy === null ||
        !Number.isFinite(timestamp)
      ) {
        this.previousRms = rms;
        this.previousPeak = peak;
        this.previousHighEnergy = highEnergy;
        this.updateNoiseFloor(rms, false);
        return {
          detected: false,
          noiseFloor: this.noiseFloor,
          rmsThreshold,
          peakThreshold,
          confidence: 0,
        };
      }

      const rmsRise = rms - this.previousRms;
      const peakRise = peak - this.previousPeak;
      const highEnergyRise = highEnergy - this.previousHighEnergy;
      const crestFactor = peak / Math.max(rms, this.config.minimumNoiseFloor);
      const rmsAttack =
        rmsRise >= Math.max(this.config.minimumRmsRise, background * this.config.rmsRiseMultiplier);
      const peakAttack =
        peakRise >= Math.max(this.config.minimumPeakRise, background * this.config.peakRiseMultiplier);
      const spectralAttack =
        highEnergyRise >= this.config.minimumHighEnergyRise ||
        spectralFlux >= this.config.minimumSpectralFlux;
      const peakAttackHasShape = peakAttack && crestFactor >= this.config.minimumPeakAttackCrest;
      const hasTransientOnset = rmsAttack || spectralAttack || peakAttackHasShape;

      // One path catches an obvious broadband jump; the second catches a quieter,
      // muffled pop whose RMS barely rises but whose waveform still has a sharp peak.
      const broadbandTransient =
        rms >= rmsThreshold && peak >= peakThreshold && hasTransientOnset;
      const impulsiveTransient =
        peak >= peakThreshold &&
        rms >= Math.max(this.config.minimumRms * 0.72, background * this.config.impulseRmsMultiplier) &&
        crestFactor >= this.config.minimumImpulseCrest &&
        (peakAttack || spectralAttack);

      // Cooldown replaces the old "must become almost silent" re-arm gate. A
      // microwave's fan can now remain loud between pops without locking detection.
      const cooldownComplete =
        this.lastDetectedAt === null || timestamp - this.lastDetectedAt >= this.config.cooldownMs;
      const detected = cooldownComplete && (broadbandTransient || impulsiveTransient);

      if (detected) this.lastDetectedAt = timestamp;
      this.updateNoiseFloor(rms, detected);
      this.previousRms = rms;
      this.previousPeak = peak;
      this.previousHighEnergy = highEnergy;

      const levelScore = Math.max(rms / rmsThreshold, peak / peakThreshold);
      const onsetScore = Math.max(
        rmsRise / Math.max(this.config.minimumRmsRise, background * this.config.rmsRiseMultiplier),
        peakRise / Math.max(this.config.minimumPeakRise, background * this.config.peakRiseMultiplier),
        highEnergyRise / this.config.minimumHighEnergyRise,
        spectralFlux / this.config.minimumSpectralFlux,
      );

      return {
        detected,
        noiseFloor: this.noiseFloor,
        rmsThreshold,
        peakThreshold,
        confidence: detected ? clamp((levelScore + Math.max(0, onsetScore)) / 4, 0, 1) : 0,
        features: {
          rmsRise,
          peakRise,
          highEnergyRise,
          spectralFlux,
          crestFactor,
        },
      };
    }

    updateNoiseFloor(rms, detected) {
      const background = Math.max(this.config.minimumNoiseFloor, this.noiseFloor);
      const ceiling = detected
        ? background * this.config.detectedRiseLimitMultiplier + this.config.detectedRiseLimitOffset
        : background * this.config.baselineRiseLimitMultiplier + this.config.baselineRiseLimitOffset;
      const boundedRms = Math.min(rms, ceiling);
      const alpha = detected
        ? this.config.detectedBaselineAlpha
        : boundedRms > background
          ? this.config.baselineRiseAlpha
          : this.config.baselineFallAlpha;
      this.noiseFloor = Math.max(
        this.config.minimumNoiseFloor,
        background * (1 - alpha) + boundedRms * alpha,
      );
    }
  }

  return { DEFAULT_AUDIO_DETECTOR_CONFIG, PopAudioDetector };
});
