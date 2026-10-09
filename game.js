(() => {
  "use strict";

  const config = window.CASINO_CONFIG;
  if (!config || !Array.isArray(config.symbols) || config.symbols.length < 2) {
    throw new Error("Casino configuration is missing or invalid.");
  }

  const titleEl = document.getElementById("gameTitle");
  const spinButton = document.getElementById("spinButton");
  const spinLabel = document.getElementById("spinLabel");
  const statusText = document.getElementById("statusText");
  const oddsNote = document.getElementById("oddsNote");
  const strips = [...document.querySelectorAll(".reel-strip")];
  const overlay = document.getElementById("resultOverlay");
  const resultCard = document.getElementById("resultCard");
  const resultKicker = document.getElementById("resultKicker");
  const resultTitle = document.getElementById("resultTitle");
  const resultImage = document.getElementById("resultImage");
  const resultMessage = document.getElementById("resultMessage");
  const playAgainButton = document.getElementById("playAgainButton");
  const confettiLayer = document.getElementById("confettiLayer");

  titleEl.textContent = config.title || "Jackpot de los valores";
  document.title = config.title || "Jackpot de los valores";

  const STORAGE_WINS = "casinoNightV1_wins";
  const STORAGE_SPINS = "casinoNightV1_spins";
  const cycles = 14;
  let spinning = false;
  let ready = false;
  let currentIndexes = [0, 1, 2];
  let autoCloseTimer = null;
  let audioContext = null;

  const itemSize = () => {
    const probe = document.querySelector(".reel-item");
    return probe ? probe.getBoundingClientRect().height : 150;
  };

  function secureRandomInt(max) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("max must be a positive integer");
    const range = 0x100000000;
    const limit = range - (range % max);
    const arr = new Uint32Array(1);
    do {
      crypto.getRandomValues(arr);
    } while (arr[0] >= limit);
    return arr[0] % max;
  }

  async function preloadImages() {
    const sources = [
      ...config.symbols.map((symbol) => symbol.image),
      "assets/celebrating-baby.png",
      "assets/crying-guy.png"
    ];

    await Promise.all(sources.map((src) => new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = async () => {
        try { if (img.decode) await img.decode(); } catch (_) {}
        resolve();
      };
      img.onerror = resolve;
      img.src = src;
    })));
  }

  function buildReels() {
    strips.forEach((strip, reelIndex) => {
      strip.innerHTML = "";
      for (let c = 0; c < cycles; c++) {
        config.symbols.forEach((symbol) => {
          const item = document.createElement("div");
          item.className = "reel-item";
          item.dataset.symbol = symbol.id;
          const img = document.createElement("img");
          img.src = symbol.image;
          img.alt = symbol.label;
          img.draggable = false;
          item.appendChild(img);
          strip.appendChild(item);
        });
      }
      normalizeReel(reelIndex, currentIndexes[reelIndex]);
    });
  }

  function normalizeReel(reelIndex, symbolIndex) {
    const strip = strips[reelIndex];
    const h = itemSize();
    const viewport = strip.parentElement.getBoundingClientRect().height;
    const centerOffset = (viewport - h) / 2;
    const targetItem = config.symbols.length + symbolIndex; // second cycle
    strip.style.transition = "none";
    strip.style.transform = `translateY(${centerOffset - targetItem * h}px)`;
    strip.getBoundingClientRect();
  }

  function jackpotLimitReached() {
    if (config.maximumJackpots == null) return false;
    const wins = Number(localStorage.getItem(STORAGE_WINS) || 0);
    return wins >= Number(config.maximumJackpots);
  }

  function generateNaturalResult() {
    return [0, 1, 2].map(() => secureRandomInt(config.symbols.length));
  }

  function generateNonJackpot() {
    let result;
    do {
      result = generateNaturalResult();
    } while (isJackpot(result));
    return result;
  }

  function generateResult() {
    const capped = jackpotLimitReached();

    if (config.oddsMode === "custom") {
      const oneIn = Math.max(2, Math.floor(Number(config.jackpotOneIn) || 16));
      const jackpot = !capped && secureRandomInt(oneIn) === 0;
      if (jackpot) {
        const winner = secureRandomInt(config.symbols.length);
        return [winner, winner, winner];
      }
      return generateNonJackpot();
    }

    const natural = generateNaturalResult();
    if (capped && isJackpot(natural)) return generateNonJackpot();
    return natural;
  }

  function isJackpot(result) {
    return result.every((value) => value === result[0]);
  }

  function incrementStorage(key) {
    const next = Number(localStorage.getItem(key) || 0) + 1;
    localStorage.setItem(key, String(next));
    return next;
  }

  function animateReel(reelIndex, targetSymbolIndex) {
    return new Promise((resolve) => {
      const strip = strips[reelIndex];
      normalizeReel(reelIndex, currentIndexes[reelIndex]);
      const h = itemSize();
      const viewport = strip.parentElement.getBoundingClientRect().height;
      const centerOffset = (viewport - h) / 2;
      const configuredCycles = Array.isArray(config.spinCycles) ? Number(config.spinCycles[reelIndex]) : NaN;
      const extraCycles = Number.isFinite(configuredCycles) ? Math.max(2, Math.floor(configuredCycles)) : 3 + reelIndex;
      const startCycle = 1;
      const targetItem = (startCycle + extraCycles) * config.symbols.length + targetSymbolIndex;
      const configuredDuration = Array.isArray(config.spinDurationMs) ? Number(config.spinDurationMs[reelIndex]) : NaN;
      const duration = Number.isFinite(configuredDuration) ? Math.max(1800, configuredDuration) : 3300 + reelIndex * 700;

      requestAnimationFrame(() => {
        strip.classList.add("spinning");
        strip.style.transition = `transform ${duration}ms cubic-bezier(.12,.72,.18,1)`;
        strip.style.transform = `translateY(${centerOffset - targetItem * h}px)`;
      });

      window.setTimeout(() => {
        strip.classList.remove("spinning");
        currentIndexes[reelIndex] = targetSymbolIndex;
        normalizeReel(reelIndex, targetSymbolIndex);
        playStopSound(reelIndex);
        resolve();
      }, duration + 30);
    });
  }

  async function spin() {
    if (!ready || spinning || overlay.classList.contains("open")) return;
    spinning = true;
    spinButton.disabled = true;
    spinLabel.textContent = "SPINNING";
    statusText.textContent = "¡buena suerte!";

    // Unlock WebAudio on the user's button press, then keep the reel sound
    // running until the final reel has stopped.
    const ctx = await ensureAudioContext();
    const stopSpinSound = startSpinSound(ctx);

    const result = generateResult();
    incrementStorage(STORAGE_SPINS);

    await Promise.all(result.map((target, index) => animateReel(index, target)));
    stopSpinSound();

    const won = isJackpot(result);
    if (won) incrementStorage(STORAGE_WINS);

    window.setTimeout(() => showResult(won), 260);
  }

  function showResult(won) {
    spinning = false;
    resultCard.classList.toggle("win", won);
    resultCard.classList.toggle("lose", !won);

    if (won) {
      resultKicker.textContent = "¡3 Valores Conseguidos!";
      resultTitle.textContent = "¡Jackpot!";
      resultImage.src = "assets/celebrating-baby.png";
      resultImage.alt = "Celebrating baby";
      resultMessage.textContent = "¡Lo Lograste, Felicidades!";
      if (config.confetti) launchConfetti();
      playWinSound();
    } else {
      resultKicker.textContent = "";
      resultTitle.textContent = "Mejor suerte para la próxima!";
      resultImage.src = "assets/crying-guy.png";
      resultImage.alt = "Crying character";
      resultMessage.textContent = "Toca PLAY para intentarlo otra vez.";
      confettiLayer.innerHTML = "";
      playLoseSound();
    }

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    playAgainButton.focus({ preventScroll: true });

    window.clearTimeout(autoCloseTimer);
    const displayMs = won
      ? Math.max(2200, Number(config.resultDisplayWinMs) || 5200)
      : Math.max(2600, Number(config.resultDisplayLoseMs) || 6800);
    autoCloseTimer = window.setTimeout(closeResult, displayMs);
  }

  function closeResult() {
    window.clearTimeout(autoCloseTimer);
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    confettiLayer.innerHTML = "";
    spinButton.disabled = false;
    spinLabel.textContent = "PLAY";
    statusText.textContent = "Toca PLAY para jugar";
    spinButton.focus({ preventScroll: true });
  }

  function launchConfetti() {
    confettiLayer.innerHTML = "";
    const colors = ["#ffc908", "#ff6371", "#00a9e0", "#a4d7f4", "#ffffff", "#00aa8e", "#005596"];
    for (let i = 0; i < 110; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti";
      piece.style.setProperty("--x", `${secureRandomInt(10000) / 100}%`);
      piece.style.setProperty("--w", `${6 + secureRandomInt(9)}px`);
      piece.style.setProperty("--c", colors[secureRandomInt(colors.length)]);
      piece.style.setProperty("--r", `${secureRandomInt(360)}deg`);
      piece.style.setProperty("--d", `${2.4 + secureRandomInt(220) / 100}s`);
      piece.style.setProperty("--delay", `${secureRandomInt(80) / 100}s`);
      piece.style.setProperty("--drift", `${-120 + secureRandomInt(241)}px`);
      confettiLayer.appendChild(piece);
    }
  }

  async function ensureAudioContext() {
    if (!config.sounds) return null;
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioContext = new Ctx();
    }

    // Browsers often create WebAudio in a suspended state. Resume it directly
    // from the PLAY button gesture so the spinning sound begins immediately.
    if (audioContext.state === "suspended") {
      try { await audioContext.resume(); } catch (_) {}
    }
    return audioContext;
  }

  function getRunningAudioContext() {
    if (!config.sounds || !audioContext || audioContext.state !== "running") return null;
    return audioContext;
  }

  function toneWithContext(ctx, freq, duration, volume = .05, type = "sine", delay = 0) {
    if (!ctx || ctx.state !== "running") return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime + delay;
    const safeEnd = start + Math.max(.03, duration);

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, volume), start + .012);
    gain.gain.exponentialRampToValueAtTime(0.0001, safeEnd);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(safeEnd + .04);
  }

  function tone(freq, duration, volume = .05, type = "sine", delay = 0) {
    const ctx = getRunningAudioContext();
    if (!ctx) return;
    toneWithContext(ctx, freq, duration, volume, type, delay);
  }

  function startSpinSound(ctx) {
    if (!ctx || ctx.state !== "running") return () => {};

    // Continuous filtered noise gives the reels a mechanical "whirr" for the
    // entire spin instead of only playing two short tones at the beginning.
    const bufferLength = Math.max(1, Math.floor(ctx.sampleRate * .35));
    const noiseBuffer = ctx.createBuffer(1, bufferLength, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * .75;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(950, ctx.currentTime);
    filter.Q.setValueAtTime(.8, ctx.currentTime);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(.032, ctx.currentTime + .06);

    // A quiet low oscillator adds a motor-like undertone.
    const motor = ctx.createOscillator();
    const motorGain = ctx.createGain();
    motor.type = "sawtooth";
    motor.frequency.setValueAtTime(82, ctx.currentTime);
    motorGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    motorGain.gain.exponentialRampToValueAtTime(.012, ctx.currentTime + .06);

    noise.connect(filter).connect(noiseGain).connect(ctx.destination);
    motor.connect(motorGain).connect(ctx.destination);
    noise.start();
    motor.start();

    // Soft repeating clicks make the sound read as spinning reels rather than
    // a steady background tone. They continue until the last reel stops.
    let tick = 0;
    const tickTimer = window.setInterval(() => {
      if (ctx.state !== "running") return;
      const frequencies = [520, 590, 555, 625];
      toneWithContext(ctx, frequencies[tick % frequencies.length], .038, .016, "square");
      tick += 1;
    }, 105);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(tickTimer);

      const now = ctx.currentTime;
      try {
        noiseGain.gain.cancelScheduledValues(now);
        noiseGain.gain.setValueAtTime(Math.max(.0001, noiseGain.gain.value), now);
        noiseGain.gain.exponentialRampToValueAtTime(.0001, now + .14);
        motorGain.gain.cancelScheduledValues(now);
        motorGain.gain.setValueAtTime(Math.max(.0001, motorGain.gain.value), now);
        motorGain.gain.exponentialRampToValueAtTime(.0001, now + .14);
        noise.stop(now + .16);
        motor.stop(now + .16);
      } catch (_) {}
    };
  }

  function playStopSound(reelIndex) { tone(340 + reelIndex * 55, .09, .06, "square"); }
  function playWinSound() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, .34, .055, "triangle", i * .11));
  }
  function playLoseSound() {
    tone(260, .23, .045, "triangle");
    tone(196, .38, .04, "triangle", .18);
  }

  function updateOddsNote() {
    if (!config.showOdds) {
      oddsNote.textContent = "";
      oddsNote.style.display = "none";
      return;
    }
    if (config.oddsMode === "custom") {
      const n = Math.max(2, Math.floor(Number(config.jackpotOneIn) || 16));
      oddsNote.textContent = `Random jackpot odds: 1 in ${n} per spin`;
    } else {
      const n = config.symbols.length ** 2;
      const pct = (100 / n).toFixed(2).replace(/\.00$/, "");
      oddsNote.textContent = `Natural random odds: 1 in ${n} (${pct}%) per spin`;
    }
  }

  spinButton.addEventListener("click", spin);
  playAgainButton.addEventListener("click", closeResult);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeResult();
  });
  window.addEventListener("resize", () => {
    if (!spinning) currentIndexes.forEach((index, reelIndex) => normalizeReel(reelIndex, index));
  });

  const params = new URLSearchParams(location.search);
  if (params.get("reset") === "1") {
    localStorage.removeItem(STORAGE_WINS);
    localStorage.removeItem(STORAGE_SPINS);
    history.replaceState({}, "", location.pathname);
  }

  async function initializeGame() {
    spinButton.disabled = true;
    spinLabel.textContent = "LOADING";
    statusText.textContent = "Loading values…";

    await preloadImages();
    buildReels();
    updateOddsNote();

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    ready = true;
    spinButton.disabled = false;
    spinLabel.textContent = "PLAY";
    statusText.textContent = "Toca PLAY para jugar";
  }

  initializeGame().catch(() => {
    buildReels();
    updateOddsNote();
    ready = true;
    spinButton.disabled = false;
    spinLabel.textContent = "PLAY";
    statusText.textContent = "Toca PLAY para jugar";
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("service-worker.js?v=1.7.0").catch(() => {});
  }
})();
