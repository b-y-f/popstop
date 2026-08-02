const assert = require("node:assert/strict");
const { PoppingPhaseTracker } = require("../popping-logic.js");

const targetGapSeconds = 2.1;

function addEvents(tracker, seconds) {
  seconds.forEach((second) => tracker.recordPop(second * 1000, targetGapSeconds));
}

function tick(tracker, seconds) {
  return tracker.tick(seconds * 1000, targetGapSeconds);
}

// Two early pops must never arm a stop reminder, even after a long silence.
{
  const tracker = new PoppingPhaseTracker();
  addEvents(tracker, [1, 2]);
  const result = tick(tracker, 12);
  assert.equal(result.phase, "observing");
  assert.equal(result.eventCount, 2);
}

// A short burst alone is not a proven middle/active phase.
{
  const tracker = new PoppingPhaseTracker();
  addEvents(tracker, [1, 1.2, 1.4, 1.6, 1.8, 2, 2.2]);
  const result = tick(tracker, 6);
  assert.equal(result.phase, "observing");
}

// Two consecutive dense windows establish activity; a sustained tail then prompts.
{
  const tracker = new PoppingPhaseTracker();
  addEvents(tracker, [0, 1, 2, 4.5, 5.5, 6.5, 7.5]);
  assert.equal(tick(tracker, 7.5).phase, "active");

  assert.equal(tick(tracker, 9).phase, "active");
  assert.equal(tick(tracker, 9.4).phase, "slowing");
  assert.equal(tick(tracker, 9.7).phase, "prompted");
}

// A renewed dense pop sequence cancels an in-progress slowdown rather than prompting.
{
  const tracker = new PoppingPhaseTracker();
  addEvents(tracker, [0, 1, 2, 4.5, 5.5, 6.5, 7.5]);
  tick(tracker, 9);
  assert.equal(tick(tracker, 9.4).phase, "slowing");
  tracker.recordPop(9.5 * 1000, targetGapSeconds);
  assert.equal(tick(tracker, 9.5).phase, "active");
}

// Keep the in-product demo valid against the same decision policy.
{
  const tracker = new PoppingPhaseTracker();
  const demoIntervals = [
    1050, 2550, 1850, 1320, 1180, 1020, 920, 890, 960, 1040, 1140, 1370, 1650,
  ];
  let elapsed = 0;
  demoIntervals.forEach((interval) => {
    elapsed += interval;
    tracker.recordPop(elapsed, targetGapSeconds);
  });

  assert.equal(tracker.tick(elapsed + 2200, targetGapSeconds).phase, "prompted");
}

console.log("popping-logic scenarios passed");
