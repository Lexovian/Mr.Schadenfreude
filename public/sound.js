/* ══════════════════════════════════════════════════════════════
   MR. SCHADENFREUDE — GOTHIC AUDIO ENGINE 2.0
   Procedural Web Audio API Soundscape & Acoustic Synthesis
   Zero external audio assets • 100% Procedural • Gothic Ambience
   ══════════════════════════════════════════════════════════════ */

const Sound = (function() {
  let ctx = null;
  let muted = false;
  let masterVolume = 0.85;

  // Master Audio Nodes
  let masterGain = null;
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
   * Creates Master Compressor, Gothic Reverb Convolver, and Master Gain Routing
   */
  function setupMasterGraph() {
    if (!ctx) return;

    // Master Compressor (Prevents digital clipping, glues polyphony)
    masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.setValueAtTime(-18, ctx.currentTime);
    masterCompressor.knee.setValueAtTime(24, ctx.currentTime);
    masterCompressor.ratio.setValueAtTime(4, ctx.currentTime);
    masterCompressor.attack.setValueAtTime(0.004, ctx.currentTime);
    masterCompressor.release.setValueAtTime(0.25, ctx.currentTime);

    // Master Gain
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(muted ? 0 : masterVolume, ctx.currentTime);

    // Procedural Gothic Cathedral Impulse Response for Convolver
    try {
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = generateCathedralImpulseResponse(ctx, 2.6, 2.2);
      
      reverbGain = ctx.createGain();
      reverbGain.gain.setValueAtTime(0.35, ctx.currentTime); // 35% wet reverb

      dryGain = ctx.createGain();
      dryGain.gain.setValueAtTime(0.9, ctx.currentTime);

      // Routing: Dry & Reverb -> Compressor -> Master Gain -> Destination
      reverbNode.connect(reverbGain);
      reverbGain.connect(masterCompressor);
      dryGain.connect(masterCompressor);
    } catch (e) {
      // Fallback direct routing if Convolver fails
      dryGain = ctx.createGain();
      dryGain.gain.setValueAtTime(1.0, ctx.currentTime);
      dryGain.connect(masterCompressor);
    }

    // Ambience Sub-bus
    ambienceGain = ctx.createGain();
    ambienceGain.gain.setValueAtTime(0.18, ctx.currentTime);
    ambienceGain.connect(masterCompressor);

    masterCompressor.connect(masterGain);
    masterGain.connect(ctx.destination);
  }

  /**
   * Synthesizes a lush, dark Gothic Cathedral Impulse Response
   */
  function generateCathedralImpulseResponse(audioCtx, duration, decay) {
    const sampleRate = audioCtx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      // Exponential decay envelope with subtle early reflection clusters
      const envelope = Math.exp(-t * decay);
      const earlyEcho = (i % 2400 < 80) ? 1.3 : 1.0;
      left[i] = (Math.random() * 2 - 1) * envelope * earlyEcho;
      right[i] = (Math.random() * 2 - 1) * envelope * earlyEcho;
    }
    return impulse;
  }

  /**
   * Helper to connect a sound source to the master effects bus (both dry and wet reverb)
   */
  function connectToBus(node, wetSend = 0.5) {
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
    localGain.gain.linearRampToValueAtTime(0.22, t + 2.0); // Smooth fade in
    localGain.connect(ambienceGain || masterCompressor);

    if (phase === 'night' || phase === 'night0') {
      // Night Ambience: Whispering cold wind + deep subterranean drone
      // 1) Sub drone
      const droneOsc = c.createOscillator();
      droneOsc.type = 'sine';
      droneOsc.frequency.setValueAtTime(55, t); // Low A1 drone
      
      const droneGain = c.createGain();
      droneGain.gain.setValueAtTime(0.35, t);
      droneOsc.connect(droneGain);
      droneGain.connect(localGain);
      droneOsc.start(t);
      nodes.push(droneOsc);

      // 2) Filtered pink noise wind sweep
      const bufferSize = c.sampleRate * 2;
      const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        output[i] = (b0 + b1 + b2) * 0.25;
      }

      const noiseSource = c.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      const windFilter = c.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.setValueAtTime(260, t);
      windFilter.Q.setValueAtTime(3.0, t);

      // Slow wind modulation
      const windLFO = c.createOscillator();
      windLFO.frequency.setValueAtTime(0.15, t); // 0.15 Hz slow breathing wind
      const lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(140, t);
      windLFO.connect(lfoGain);
      lfoGain.connect(windFilter.frequency);

      noiseSource.connect(windFilter);
      windFilter.connect(localGain);
      noiseSource.start(t);
      windLFO.start(t);
      nodes.push(noiseSource, windLFO);

    } else if (phase === 'vote') {
      // Trial Ambience: Tense suspense drone + subtle low heartbeat pulse
      const tensionOsc = c.createOscillator();
      tensionOsc.type = 'sawtooth';
      tensionOsc.frequency.setValueAtTime(65.41, t); // C2

      const tensionFilter = c.createBiquadFilter();
      tensionFilter.type = 'lowpass';
      tensionFilter.frequency.setValueAtTime(180, t);

      const tensionGain = c.createGain();
      tensionGain.gain.setValueAtTime(0.28, t);

      tensionOsc.connect(tensionFilter);
      tensionFilter.connect(tensionGain);
      tensionGain.connect(localGain);
      tensionOsc.start(t);
      nodes.push(tensionOsc);

    } else if (phase === 'day' || phase === 'dawn') {
      // Day Ambience: Serene village daylight harmonics
      const dayOsc = c.createOscillator();
      dayOsc.type = 'sine';
      dayOsc.frequency.setValueAtTime(130.81, t); // C3 warm drone

      const dayGain = c.createGain();
      dayGain.gain.setValueAtTime(0.15, t);
      dayOsc.connect(dayGain);
      dayGain.connect(localGain);
      dayOsc.start(t);
      nodes.push(dayOsc);
    }

    activeAmbience = { nodes, gainNode: localGain };
  }

  // ══════════════════════════════════════════════════════════════
  // PROCEDURAL SOUND EFFECTS
  // ══════════════════════════════════════════════════════════════

  /**
   * 1. Gotik Kilise Gece Çanı (Acoustically accurate Cathedral Bell)
   * Uses real bell harmonic partial ratios: Hum, Prime, Tierce, Quint, Nominal
   */
  function playNightBell() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const baseFreq = 130.81; // C3 Fundamental
    // Cathedral Bell partial ratios & relative amplitudes
    const partials = [
      { ratio: 0.50, gain: 0.55, decay: 4.2 },  // Hum tone
      { ratio: 1.00, gain: 0.45, decay: 3.8 },  // Prime / Strike note
      { ratio: 1.19, gain: 0.35, decay: 3.2 },  // Tierce (Minor 3rd - gothic character)
      { ratio: 1.50, gain: 0.28, decay: 2.8 },  // Quint (Fifth)
      { ratio: 2.00, gain: 0.22, decay: 2.2 },  // Nominal (Octave)
      { ratio: 2.76, gain: 0.14, decay: 1.6 },  // Supernominal
      { ratio: 4.07, gain: 0.08, decay: 1.2 },  // High metallic shimmer
    ];

    partials.forEach(({ ratio, gain, decay }) => {
      // Dual detuned oscillators for realistic acoustic metallic chorus/beating
      [-0.4, 0.4].forEach(detune => {
        const osc = c.createOscillator();
        const g = c.createGain();

        osc.type = ratio > 2.0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(baseFreq * ratio + detune, t);

        // Bell strike transient: instantaneous attack, long natural exponential ringdown
        g.gain.setValueAtTime(gain * 0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

        osc.connect(g);
        connectToBus(g, 0.85); // High cathedral reverb send

        osc.start(t);
        osc.stop(t + decay + 0.1);
      });
    });
  }

  /**
   * 2. Şafak Korosu (Celestial Gregorian Dawn Chords)
   */
  function playDawn() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Ethereal ascending D Major 9th chord: D4, F#4, A4, C#5, E5
    const notes = [293.66, 369.99, 440.00, 554.37, 659.25];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.14;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      // Subtle vocal LFO vibrato
      const lfo = c.createOscillator();
      lfo.frequency.setValueAtTime(4.8, t + delay);
      const lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(2.2, t + delay);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.16, t + delay + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 2.4);

      osc.connect(gain);
      connectToBus(gain, 0.7);

      lfo.start(t + delay);
      osc.start(t + delay);
      lfo.stop(t + delay + 2.5);
      osc.stop(t + delay + 2.5);
    });
  }

  /**
   * 3. Mahkeme Tokmağı (Heavy Mahogany Court Gavel)
   * Deep acoustic wood body resonance with secondary echo strike
   */
  function playGavel() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const strike = (time, intensity = 1.0) => {
      // 1. High transient wood impact click
      const clickOsc = c.createOscillator();
      const clickGain = c.createGain();
      clickOsc.type = 'triangle';
      clickOsc.frequency.setValueAtTime(420, time);
      clickOsc.frequency.exponentialRampToValueAtTime(80, time + 0.04);
      clickGain.gain.setValueAtTime(0.6 * intensity, time);
      clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
      clickOsc.connect(clickGain);
      connectToBus(clickGain, 0.4);
      clickOsc.start(time);
      clickOsc.stop(time + 0.07);

      // 2. Heavy mahogany body resonance & sub thump
      const bodyOsc = c.createOscillator();
      const bodyGain = c.createGain();
      bodyOsc.type = 'sine';
      bodyOsc.frequency.setValueAtTime(130, time);
      bodyOsc.frequency.exponentialRampToValueAtTime(42, time + 0.28);
      bodyGain.gain.setValueAtTime(0.75 * intensity, time);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
      bodyOsc.connect(bodyGain);
      connectToBus(bodyGain, 0.6);
      bodyOsc.start(time);
      bodyOsc.stop(time + 0.38);
    };

    const t = c.currentTime;
    strike(t, 1.0);
    setTimeout(() => {
      if (muted || !ctx) return;
      strike(ctx.currentTime, 0.55); // Resonant second strike
    }, 210);
  }

  /**
   * 4. İnfaz / Bıçak ve Ölüm Darbesi (Execution / Steel Blade & Visceral Impact)
   */
  function playKill() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;

    // Layer 1: Razor-sharp metallic blade slice (high swept bandpass noise)
    const bufferSize = Math.floor(c.sampleRate * 0.18);
    const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3600, t);
    filter.frequency.exponentialRampToValueAtTime(650, t + 0.16);
    filter.Q.setValueAtTime(4.0, t);

    const noiseGain = c.createGain();
    noiseGain.gain.setValueAtTime(0.4, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.17);

    noise.connect(filter);
    filter.connect(noiseGain);
    connectToBus(noiseGain, 0.5);
    noise.start(t);

    // Layer 2: Deep visceral gut impact
    const subOsc = c.createOscillator();
    const subGain = c.createGain();
    subOsc.type = 'sawtooth';
    subOsc.frequency.setValueAtTime(320, t);
    subOsc.frequency.exponentialRampToValueAtTime(38, t + 0.45);

    const lowpass = c.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(450, t);
    lowpass.frequency.exponentialRampToValueAtTime(90, t + 0.45);

    subGain.gain.setValueAtTime(0.55, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);

    subOsc.connect(lowpass);
    lowpass.connect(subGain);
    connectToBus(subGain, 0.7);

    subOsc.start(t);
    subOsc.stop(t + 0.58);
  }

  /**
   * 5. Gölge Fısıltısı (Spectral Shadow Whisper)
   */
  function playWhisper() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Formant whispered frequencies with stereo panning
    const freqs = [380, 520, 740];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.linearRampToValueAtTime(freq + (idx % 2 === 0 ? 45 : -35), t + 0.6);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

      osc.connect(gain);
      connectToBus(gain, 0.8);

      osc.start(t);
      osc.stop(t + 0.9);
    });
  }

  /**
   * 6. Rahibe Tarot Kartı & Manevi Sezgi (Mystic Tarot Shimmer)
   */
  function playTarot() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Celestial pentatonic crystal chime arpeggio: F#5, A#5, C#6, D#6, F#6
    const freqs = [739.99, 932.33, 1108.73, 1244.51, 1479.98];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.07;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.15, t + delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.2);

      osc.connect(gain);
      connectToBus(gain, 0.9);

      osc.start(t + delay);
      osc.stop(t + delay + 1.25);
    });
  }

  /**
   * 7. Mortisyen Otopsi / İpucu Keşfi (Forensic Music Box Chime)
   */
  function playClue() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Antique music-box motif: D5, F#5, A5, D6
    const freqs = [587.33, 739.99, 880.00, 1174.66];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.09;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.18, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.9);

      osc.connect(gain);
      connectToBus(gain, 0.6);

      osc.start(t + delay);
      osc.stop(t + delay + 0.95);
    });
  }

  /**
   * 8. Şövalye Kılıç Meydan Okuması (Knight's Steel Blade Clash)
   */
  function playSword() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [1250, 1780, 2400];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.35, t + 0.28);

      gain.gain.setValueAtTime(0.18 / (idx + 1), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);

      osc.connect(gain);
      connectToBus(gain, 0.45);

      osc.start(t);
      osc.stop(t + 0.42);
    });
  }

  /**
   * 9. Şövalye Kalkan Koruma Sesi (Holy Aegis Shield Gong)
   */
  function playShield() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Divine resonant barrier: A2 fundamental with major harmonics
    const notes = [110.00, 220.00, 277.18, 329.63, 440.00];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = idx === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.22 / (idx + 1), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

      osc.connect(gain);
      connectToBus(gain, 0.75);

      osc.start(t);
      osc.stop(t + 1.7);
    });
  }

  /**
   * 10. Deli Laneti (Madman's Eerie Curse Dissonance)
   */
  function playCurse() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    // Tritone cluster (The Devil's Interval): Bb3, E4, Bb4
    const freqs = [233.08, 329.63, 466.16];

    freqs.forEach(freq => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      // Pitch wobble modulation
      const lfo = c.createOscillator();
      lfo.frequency.setValueAtTime(7.5, t);
      const lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(8.0, t);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, t);
      filter.frequency.exponentialRampToValueAtTime(120, t + 1.8);

      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.85);

      lfo.start(t);
      osc.start(t);
      lfo.stop(t + 2.1);
      osc.stop(t + 2.1);
    });
  }

  /**
   * 11. Mahkeme Oyu / Mühürleme (Wax Seal Stamp / Ballot Cast)
   */
  function playVote() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.14);

    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    osc.connect(gain);
    connectToBus(gain, 0.35);

    osc.start(t);
    osc.stop(t + 0.2);
  }

  /**
   * 12. Geri Sayım & Çark Tıkırtısı (Clockwork Metronome / Tension Tick)
   */
  function playTick(urgent = false) {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = urgent ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(urgent ? 1200 : 780, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.035);

    gain.gain.setValueAtTime(urgent ? 0.25 : 0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    osc.connect(gain);
    connectToBus(gain, 0.2);

    osc.start(t);
    osc.stop(t + 0.05);
  }

  /**
   * 13. Buton & Arayüz Dokunuşu (Refined Tactile Click)
   */
  function playClick() {
    try {
      if (muted) return;
      const c = getContext();
      if (!c) return;

      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.04);

      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

      osc.connect(gain);
      connectToBus(gain, 0.1);

      osc.start(t);
      osc.stop(t + 0.05);
    } catch (e) {}
  }

  /**
   * 14. Zafer: Mr. Schadenfreude Kazandı (Dark Pipe Organ Requiem)
   */
  function playSFWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    stopAmbience();
    const t = c.currentTime;
    // C Minor 9th Pipe Organ Chord Progression: C2, G2, Eb3, Bb3, D4
    const notes = [65.41, 98.00, 155.56, 233.08, 293.66];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = idx <= 1 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(650, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.18 / (idx + 1), t + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);

      osc.connect(filter);
      filter.connect(gain);
      connectToBus(gain, 0.9);

      osc.start(t);
      osc.stop(t + 4.3);
    });
  }

  /**
   * 15. Zafer: Köylüler Kazandı (Triumphant Golden Cathedral Fanfare)
   */
  function playVillagersWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    stopAmbience();
    const t = c.currentTime;
    // D Major Fanfare: D3, A3, D4, F#4, A4, D5
    const notes = [146.83, 220.00, 293.66, 369.99, 440.00, 587.33];

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.11;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.16 / (idx + 1), t + delay + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 3.6);

      osc.connect(gain);
      connectToBus(gain, 0.85);

      osc.start(t + delay);
      osc.stop(t + delay + 3.7);
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
