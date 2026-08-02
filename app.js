/*
 * 啪停 PopStop MVP
 *
 * This is intentionally a client-only prototype. Audio stays in the browser;
 * no audio is recorded or sent anywhere. The detector looks for a local,
 * short-lived jump above the measured room-noise level, then evaluates the
 * gap after an active popping run. It is a reminder, never a microwave control.
 */

const { PoppingPhaseTracker } = window.PopStopLogic;

const els = {
  listenCard: document.querySelector("#listenCard"),
  signalOrb: document.querySelector("#signalOrb"),
  statusKicker: document.querySelector("#statusKicker"),
  statusTitle: document.querySelector("#listenHeading"),
  statusMessage: document.querySelector("#statusMessage"),
  audioCanvas: document.querySelector("#audioCanvas"),
  waveLabel: document.querySelector("#waveLabel"),
  popCount: document.querySelector("#popCount"),
  lastGap: document.querySelector("#lastGap"),
  peakRate: document.querySelector("#peakRate"),
  listenButton: document.querySelector("#listenButton"),
  listenButtonText: document.querySelector("#listenButtonText"),
  demoButton: document.querySelector("#demoButton"),
  strategyCaption: document.querySelector("#strategyCaption"),
  tuneBadge: document.querySelector("#tuneBadge"),
  feedbackCard: document.querySelector("#feedbackCard"),
  feedbackPrompt: document.querySelector("#feedbackPrompt"),
  resetCalibration: document.querySelector("#resetCalibration"),
  helpDialog: document.querySelector("#helpDialog"),
  howToButton: document.querySelector("#howToButton"),
  closeHelpButton: document.querySelector("#closeHelpButton"),
  dialogConfirm: document.querySelector("#dialogConfirm"),
  preferenceInputs: [...document.querySelectorAll('input[name="preference"]')],
  feedbackButtons: [...document.querySelectorAll("[data-feedback]")],
};

const baseGapByPreference = {
  conservative: 1.7,
  balanced: 2.1,
  full: 2.5,
};

const labelsByPreference = {
  conservative: "少焦糊模式会在一轮活跃爆裂后，约 <strong>%s 秒</strong>未听到下一声时提醒你。",
  balanced: "平衡模式会在一轮活跃爆裂后，约 <strong>%s 秒</strong>未听到下一声时提醒你。",
  full: "多爆一些模式会在一轮活跃爆裂后，约 <strong>%s 秒</strong>未听到下一声时提醒你。",
};

const calibrationStorageKey = "popstop-calibration-v1";

const state = {
  isListening: false,
  isDemo: false,
  hasPromptedStop: false,
  status: "idle",
  preference: "balanced",
  calibrationOffset: loadCalibration(),
  tracker: new PoppingPhaseTracker(),
  audioContext: null,
  analyser: null,
  stream: null,
  timeData: null,
  frequencyData: null,
  animationId: null,
  lastFramePeak: 0,
  lastHighEnergy: 0,
  noiseFloor: 0.006,
  initialNoiseSamples: [],
  calibrationStartedAt: 0,
  isCalibrating: false,
  detectorArmed: true,
  demoTimers: [],
  wakeLock: null,
  visualSamples: Array.from({ length: 60 }, () => 0.05),
};

function loadCalibration() {
  try {
    const stored = Number.parseFloat(localStorage.getItem(calibrationStorageKey));
    return Number.isFinite(stored) ? clamp(stored, -0.55, 0.55) : 0;
  } catch {
    return 0;
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(calibrationStorageKey, String(state.calibrationOffset));
  } catch {
    // Private-mode storage failures should never block use of the app.
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function currentTargetGap() {
  return clamp(baseGapByPreference[state.preference] + state.calibrationOffset, 1.25, 3.1);
}

function updateCalibrationBadge() {
  const hasCalibration = Math.abs(state.calibrationOffset) >= 0.04;
  els.tuneBadge.textContent = hasCalibration ? "已使用本机反馈校准" : "还没有本机校准";
  els.tuneBadge.classList.toggle("is-new", !hasCalibration);
}

function updateStrategyCaption() {
  const seconds = currentTargetGap().toFixed(1);
  els.strategyCaption.innerHTML = labelsByPreference[state.preference].replace("%s", seconds);
  updateCalibrationBadge();
}

function setStatus(kind, kicker, title, message) {
  const hasPopPulse = els.signalOrb.classList.contains("is-pop");
  state.status = kind;
  els.listenCard.classList.remove("is-ready", "is-stop");
  els.signalOrb.className = `signal-orb is-${kind}`;
  if (hasPopPulse) els.signalOrb.classList.add("is-pop");
  if (kind === "ready") els.listenCard.classList.add("is-ready");
  if (kind === "stop") els.listenCard.classList.add("is-stop");
  els.statusKicker.textContent = kicker;
  els.statusTitle.textContent = title;
  els.statusMessage.textContent = message;
}

function setIdleStatus() {
  setStatus("idle", "尚未开始", "准备听爆裂声", "把手机放在微波炉外侧，点开始后保持页面开启。");
  els.waveLabel.textContent = "等待音频输入";
  els.waveLabel.hidden = false;
}

function updateMetrics(now = performance.now(), snapshot = state.tracker.snapshot(now)) {
  els.popCount.textContent = String(snapshot.eventCount);
  els.peakRate.textContent = snapshot.peakRate > 0 ? String(Math.round(snapshot.peakRate)) : "—";

  if (!snapshot.lastPopAt) {
    els.lastGap.textContent = "—";
    return 0;
  }

  const gap = snapshot.gapMs / 1000;
  els.lastGap.textContent = gap < 10 ? gap.toFixed(1) : "10+";
  return gap;
}

function evaluatePoppingState(now) {
  if (!state.isListening || state.isCalibrating) return;

  const targetGap = currentTargetGap();
  const snapshot = state.tracker.tick(now, targetGap);
  const gap = updateMetrics(now, snapshot);

  if (!snapshot.lastPopAt) {
    setStatus("listening", state.isDemo ? "演示正在进行" : "正在监听", "等第一声爆裂", "环境基线已建立。保持手机靠近炉外，并尽量减少其他声音。");
    return;
  }

  if (snapshot.phase === "observing" && snapshot.eventCount < state.tracker.config.minEventsToArm) {
    setStatus("listening", state.isDemo ? "演示正在进行" : "正在监听", "正在认识这一炉", "已经听到爆裂声；再多听一会儿，才能判断节奏变化。");
    return;
  }

  if (snapshot.phase === "observing") {
    setStatus("listening", state.isDemo ? "演示正在进行" : "正在监听", "等待稳定活跃段", "需要连续观察到两段密集爆裂，才会把这一炉交给停机判断。");
    return;
  }

  if (snapshot.phase === "prompted") {
    if (!state.hasPromptedStop) {
      state.hasPromptedStop = true;
      setStatus("stop", "低焦糊风险窗口", "建议现在停止微波炉", `距上一声爆裂 ${gap.toFixed(1)} 秒，已超过本轮 ${targetGap.toFixed(1)} 秒提醒阈值。`);
      els.waveLabel.textContent = "请亲自按下微波炉停止键";
      els.waveLabel.hidden = false;
      els.feedbackCard.hidden = false;
      if (navigator.vibrate) navigator.vibrate([130, 65, 130, 65, 230]);
    }
    return;
  }

  if (snapshot.phase === "slowing") {
    setStatus("ready", "已确认减速", "准备停机", `已看到活跃爆裂后的持续回落；若下一声仍未到，约 ${Math.max(0, targetGap - gap).toFixed(1)} 秒后会提醒你。`);
    return;
  }

  setStatus("listening", state.isDemo ? "演示正在进行" : "正在监听", "爆裂活跃中", "节奏仍然活跃，继续听这一炉自己的爆裂曲线。");
}

function registerPop(timestamp = performance.now()) {
  if (!state.isListening || state.tracker.phase === "prompted") return;

  const snapshot = state.tracker.recordPop(timestamp, currentTargetGap());
  els.signalOrb.classList.add("is-pop");
  window.setTimeout(() => els.signalOrb.classList.remove("is-pop"), 180);
  els.waveLabel.hidden = true;
  updateMetrics(timestamp, snapshot);
  evaluatePoppingState(timestamp);
}

function resetRound() {
  state.tracker.reset();
  state.hasPromptedStop = false;
  state.lastFramePeak = 0;
  state.lastHighEnergy = 0;
  state.noiseFloor = 0.006;
  state.initialNoiseSamples = [];
  state.detectorArmed = true;
  state.visualSamples = Array.from({ length: 60 }, () => 0.05);
  els.feedbackCard.hidden = true;
  els.feedbackPrompt.textContent = "你的反馈只会保存在这台设备，用来微调下次提醒。";
  els.feedbackButtons.forEach((button) => {
    button.disabled = false;
    button.classList.remove("is-chosen");
  });
  updateMetrics();
}

function drawWave(level = 0.04, isPop = false) {
  const canvas = els.audioCanvas;
  const context = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 85;
  const width = Math.floor(cssWidth * pixelRatio);
  const height = Math.floor(cssHeight * pixelRatio);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  const amplitude = clamp(level * 8.2, 0.035, 0.95);
  state.visualSamples.shift();
  state.visualSamples.push(isPop ? 1 : amplitude);

  const middle = height / 2;
  const step = width / (state.visualSamples.length - 1);
  context.beginPath();
  state.visualSamples.forEach((sample, index) => {
    const organic = Math.sin(index * 1.74 + performance.now() / 330) * 0.12;
    const y = middle - (sample + organic) * height * 0.33;
    if (index === 0) context.moveTo(0, y);
    else context.lineTo(index * step, y);
  });
  context.strokeStyle = "rgba(255, 220, 136, 0.92)";
  context.lineWidth = Math.max(1.4 * pixelRatio, 1.4);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  context.beginPath();
  state.visualSamples.forEach((sample, index) => {
    const organic = Math.cos(index * 1.42 + performance.now() / 370) * 0.08;
    const y = middle + (sample + organic) * height * 0.26;
    if (index === 0) context.moveTo(0, y);
    else context.lineTo(index * step, y);
  });
  context.strokeStyle = "rgba(171, 218, 194, 0.58)";
  context.lineWidth = Math.max(pixelRatio, 1);
  context.stroke();
}

function analyseFrame(timestamp) {
  if (!state.isListening || state.isDemo || !state.analyser) return;

  state.analyser.getFloatTimeDomainData(state.timeData);
  state.analyser.getByteFrequencyData(state.frequencyData);

  let sumSquares = 0;
  let peak = 0;
  for (const sample of state.timeData) {
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    if (absolute > peak) peak = absolute;
  }
  const rms = Math.sqrt(sumSquares / state.timeData.length);

  // Popcorn snaps are usually brief and broadband. High-frequency energy helps
  // reject a few low, steady kitchen sounds without pretending this is a model.
  const highStart = Math.floor(state.frequencyData.length * 0.18);
  let highEnergy = 0;
  for (let index = highStart; index < state.frequencyData.length; index += 1) {
    highEnergy += state.frequencyData[index] / 255;
  }
  highEnergy /= state.frequencyData.length - highStart;

  if (state.isCalibrating) {
    state.initialNoiseSamples.push(rms);
    if (timestamp - state.calibrationStartedAt >= 2400) {
      state.noiseFloor = Math.max(0.0018, median(state.initialNoiseSamples));
      state.isCalibrating = false;
      els.waveLabel.hidden = true;
      setStatus("listening", "正在监听", "等第一声爆裂", "环境基线已建立。保持手机靠近炉外，并尽量减少其他声音。");
    }
    drawWave(rms);
    state.animationId = requestAnimationFrame(analyseFrame);
    return;
  }

  const threshold = Math.max(0.012, state.noiseFloor * 3.25 + 0.003);
  const peakThreshold = Math.max(0.026, threshold * 1.45);
  const highEnergyRise = highEnergy - state.lastHighEnergy;
  const sharpRise = peak - state.lastFramePeak;
  const now = performance.now();
  const sufficientBreak = !state.tracker.lastPopAt || now - state.tracker.lastPopAt > 170;
  const candidate =
    rms > threshold &&
    peak > peakThreshold &&
    sufficientBreak &&
    state.detectorArmed &&
    (highEnergyRise > 0.008 || sharpRise > threshold * 0.45);

  if (candidate) {
    state.detectorArmed = false;
    registerPop(now);
  }

  if (rms < threshold * 0.68) state.detectorArmed = true;

  // Update the baseline slowly only when the frame is plausibly background sound.
  if (!candidate && rms < Math.max(threshold * 1.18, state.noiseFloor * 2.1)) {
    state.noiseFloor = state.noiseFloor * 0.992 + rms * 0.008;
  }

  state.lastFramePeak = peak;
  state.lastHighEnergy = highEnergy;
  drawWave(rms, candidate);
  evaluatePoppingState(now);
  state.animationId = requestAnimationFrame(analyseFrame);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // It is optional; audio detection should still work if it is unavailable.
  }
}

async function releaseWakeLock() {
  if (!state.wakeLock) return;
  try {
    await state.wakeLock.release();
  } catch {
    // A released lock may reject when the page is already hidden.
  }
  state.wakeLock = null;
}

async function startListening() {
  if (state.isListening) {
    stopListening();
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus("idle", "需要安全连接", "请通过 GitHub Pages 打开", "手机浏览器只会在 HTTPS 页面上允许麦克风。部署后再点开始监听。");
    return;
  }

  resetRound();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
    await state.audioContext.resume();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.16;
    source.connect(state.analyser);
    state.timeData = new Float32Array(state.analyser.fftSize);
    state.frequencyData = new Uint8Array(state.analyser.frequencyBinCount);
    state.isListening = true;
    state.isDemo = false;
    state.isCalibrating = true;
    state.calibrationStartedAt = performance.now();
    els.listenButton.classList.add("is-active");
    els.listenButtonText.textContent = "停止监听";
    els.demoButton.disabled = true;
    els.waveLabel.textContent = "先听 2 秒环境声…";
    els.waveLabel.hidden = false;
    setStatus("listening", "建立环境基线", "先听一听厨房", "请保持安静约 2 秒，再开始微波爆米花。" );
    requestWakeLock();
    state.animationId = requestAnimationFrame(analyseFrame);
  } catch (error) {
    stopAudioResources();
    const message = microphoneErrorMessage(error);
    setStatus("idle", "无法开始监听", "需要麦克风权限", message);
  }
}

function microphoneErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "请在浏览器地址栏允许麦克风权限，再重新点“开始听爆声”。";
  }
  if (error?.name === "NotFoundError") {
    return "没有找到可用麦克风。请检查手机的麦克风权限或换一个浏览器。";
  }
  return "麦克风暂时无法使用。请检查权限、网络安全连接后再试。";
}

function stopAudioResources() {
  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  if (state.audioContext) state.audioContext.close().catch(() => {});
  state.audioContext = null;
  state.analyser = null;
}

function stopListening({ keepFeedback = true } = {}) {
  state.isListening = false;
  state.isDemo = false;
  state.isCalibrating = false;
  stopAudioResources();
  state.demoTimers.forEach((timer) => window.clearTimeout(timer));
  state.demoTimers = [];
  releaseWakeLock();
  els.listenButton.classList.remove("is-active");
  els.listenButtonText.textContent = "开始听爆声";
  els.demoButton.disabled = false;
  els.waveLabel.textContent = "本轮监听已结束";
  els.waveLabel.hidden = false;

  if (keepFeedback && state.tracker.eventCount >= 3) {
    els.feedbackCard.hidden = false;
    if (!state.hasPromptedStop) {
      els.feedbackPrompt.textContent = "即使你是手动停的，这个结果也能帮助下次更贴近你的微波炉。";
    }
    setStatus("idle", "本轮已结束", "听完这一炉", "看看实际结果后告诉啪停，它会只在这台设备上微调下一次提醒。" );
  } else {
    setIdleStatus();
  }
}

function startDemo() {
  if (state.isListening) return;
  resetRound();
  state.isListening = true;
  state.isDemo = true;
  state.isCalibrating = false;
  els.listenButton.classList.add("is-active");
  els.listenButtonText.textContent = "结束演示";
  els.demoButton.disabled = true;
  els.waveLabel.textContent = "这是模拟的爆裂节奏";
  els.waveLabel.hidden = false;
  setStatus("listening", "演示正在进行", "正在听模拟爆裂", "先密集、后变慢；它会在停机窗口出现时提醒。" );

  const demoIntervals = [
    1050, 2550, 1850, 1320, 1180, 1020, 920, 890, 960, 1040, 1140, 1370, 1650,
  ];
  let elapsed = 0;
  demoIntervals.forEach((delay) => {
    elapsed += delay;
    const timer = window.setTimeout(() => {
      if (!state.isDemo) return;
      registerPop(performance.now());
      drawWave(0.28, true);
    }, elapsed);
    state.demoTimers.push(timer);
  });

  const finishTimer = window.setTimeout(() => {
    if (!state.isDemo) return;
    // Let the normal state evaluator reach the selected gap; do not silently stop
    // the demo before the user has seen the prompt.
  }, elapsed + 100);
  state.demoTimers.push(finishTimer);

  function animateDemo() {
    if (!state.isDemo) return;
    drawWave(0.035 + Math.random() * 0.035);
    evaluatePoppingState(performance.now());
    state.animationId = requestAnimationFrame(animateDemo);
  }
  state.animationId = requestAnimationFrame(animateDemo);
}

function submitFeedback(kind) {
  const adjustments = { early: 0.18, good: 0, late: -0.18 };
  state.calibrationOffset = clamp(state.calibrationOffset + adjustments[kind], -0.55, 0.55);
  saveCalibration();
  updateStrategyCaption();

  const messages = {
    early: "已记住：下次会稍多等一会儿，再提示你停机。",
    good: "已记住：下次会沿用这个提醒节奏。",
    late: "已记住：下次会稍早一点提醒你停机。",
  };
  els.feedbackPrompt.textContent = messages[kind];
  els.feedbackButtons.forEach((button) => {
    button.disabled = true;
    button.classList.toggle("is-chosen", button.dataset.feedback === kind);
  });
}

function resetCalibration() {
  state.calibrationOffset = 0;
  saveCalibration();
  updateStrategyCaption();
  els.resetCalibration.textContent = "已重置";
  window.setTimeout(() => {
    els.resetCalibration.textContent = "重置本机校准";
  }, 1600);
}

els.listenButton.addEventListener("click", startListening);
els.demoButton.addEventListener("click", startDemo);
els.resetCalibration.addEventListener("click", resetCalibration);

els.preferenceInputs.forEach((input) => {
  input.addEventListener("change", () => {
    state.preference = input.value;
    document.querySelectorAll(".preference-option").forEach((option) => {
      option.classList.toggle("is-selected", option.querySelector("input").checked);
    });
    updateStrategyCaption();
    if (state.isListening) evaluatePoppingState(performance.now());
  });
});

els.feedbackButtons.forEach((button) => {
  button.addEventListener("click", () => submitFeedback(button.dataset.feedback));
});

els.howToButton.addEventListener("click", () => els.helpDialog.showModal());
els.closeHelpButton.addEventListener("click", () => els.helpDialog.close());
els.dialogConfirm.addEventListener("click", () => {
  els.helpDialog.close();
  window.setTimeout(() => els.listenButton.focus(), 120);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.isListening) requestWakeLock();
});

window.addEventListener("beforeunload", () => stopAudioResources());

updateStrategyCaption();
setIdleStatus();
drawWave();
