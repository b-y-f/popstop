/*
 * PopStop's decision layer.
 *
 * This file intentionally contains no browser or microphone code.  Keeping the
 * timing policy separate makes it possible to test the safety gates with
 * recorded event timelines before changing the live-audio detector.
 */
(function exposePopStopLogic(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PopStopLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPopStopLogic() {
  const DEFAULT_CONFIG = Object.freeze({
    historyMs: 180000,
    rateWindowMs: 6000,
    activityWindowMs: 4000,
    minEventsPerActivityWindow: 3,
    minEventsToArm: 7,
    minActiveSpanMs: 4500,
    slowdownRatio: 0.62,
    slowdownGapRatio: 0.7,
    minimumSlowdownGapMs: 900,
    slowdownConfirmationMs: 350,
    recoveryRatio: 0.78,
    recoveryGapRatio: 0.35,
  });

  function countEvents(events, startAt, endAt) {
    return events.filter((eventAt) => eventAt > startAt && eventAt <= endAt).length;
  }

  function safeTargetGapMs(targetGapSeconds) {
    return Math.max(1000, Number(targetGapSeconds) * 1000 || 0);
  }

  class PoppingPhaseTracker {
    constructor(config = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.reset();
    }

    reset() {
      this.events = [];
      this.phase = "observing";
      this.lastPopAt = null;
      this.activeSince = null;
      this.slowdownCandidateAt = null;
      this.slowingSince = null;
      this.promptedAt = null;
      this.peakRate = 0;
    }

    get eventCount() {
      return this.events.length;
    }

    getRate(now, windowMs = this.config.rateWindowMs) {
      return countEvents(this.events, now - windowMs, now) * (60000 / windowMs);
    }

    getGapMs(now) {
      return this.lastPopAt === null ? 0 : Math.max(0, now - this.lastPopAt);
    }

    recordPop(timestamp, targetGapSeconds) {
      if (!Number.isFinite(timestamp) || this.phase === "prompted") return this.snapshot(timestamp);

      this.events.push(timestamp);
      this.lastPopAt = timestamp;
      this.events = this.events.filter((eventAt) => timestamp - eventAt <= this.config.historyMs);
      return this.tick(timestamp, targetGapSeconds);
    }

    tick(now, targetGapSeconds) {
      if (!Number.isFinite(now)) return this.snapshot(now);
      if (this.phase === "prompted" || this.lastPopAt === null) return this.snapshot(now);

      if (this.phase === "observing" && this.hasSustainedActivity(now)) {
        this.phase = "active";
        this.activeSince = now;
        this.peakRate = Math.max(this.peakRate, this.getRate(now));
      }

      if (this.phase === "active" || this.phase === "slowing") {
        const rate = this.getRate(now);
        if (rate > this.peakRate) this.peakRate = rate;
        this.updateSlowdown(now, targetGapSeconds, rate);
      }

      const targetGapMs = safeTargetGapMs(targetGapSeconds);
      if (this.phase === "slowing" && this.getGapMs(now) >= targetGapMs) {
        this.phase = "prompted";
        this.promptedAt = now;
      }

      return this.snapshot(now);
    }

    hasSustainedActivity(now) {
      if (this.eventCount < this.config.minEventsToArm) return false;

      const firstPopAt = this.events[0];
      if (now - firstPopAt < this.config.minActiveSpanMs) return false;

      const currentWindowStart = now - this.config.activityWindowMs;
      const previousWindowStart = currentWindowStart - this.config.activityWindowMs;
      const priorCount = countEvents(this.events, previousWindowStart, currentWindowStart);
      const recentCount = countEvents(this.events, currentWindowStart, now);

      return (
        priorCount >= this.config.minEventsPerActivityWindow &&
        recentCount >= this.config.minEventsPerActivityWindow
      );
    }

    updateSlowdown(now, targetGapSeconds, currentRate) {
      const targetGapMs = safeTargetGapMs(targetGapSeconds);
      const gapMs = this.getGapMs(now);
      const rateHasFallen =
        this.peakRate > 0 && currentRate <= this.peakRate * this.config.slowdownRatio;
      const silenceIsApproaching =
        gapMs >= Math.max(this.config.minimumSlowdownGapMs, targetGapMs * this.config.slowdownGapRatio);
      const slowdownSignal = rateHasFallen || silenceIsApproaching;

      if (this.phase === "active") {
        if (!slowdownSignal) {
          this.slowdownCandidateAt = null;
          return;
        }

        if (this.slowdownCandidateAt === null) {
          const silenceSignalAt = this.lastPopAt + Math.max(
            this.config.minimumSlowdownGapMs,
            targetGapMs * this.config.slowdownGapRatio,
          );
          this.slowdownCandidateAt = silenceIsApproaching ? silenceSignalAt : now;
        }
        if (now - this.slowdownCandidateAt >= this.config.slowdownConfirmationMs) {
          this.phase = "slowing";
          this.slowingSince = now;
        }
        return;
      }

      const hasRecovered =
        currentRate >= this.peakRate * this.config.recoveryRatio &&
        gapMs < targetGapMs * this.config.recoveryGapRatio;
      if (hasRecovered) {
        this.phase = "active";
        this.slowingSince = null;
        this.slowdownCandidateAt = null;
      }
    }

    snapshot(now) {
      const gapMs = Number.isFinite(now) ? this.getGapMs(now) : 0;
      return {
        phase: this.phase,
        eventCount: this.eventCount,
        lastPopAt: this.lastPopAt,
        gapMs,
        rate: Number.isFinite(now) ? this.getRate(now) : 0,
        peakRate: this.peakRate,
        activeSince: this.activeSince,
        slowingSince: this.slowingSince,
        promptedAt: this.promptedAt,
      };
    }
  }

  return { DEFAULT_CONFIG, PoppingPhaseTracker };
});
