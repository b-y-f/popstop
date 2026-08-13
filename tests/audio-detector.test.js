const assert = require("node:assert/strict");
const { PopAudioDetector } = require("../pop-audio-detector.js");

function frame(detector, timestamp, rms, peak, highEnergy = 0.04, spectralFlux = 0) {
  return detector.processFrame({ timestamp, rms, peak, highEnergy, spectralFlux });
}

// A microwave fan can stay louder than the former absolute re-arm threshold.
// A later pop must still be detected after the short cooldown.
{
  const detector = new PopAudioDetector({ initialNoiseFloor: 0.003 });
  frame(detector, 0, 0.003, 0.006, 0.025);
  assert.equal(frame(detector, 20, 0.014, 0.058, 0.09, 0.035).detected, true);

  for (let timestamp = 40; timestamp <= 120; timestamp += 20) {
    const result = frame(detector, timestamp, 0.012, 0.019, 0.045, 0.0004);
    assert.equal(result.detected, false);
  }

  assert.equal(frame(detector, 140, 0.017, 0.066, 0.088, 0.028).detected, true);
}

// A quiet, muffled snap can have little RMS lift but still have an impulsive
// peak and spectral onset. The old RMS threshold would reject this frame.
{
  const detector = new PopAudioDetector({ initialNoiseFloor: 0.01 });
  frame(detector, 0, 0.01, 0.017, 0.04);
  const result = frame(detector, 20, 0.0107, 0.025, 0.044, 0.0042);
  assert.equal(result.detected, true);
  assert.ok(result.features.crestFactor > 2);
}

// Neighbouring analyser frames from the same acoustic snap must not be counted
// more than once, while a genuinely new snap after cooldown can be counted.
{
  const detector = new PopAudioDetector({ initialNoiseFloor: 0.004 });
  frame(detector, 0, 0.004, 0.007, 0.025);
  assert.equal(frame(detector, 20, 0.018, 0.07, 0.1, 0.04).detected, true);
  assert.equal(frame(detector, 40, 0.016, 0.062, 0.092, 0.01).detected, false);
  assert.equal(frame(detector, 60, 0.009, 0.025, 0.05, 0.001).detected, false);
  assert.equal(frame(detector, 80, 0.0045, 0.009, 0.03, 0).detected, false);
  assert.equal(frame(detector, 120, 0.017, 0.068, 0.095, 0.036).detected, true);
}

// A step from a quiet room to steady fan noise may look like one onset, but it
// must not repeatedly manufacture pops, and the background estimate must adapt.
{
  const detector = new PopAudioDetector({ initialNoiseFloor: 0.003 });
  frame(detector, 0, 0.003, 0.006, 0.02);
  let detections = 0;
  for (let index = 1; index <= 150; index += 1) {
    const ripple = index % 2 === 0 ? 0.00025 : -0.00025;
    const result = frame(
      detector,
      index * 20,
      0.018 + ripple,
      0.029 + ripple * 2,
      0.052 + ripple,
      index === 1 ? 0.018 : 0.0003,
    );
    if (result.detected) detections += 1;
  }

  assert.ok(detections <= 1, `steady fan produced ${detections} detections`);
  assert.ok(detector.noiseFloor > 0.015, `noise floor only reached ${detector.noiseFloor}`);
}

console.log("audio detector scenarios passed");
