/* ══════════════════════════════════════════════
   MR. SCHADENFREUDE — PROCEDURAL AUDIO ENGINE
   Web Audio API ile üretilmiş gotik ses efektleri
══════════════════════════════════════════════ */

const Sound = (function() {
  let ctx = null;
  let muted = false;

  function getContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        ctx = new AudioCtx();
      }
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // Kullanıcı ilk etkileşiminde AudioContext'i uyandır
  window.addEventListener('click', () => getContext(), { once: true });
  window.addEventListener('keydown', () => getContext(), { once: true });

  function isMuted() {
    return muted;
  }

  function toggleMute() {
    muted = !muted;
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

  // ─── SES EFEKTLERİ ───

  /** 1. Gotik Kilise Gece Çanı (Night Bell) */
  function playNightBell() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [110, 220, 330, 440, 587];
    const gains = [0.4, 0.3, 0.15, 0.08, 0.04];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      
      osc.type = idx === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      // Hafif gotik titreşim
      osc.frequency.exponentialRampToValueAtTime(freq * 0.99, t + 3.0);

      gain.gain.setValueAtTime(gains[idx], t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(t);
      osc.stop(t + 3.6);
    });
  }

  /** 2. Şafak ve Aydınlık Akoru (Dawn Chime) */
  function playDawn() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25]; // C - E - G - C

    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = i * 0.12;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.linearRampToValueAtTime(0.18, t + delay + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.8);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(t + delay);
      osc.stop(t + delay + 1.9);
    });
  }

  /** 3. Mahkeme Tokmağı / Oylama Başlangıcı (Gavel Strike) */
  function playGavel() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;

    // Tok darbe
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.25);

    gain.gain.setValueAtTime(0.6, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.45);

    // İkinci yankılı tokmak vuruşu
    setTimeout(() => {
      if (muted || !ctx) return;
      const t2 = ctx.currentTime;
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(130, t2);
      osc2.frequency.exponentialRampToValueAtTime(40, t2 + 0.25);
      gain2.gain.setValueAtTime(0.4, t2);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.35);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(t2);
      osc2.stop(t2 + 0.4);
    }, 220);
  }

  /** 4. İnfaz / Ölüm / Bıçak Efekti (Kill / Death) */
  function playKill() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;

    // Koyu metalik kesik / darbe
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.3);

    // Düşük frekans filtresi
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, t);
    filter.frequency.exponentialRampToValueAtTime(150, t + 0.4);

    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);

    osc.start(t);
    osc.stop(t + 0.55);
  }

  /** 5. Gölge Fısıltısı (Shadow Whisper) */
  function playWhisper() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [350, 480, 520];

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.linearRampToValueAtTime(freq + 40, t + 0.4);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(t);
      osc.stop(t + 0.85);
    });
  }

  /** 6. Mortisyen İpucu Sesi (Clue Discovered) */
  function playClue() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const freqs = [587.33, 739.99, 880.00]; // D5, F#5, A5

    freqs.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.08;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.12, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.7);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(t + delay);
      osc.stop(t + delay + 0.75);
    });
  }

  /** 7. Şövalye Kılıç / Mücadele Sesi (Sword Challenge) */
  function playSword() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(250, t + 0.25);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(t);
    osc.stop(t + 0.35);
  }

  /** 8. Şövalye Kalkan Koruma Sesi (Shield Protect) */
  function playShield() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.15);

    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(t);
    osc.stop(t + 0.55);
  }

  /** 9. Buton & Seçim Tıkırtısı (Click) */
  function playClick() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.05);

    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(t);
    osc.stop(t + 0.07);
  }

  /** 10. Zafer: Mr. Schadenfreude Kazandı (Dark Victory) */
  function playSFWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const notes = [130.81, 155.56, 196.00, 233.08]; // C - Eb - G - Bb (C Minor 7)

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, t);

      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 2.5);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(c.destination);

      osc.start(t);
      osc.stop(t + 2.6);
    });
  }

  /** 11. Zafer: Köylüler Kazandı (Villagers Win) */
  function playVillagersWin() {
    if (muted) return;
    const c = getContext();
    if (!c) return;

    const t = c.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25, 659.25]; // C - E - G - C - E

    notes.forEach((freq, idx) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const delay = idx * 0.1;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);

      gain.gain.setValueAtTime(0.14, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 2.0);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(t + delay);
      osc.stop(t + delay + 2.1);
    });
  }

  return {
    isMuted,
    toggleMute,
    playNightBell,
    playDawn,
    playGavel,
    playKill,
    playWhisper,
    playClue,
    playSword,
    playShield,
    playClick,
    playSFWin,
    playVillagersWin,
  };
})();
