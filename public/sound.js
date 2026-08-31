/* ══════════════════════════════════════════════════════════════
   MR. SCHADENFREUDE — GOTHIC AUDIO ENGINE 2.0 (WARM ACOUSTIC MASTER)
   Procedural Web Audio API Soundscape & Acoustic Synthesis
   Zero external audio assets • 100% Procedural • Velvety Gothic Tone
   ══════════════════════════════════════════════════════════════ */

const Sound = (function() {
  let ctx = null;
  let muted = false;
  let masterVolume = 0.80;

  // Master Audio Nodes
  let masterGain = null;
  let masterFilter = null;
  let masterCompressor = null;
  let reverbNode = null;
  let reverbGain = null;
  let dryGain = null;

  // Background Ambience State
  let activeAmbience = null;
  let currentAmbiencePhase = null;
  let ambienceGain = null;

  /**
   * Initializes or returns active Web Audio Context and effects chain
   */
  function getContext() {
    try {
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        ctx = new AudioCtx();
        setupMasterGraph();
      }
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      return ctx;
    } catch (err) {
      return null;
    }
  }

  /**
   * Creates Master Compressor, Warm Lowpass Filter, Reverb Convolver, and Master Routing
   */
  function setupMasterGraph() {
    if (!ctx) return;

    // Master Warm Lowpass (Removes digital harshness >6.5kHz)
    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.setValueAtTime(6200, ctx.currentTime);
    masterFilter.Q.setValueAtTime(0.7, ctx.currentTime);

    // Master Compressor (Prevents clipping, warms polyphony)
    masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.setValueAtTime(-18, ctx.currentTime);
    masterCompressor.knee.setValueAtTime(24, ctx.currentTime);
    masterCompressor.ratio.setValueAtTime(3.5, ctx.currentTime);
    masterCompressor.attack.setValueAtTime(0.006, ctx.currentTime);
    masterCompressor.release.setValueAtTime(0.28, ctx.currentTime);

    // Master Gain
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(muted ? 0 : masterVolume, ctx.currentTime);

    // Procedural Gothic Cathedral Warm Impulse Response
    try {
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = generateWarmCathedralImpulse(ctx, 2.4, 2.6);
      
      const reverbFilter = ctx.createBiquadFilter();
      reverbFilter.type = 'lowpass';
      reverbFilter.frequency.setValueAtTime(2800, ctx.currentTime); // Dark cathedral absorption

      reverbGain = ctx.createGain();
      reverbGain.gain.setValueAtTime(0.28, ctx.currentTime); // 28% warm reverb

      dryGain = ctx.createGain();
      dryGain.gain.setValueAtTime(0.92, ctx.currentTime);

      // Routing: Reverb -> Reverb Filter -> Reverb Gain -> Compressor
      reverbNode.connect(reverbFilter);
      reverbFilter.connect(reverbGain);
      reverbGain.connect(masterCompressor);
      dryGain.connect(masterCompressor);
    } catch (e) {
      dryGain = ctx.createGain();
      dryGain.gain.setValueAtTime(1.0, ctx.currentTime);
      dryGain.connect(masterCompressor);
    }

    // Ambience Sub-bus (soft and soothing)
    ambienceGain = ctx.createGain();
    ambienceGain.gain.setValueAtTime(0.14, ctx.currentTime);
    ambienceGain.connect(masterCompressor);

    // Final chain: Compressor -> Master Filter -> Master Gain -> Destination
    masterCompressor.connect(masterFilter);
    masterFilter.connect(masterGain);
    masterGain.connect(ctx.destination);
  }

  /**
   * Synthesizes a velvety, warm acoustic cathedral impulse response
   * High frequencies decay quickly (air & stone absorption) to prevent harsh metallic ringing
   */
  function generateWarmCathedralImpulse(audioCtx, duration, decay) {
    const sampleRate = audioCtx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    let lastL = 0;
    let lastR = 0;
    const filterAlpha = 0.18; // Warm 1-pole lowpass filter on noise (~1.8kHz cutoff)

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * decay);
      const rawL = (Math.random() * 2 - 1) * envelope;
      const rawR = (Math.random() * 2 - 1) * envelope;

      lastL = lastL + filterAlpha * (rawL - lastL);
      lastR = lastR + filterAlpha * (rawR - lastR);

      left[i] = lastL;
      right[i] = lastR;
    }
    return impulse;
  }

  /**
   * Connects any audio source safely to dry bus and warm reverb send
   */
  function connectToBus(node, wetSend = 0.35) {
    const c = getContext();
    if (!c) return;
    if (dryGain) node.connect(dryGain);
    if (reverbNode && wetSend > 0) {
      const send = c.createGain();
      send.gain.setValueAtTime(wetSend, c.currentTime);
      node.connect(send);
      send.connect(reverbNode);
    }
  }

  // Auto-resume AudioContext on first user interaction
  try {
    const unlock = () => {
      getContext();
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('click', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
  } catch (e) {}

  function isMuted() {
    return muted;
  }

  function toggleMute() {
    muted = !muted;
    const c = getContext();
    if (masterGain && c) {
      masterGain.gain.cancelScheduledValues(c.currentTime);
      masterGain.gain.setValueAtTime(masterGain.gain.value, c.currentTime);
      masterGain.gain.linearRampToValueAtTime(muted ? 0 : masterVolume, c.currentTime + 0.05);
    }

    const btn = document.getElementById('btn-sound-toggle');
    const icon = document.getElementById('sound-icon');
    const topbarIcon = document.getElementById('topbar-sound-icon');
    const label = document.getElementById('sound-label');
    if (icon) icon.textContent = muted ? '🔇' : '🔊';
    if (topbarIcon) topbarIcon.textContent = muted ? '🔇' : '🔊';
    if (label) {
      const isTr = typeof I18N !== 'undefined' ? I18N.getLanguage() === 'tr' : true;
      label.textContent = muted ? (isTr ? 'Ses Kapalı' : 'Muted') : (isTr ? 'Ses Açık' : 'Sound On');
    }
    if (btn) {
      btn.title = muted ? 'Sesi Aç' : 'Sesi Kapat';
      btn.classList.toggle('muted', muted);
    }
    if (!muted) playClick();
    return muted;
  }

  function setVolume(val) {
    masterVolume = Math.max(0, Math.min(1, val));
    if (!muted && masterGain && ctx) {
      masterGain.gain.linearRampToValueAtTime(masterVolume, ctx.currentTime + 0.05);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // PROCEDURAL PHASE AMBIENCE GENERATOR
  // ══════════════════════════════════════════════════════════════

  function stopAmbience() {
    if (activeAmbience) {
      try {
        const c = getContext();
        if (c && activeAmbience.gainNode) {
          activeAmbience.gainNode.gain.linearRampToValueAtTime(0.0001, c.currentTime + 1.2);
        }
        setTimeout(() => {
          if (activeAmbience) {
            activeAmbience.nodes.forEach(n => { try { n.stop(); n.disconnect(); } catch (e) {} });
            activeAmbience = null;
          }
        }, 1300);
      } catch (e) {
        activeAmbience = null;
      }
    }
    currentAmbiencePhase = null;
  }

  function setAmbience(phase) {
    if (currentAmbiencePhase === phase) return;
    currentAmbiencePhase = phase;
    stopAmbience();

    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const nodes = [];
    const localGain = c.createGain();
    localGain.gain.setValueAtTime(0.0001, t);
    localGain.gain.linearRampToValueAtTime(0.18, t + 2.0); // Soft fade-in
    localGain.connect(ambienceGain || masterCompressor);

    if (phase === 'night' || phase === 'night0') {
      // Warm Sub drone
      const droneOsc = c.createOscillator();
      droneOsc.type = 'sine';
      droneOsc.frequency.setValueAtTime(55, t);
      
      const droneGain = c.createGain();
      droneGain.gain.setValueAtTime(0.28, t);
      droneOsc.connect(droneGain);
      droneGain.connect(localGain);
      droneOsc.start(t);
      nodes.push(droneOsc);

      // Low filtered wind (warm, no high hiss)
      const bufferSize = c.sampleRate * 2;
      const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.992 * b0 + white * 0.06;
        b1 = 0.985 * b1 + white * 0.08;
        output[i] = (b0 + b1) * 0.2;
      }

      const noiseSource = c.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      const windFilter = c.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.setValueAtTime(320, t); // Strictly low soothing frequencies

      noiseSource.connect(windFilter);
      windFilter.connect(localGain);
      noiseSource.start(t);
      nodes.push(noiseSource);

    } else if (phase === 'vote') {
      // Trial Ambience: Low tension pulse (warm 65Hz C2)
      const tensionOsc = c.createOscillator();
      tensionOsc.type = 'sine';
      tensionOsc.frequency.setValueAtTime(65.41, t);

      const tensionGain = c.createGain();
      tensionGain.gain.setValueAtTime(0.22, t);

      tensionOsc.connect(tensionGain);
      tensionGain.connect(localGain);
      tensionOsc.start(t);
      nodes.push(tensionOsc);

    } else if (phase === 'day' || phase === 'dawn') {
      // Day Ambience: Serene warm C3 drone
      const dayOsc = c.createOscillator();
      dayOsc.type = 'sine';
      dayOsc.frequency.setValueAtTime(130.81, t);

      const dayGain = c.createGain();
      dayGain.gain.setValueAtTime(0.12, t);
      dayOsc.connect(dayGain);
      dayGain.connect(localGain);
      dayOsc.start(t);
      nodes.push(dayOsc);
    }

    activeAmbience = { nodes, gainNode: localGain };
  }

  // ══════════════════════════════════════════════════════════════
  // PROCEDURAL SOUND EFFECTS (WARM & PLEASANT FREQUENCIES)
  // ══════════════════════════════════════════════════════════════

  /**
   * 1. Gotik Kilise Gece Çanı (Warm Cathedral Bell)
   * Warm sine partials (no piercing high overtones)
   */
  function playNightBell() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const baseFreq = 146.83; // D3 Fundamental
    const partials = [
      { ratio: 0.50, gain: 0.50, decay: 3.8 },  // Hum tone
      { ratio: 1.00, gain: 0.42, decay: 3.4 },  // Prime / Strike
      { ratio: 1.19, gain: 0.28, decay: 2.8 },  // Tierce (Minor 3rd)
      { ratio: 1.50, gain: 0.20, decay: 2.4 },  // Quint (Fifth)
      { ratio: 2.00, gain: 0.12, decay: 1.8 },  // Nominal
    ];

    partials.forEach(({ ratio, gain, decay }) => {
      const osc = c.createOscillator();
      const g = c.createGain();

      osc.type = 'sine'; // Pure warm sine wave
      osc.frequency.setValueAtTime(baseFreq * ratio, t);

      g.gain.setValueAtTime(gain * 0.4, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      osc.connect(g);
      connectToBus(g, 0.45);

      osc.start(t);
      osc.stop(t + decay + 0.1);
    });
  }

  /**
   * 2. Şafak Korosu (Soothing Gregorian Dawn Chords)
   */
  function playDawn() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Warm soothing D Major triad: D4, F#4, A4, D5
    const notes = [293.66, 369.99, 440.00, 587.33];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.12;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.11, t + delay + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 2.2);

      osc.connect(gain);
      connectToBus(gain, 0.5);

      osc.start(t + delay);
      osc.stop(t + delay + 2.3);
    });
  }

  /**
   * 3. Mahkeme Tokmağı (Deep Mahogany Gavel Thud)
   * Deep acoustic wood resonance (no harsh click)
   */
  function playGavel() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const strike = (time, intensity = 1.0) => {
      const bodyOsc = c.createOscillator();
      const bodyGain = c.createGain();
      const filter = c.createBiquadFilter();

      bodyOsc.type = 'triangle';
      bodyOsc.frequency.setValueAtTime(110, time);
      bodyOsc.frequency.exponentialRampToValueAtTime(36, time + 0.22);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(380, time);

      bodyGain.gain.setValueAtTime(0.55 * intensity, time);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);

      bodyOsc.connect(filter);
      filter.connect(bodyGain);
      connectToBus(bodyGain, 0.4);

      bodyOsc.start(time);
      bodyOsc.stop(time + 0.3);
    };

    const t = c.currentTime;
    strike(t, 1.0);
    setTimeout(() => {
      if (muted || !ctx) return;
      strike(ctx.currentTime, 0.45);
    }, 180);
  }

  /**
   * 4. İnfaz / Ölüm Darbesi (Warm Visceral Thud & Dark Blade Sweep)
   * No high noise screech (lowered from 3.6kHz to soft 800Hz)
   */
  function playKill() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;

    // Layer 1: Soft steel sweep (warm bandpass, gentle Q)
    const bufferSize = Math.floor(c.sampleRate * 0.15);
    const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(850, t);
    filter.frequency.exponentialRampToValueAtTime(220, t + 0.14);
    filter.Q.setValueAtTime(1.2, t); // Gentle, smooth Q

    const noiseGain = c.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

    noise.connect(filter);
    filter.connect(noiseGain);
    connectToBus(noiseGain, 0.35);
    noise.start(t);

    // Layer 2: Deep visceral gut thud (warm sine)
    const subOsc = c.createOscillator();
    const subGain = c.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(180, t);
    subOsc.frequency.exponentialRampToValueAtTime(36, t + 0.38);

    subGain.gain.setValueAtTime(0.48, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

    subOsc.connect(subGain);
    connectToBus(subGain, 0.5);

    subOsc.start(t);
    subOsc.stop(t + 0.48);
  }

  /**
   * 5. Gölge Fısıltısı (Smooth Spectral Whisper)
   */
  function playWhisper() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [280, 380, 480];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.linearRampToValueAtTime(freq + (idx % 2 === 0 ? 30 : -25), t + 0.5);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);

      osc.connect(gain);
      connectToBus(gain, 0.5);

      osc.start(t);
      osc.stop(t + 0.8);
    });
  }

  /**
   * 6. Rahibe Tarot Kartı (Velvety Crystal Raindrop Chimes)
   * Warm pentatonic scale with lowpass filtering (no piercing highs)
   */
  function playTarot() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Warm comforting pentatonic chimes: D5, E5, G5, A5, C6
    const freqs = [587.33, 659.25, 783.99, 880.00, 1046.50];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const filter = c.createBiquadFilter();
      const delay = idx * 0.07;

      osc.type = 'sine'; // Pure warm sine
      osc.frequency.setValueAtTime(freq, t + delay);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2200, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.12, t + delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.9);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.6);

      osc.start(t + delay);
      osc.stop(t + delay + 0.95);
    });
  }

  /**
   * 7. Mortisyen Otopsi / İpucu (Warm Music Box Motif)
   */
  function playClue() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [440.00, 554.37, 659.25, 880.00]; // A4, C#5, E5, A5

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.09;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.12, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.75);

      osc.connect(gain);
      connectToBus(gain, 0.45);

      osc.start(t + delay);
      osc.stop(t + delay + 0.8);
    });
  }

  /**
   * 8. Şövalye Kılıç Meydan Okuması (Warm Steel Clink)
   * Smooth metallic ring (removed 2.4kHz screeching sawtooth)
   */
  function playSword() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [580, 840];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const filter = c.createBiquadFilter();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.4, t + 0.22);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400, t);

      gain.gain.setValueAtTime(0.14 / (idx + 1), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.35);

      osc.start(t);
      osc.stop(t + 0.3);
    });
  }

  /**
   * 9. Şövalye Kalkan Koruma Sesi (Deep Holy Shield Gong)
   */
  function playShield() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const notes = [98.00, 196.00, 246.94, 293.66]; // G2, G3, B3, D4

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.16 / (idx + 1), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);

      osc.connect(gain);
      connectToBus(gain, 0.5);

      osc.start(t);
      osc.stop(t + 1.3);
    });
  }

  /**
   * 10. Deli Laneti (Low Ominous Curse Drone)
   * Deep and moody (no harsh high buzzing)
   */
  function playCurse() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [155.56, 220.00, 233.08]; // Low tritone cluster

    freqs.forEach(freq => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const filter = c.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(320, t);

      gain.gain.setValueAtTime(0.16, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.6);

      osc.start(t);
      osc.stop(t + 1.5);
    });
  }

  /**
   * 11. Mahkeme Oyu / Mühürleme (Soft Wax Seal Tap)
   */
  function playVote() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);

    gain.gain.setValueAtTime(0.24, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

    osc.connect(gain);
    connectToBus(gain, 0.25);

    osc.start(t);
    osc.stop(t + 0.16);
  }

  /**
   * 12. Geri Sayım Saat Çarkı (Warm Wooden Metronome Tick)
   * Lowered from harsh 1.2kHz to gentle 320Hz/420Hz wood tick
   */
  function playTick(urgent = false) {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(urgent ? 420 : 310, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.03);

    gain.gain.setValueAtTime(urgent ? 0.18 : 0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);

    osc.connect(gain);
    connectToBus(gain, 0.1);

    osc.start(t);
    osc.stop(t + 0.04);
  }

  /**
   * 13. Buton & Arayüz Dokunuşu (Subtle Soft Click)
   */
  function playClick() {
    try {
      if (muted) return;
      const c = getContext();
      if (!c) return;

      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.035);

      gain.gain.setValueAtTime(0.09, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

      osc.connect(gain);
      connectToBus(gain, 0.08);

      osc.start(t);
      osc.stop(t + 0.045);
    } catch (e) {}
  }

  /**
   * 14. Zafer: Mr. Schadenfreude (Warm Gothic Pipe Organ)
   */
  function playSFWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    stopAmbience();
    const t = c.currentTime;
    // Warm C Minor progression: C2, G2, Eb3, Bb3
    const notes = [65.41, 98.00, 155.56, 233.08];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const filter = c.createBiquadFilter();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.14 / (idx + 1), t + 0.18);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.6);

      osc.start(t);
      osc.stop(t + 3.8);
    });
  }

  /**
   * 15. Zafer: Köylüler Kazandı (Warm Triumphant Fanfare)
   */
  function playVillagersWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    stopAmbience();
    const t = c.currentTime;
    // Warm D Major Fanfare: D3, A3, D4, F#4, A4
    const notes = [146.83, 220.00, 293.66, 369.99, 440.00];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.11;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.12 / (idx + 1), t + delay + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 3.0);

      osc.connect(gain);
      connectToBus(gain, 0.6);

      osc.start(t + delay);
      osc.stop(t + delay + 3.2);
    });
  }

  return {
    isMuted,
    toggleMute,
    setVolume,
    setAmbience,
    stopAmbience,
    playNightBell,
    playDawn,
    playGavel,
    playKill,
    playWhisper,
    playTarot,
    playClue,
    playSword,
    playShield,
    playCurse,
    playVote,
    playTick,
    playClick,
    playSFWin,
    playVillagersWin,
  };
})();
