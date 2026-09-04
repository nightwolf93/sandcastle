/**
 * Audio entierement procedural (Web Audio, aucun fichier a charger).
 *
 * Le son est le premier levier de credibilite d'un jeu de sable : c'est lui
 * qui dit au joueur, sans aucune jauge, dans quel etat est la matiere.
 *   - sable SEC   : sifflement clair et granuleux, aigu, qui traine ;
 *   - sable HUMIDE: bruit sourd et bref, mediums, avec un "poc" mat ;
 *   - sable TREMPE: "flop" grave et court, presque liquide.
 *
 * On module donc systematiquement la frequence de coupure du filtre et la
 * duree de l'enveloppe par l'humidite mesuree sous l'outil.
 *
 * L'ambiance (ressac, vent, mouettes) est elle aussi synthetisee : deux
 * sources de bruit filtre dont le gain suit le va-et-vient du ressac de la
 * simulation, ce qui synchronise vraiment le son avec l'image.
 */

const NOISE_SECONDS = 2.5;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.75;
    this.ready = false;
    this.lastPlay = Object.create(null);
    this.noiseBuffer = null;
    this.ambient = null;
  }

  /** Le navigateur exige un geste utilisateur avant de demarrer l'audio. */
  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.ready = this.ctx.state === 'running';
    return this.ready;
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Limiteur de sortie : quoi qu'il arrive en amont (tempete, seau et
    // effondrement dans la meme seconde), la sortie ne sature jamais. Un
    // bruit filtre qui ecrete est ce qu'il y a de plus laid a entendre.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    this.limiter = limiter;
    this.master.connect(limiter).connect(this.ctx.destination);

    // Bruit blanc pre-calcule, reutilise par tous les effets.
    const n = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      // Un peu de bruit brownien melange : plus proche du grain naturel.
      last = (last + 0.03 * white) / 1.03;
      d[i] = white * 0.7 + last * 4.5 * 0.3;
    }
    this.noiseBuffer = buf;

    this.buildAmbient();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  // -------------------------------------------------------------------------
  // AMBIANCE
  // -------------------------------------------------------------------------

  buildAmbient() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.0;
    out.connect(this.master);

    // Ressac : bruit passe-bas dont le gain est pilote par la simulation.
    const surf = ctx.createBufferSource();
    surf.buffer = this.noiseBuffer;
    surf.loop = true;
    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = 'lowpass';
    surfFilter.frequency.value = 900;
    surfFilter.Q.value = 0.6;
    const surfGain = ctx.createGain();
    surfGain.gain.value = 0.16;
    surf.connect(surfFilter).connect(surfGain).connect(out);
    surf.start();

    // Grondement : le meme bruit, tres bas, qui ne s'ouvre qu'avec la grosse
    // houle. C'est le corps de la tempete, pas son sifflement.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBuffer;
    rumble.loop = true;
    rumble.playbackRate.value = 0.5;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 160;
    rumbleFilter.Q.value = 0.7;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(out);
    rumble.start();

    // Vent : bruit passe-bande tres doux.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    wind.playbackRate.value = 0.65;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 480;
    windFilter.Q.value = 0.8;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    wind.connect(windFilter).connect(windGain).connect(out);
    wind.start();

    this.ambient = { out, surfFilter, surfGain, rumbleGain, windFilter, windGain };
    this._ambientT = 0;
    this._pulse = 0;
    out.gain.setTargetAtTime(0.9, ctx.currentTime, 2.5);
  }

  /**
   * @param {number} swash energie de la houle, 0 = mer d'huile, ~3 = tempete
   *   (non bornee : c'est ici qu'on la borne)
   * @param {number} wind 0..1
   * @param {number} breaking nombre de cellules qui deferlent (rythme)
   */
  updateAmbient(dt, swash = 0, wind = 0.3, breaking = 0) {
    if (!this.ready || !this.ambient) return;
    const t = this.ctx.currentTime;
    const a = this.ambient;
    this._ambientT += dt;
    // Intensite qui SATURE : une tempete est forte, pas infiniment forte.
    // 0,57 (petites vagues) donne 0,6 ; 2,9 (tempete) donne 0,99.
    const rise = 1 - Math.exp(-Math.max(0, swash) * 1.6);
    // Le ressac respire au rythme des vagues qui cassent : le nombre de
    // cellules en deferlement monte et descend a chaque serie.
    const pulseTarget = Math.min(1, breaking / 350);
    this._pulse += (pulseTarget - this._pulse) * Math.min(1, dt * 2.5);
    const surf = 0.08 + 0.20 * rise * (0.55 + 0.45 * this._pulse);
    a.surfGain.gain.setTargetAtTime(surf, t, 0.25);
    // Le ressac s'eclaircit avec la houle, sans jamais devenir un sifflement.
    a.surfFilter.frequency.setTargetAtTime(500 + 700 * rise, t, 0.3);
    // Le grondement ne s'ouvre qu'avec la grosse houle.
    const rumble = 0.22 * Math.max(0, rise - 0.5) * 2 * (0.6 + 0.4 * this._pulse);
    a.rumbleGain.gain.setTargetAtTime(rumble, t, 0.6);
    // Vent par rafales : deux sinus lents qui se croisent.
    const gust = 0.7 + 0.3 * Math.sin(this._ambientT * 0.7) * Math.sin(this._ambientT * 0.23 + 1.3);
    a.windGain.gain.setTargetAtTime((0.02 + 0.09 * wind) * gust, t, 0.8);
    a.windFilter.frequency.setTargetAtTime(420 + 260 * wind, t, 1.5);

    // Mouettes occasionnelles
    this.gullTimer = (this.gullTimer || 12) - dt;
    if (this.gullTimer <= 0) {
      this.gullTimer = 18 + Math.random() * 40;
      this.gull();
    }
  }

  gull() {
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 6;
      const gg = ctx.createGain();
      const t0 = t + i * (0.16 + Math.random() * 0.08);
      const base = 900 + Math.random() * 400;
      o.frequency.setValueAtTime(base, t0);
      o.frequency.exponentialRampToValueAtTime(base * 1.7, t0 + 0.06);
      o.frequency.exponentialRampToValueAtTime(base * 0.8, t0 + 0.18);
      f.frequency.setValueAtTime(base * 1.4, t0);
      gg.gain.setValueAtTime(0, t0);
      gg.gain.linearRampToValueAtTime(0.05, t0 + 0.03);
      gg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.22);
      o.connect(f).connect(gg).connect(g);
      o.start(t0); o.stop(t0 + 0.25);
    }
    g.gain.value = 1;
    setTimeout(() => g.disconnect(), 2000);
  }

  // -------------------------------------------------------------------------
  // EFFETS
  // -------------------------------------------------------------------------

  /** Bruit filtre avec enveloppe : la brique de base de tous les sons de sable. */
  noise(opts) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = opts.rate ?? 1;
    // Point de depart aleatoire : evite l'effet "meme echantillon" a la repetition.
    const offset = Math.random() * (NOISE_SECONDS - opts.dur - 0.05);

    const filt = ctx.createBiquadFilter();
    filt.type = opts.type || 'bandpass';
    filt.frequency.value = opts.freq;
    filt.Q.value = opts.q ?? 1;
    if (opts.sweep) {
      filt.frequency.setValueAtTime(opts.freq, t);
      filt.frequency.exponentialRampToValueAtTime(
        Math.max(60, opts.freq * opts.sweep), t + opts.dur);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0008, t + opts.dur);

    src.connect(filt).connect(g).connect(this.master);
    src.start(t, Math.max(0, offset));
    src.stop(t + opts.dur + 0.02);
    return { src, filt, g };
  }

  /** Impulsion tonale : le "poc" du sable dame, le "flop" du demoulage. */
  thump(freq, dur, gain, type = 'sine') {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.45), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /**
   * @param {string} name
   * @param {{volume?:number, moisture?:number}} p
   */
  play(name, p = {}) {
    if (!this.ready || !this.enabled) return;
    // Limitation de cadence : sans elle, un outil a 30 Hz sature tout.
    const now = performance.now();
    const min = THROTTLE[name] ?? 55;
    if (this.lastPlay[name] && now - this.lastPlay[name] < min) return;
    this.lastPlay[name] = now;

    const w = p.moisture ?? 0.1;
    const vol = (p.volume ?? 1) * 0.9;
    // Le sable sec est aigu et traine ; le sable mouille est sourd et bref.
    const dryness = 1 - Math.min(1, w / 0.35);
    const bright = 700 + 3600 * dryness;
    const len = 0.05 + 0.10 * dryness;

    switch (name) {
      case 'dig':
        this.noise({ freq: bright * 0.9, q: 0.8, dur: len * 1.6, gain: 0.16 * vol, sweep: 0.45 });
        if (w > 0.06) this.thump(120 - 30 * w, 0.09, 0.05 * vol);
        break;
      case 'pour':
        this.noise({ freq: 1400 + 2200 * dryness, q: 0.7, dur: 0.16, gain: 0.10 * vol, sweep: 0.6 });
        break;
      case 'pat':
        // Le "poc" : c'est lui qui dit au joueur que le sable est bien dame.
        this.thump(70 + 90 * (1 - dryness), 0.13, 0.16 * vol, 'sine');
        this.noise({ freq: bright * 0.5, q: 1.4, dur: 0.06, gain: 0.07 * vol });
        break;
      case 'smooth':
        this.noise({ freq: 900 + 1800 * dryness, q: 0.5, dur: 0.13, gain: 0.05 * vol, attack: 0.04 });
        break;
      case 'sprinkle':
        this.noise({ freq: 5200, q: 0.4, dur: 0.10, gain: 0.05 * vol, rate: 1.5 });
        break;
      case 'waterPour':
        this.noise({ freq: 700, q: 0.9, dur: 0.18, gain: 0.09 * vol, type: 'lowpass' });
        this.thump(220 + Math.random() * 90, 0.07, 0.03 * vol, 'sine');
        break;
      case 'cut':
        this.noise({ freq: 2400 + 1800 * dryness, q: 2.2, dur: 0.10, gain: 0.13 * vol, sweep: 0.35 });
        break;
      case 'carve':
        this.noise({ freq: 3200, q: 3.0, dur: 0.06, gain: 0.09 * vol, sweep: 0.5 });
        break;
      case 'rake':
        this.noise({ freq: 1800, q: 4.0, dur: 0.07, gain: 0.08 * vol, rate: 1.2 });
        break;
      case 'bucketFull':
        this.thump(300, 0.10, 0.08 * vol, 'triangle');
        break;
      case 'demouldGood':
        // Le "flop" mat et satisfaisant d'un demoulage reussi.
        this.thump(95, 0.20, 0.22 * vol, 'sine');
        this.noise({ freq: 500, q: 1.0, dur: 0.14, gain: 0.10 * vol, type: 'lowpass' });
        break;
      case 'demouldBad':
        this.noise({ freq: 1600 + 2400 * dryness, q: 0.6, dur: 0.30, gain: 0.14 * vol, sweep: 0.3 });
        break;
      case 'collapse':
        // Pas d'impulsion sub-basse : meme lorsqu'un demoulage rate vraiment,
        // du sable s'affaisse en frottant, il ne produit pas un coup de canon.
        this.noise({ freq: 1050, q: 0.55, dur: 0.32, gain: 0.075 * vol,
          sweep: 0.48, attack: 0.025 });
        break;
      case 'crack':
        this.noise({ freq: 3800, q: 6, dur: 0.05, gain: 0.05 * vol });
        break;
      case 'place':
        this.thump(520, 0.06, 0.06 * vol, 'triangle');
        break;
      case 'ui':
        this.thump(880, 0.045, 0.045 * vol, 'sine');
        break;
      default:
        break;
    }
  }

  dispose() {
    if (this.ctx) this.ctx.close();
  }
}

/** Intervalle minimal entre deux occurrences d'un meme son (ms). */
const THROTTLE = {
  dig: 90,
  pour: 100,
  pat: 110,
  smooth: 130,
  sprinkle: 70,
  waterPour: 90,
  cut: 85,
  carve: 65,
  rake: 80,
  collapse: 320,
  crack: 260,
  place: 60,
  ui: 30,
};
