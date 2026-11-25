'use strict';
(function () {
  const app = document.getElementById('app');

  /* =========================================================
     Outils
     ========================================================= */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const round5 = (v) => Math.round(v / 5) * 5;
  const r1 = (v) => Math.round(v * 10) / 10;
  const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const intOrNull = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d{1,3}$/.test(s) ? +s : null; };
  const timeOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 36000 ? r1(v) : null);

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage plein ou bloqué */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* rien */ } }
  };

  const SITE = location.host && !/^(localhost|127\.|\[::1\])/.test(location.host)
    ? (location.host + location.pathname).replace(/\/(index\.html)?$/, '')
    : 'tropfan';

  const SERIES = ['Rick et Morty', 'Kaamelott', 'The Office', 'Friends', 'Les Simpson', 'Bref', 'Breaking Bad', 'Brooklyn Nine-Nine', 'Game of Thrones', 'One Piece'];

  const LEVELS = [
    { min: 85, label: 'Inquiétant', line: 'Ça commence sérieusement à faire peur.' },
    { min: 65, label: 'Trop fan', line: 'Connaît les répliques mieux que les scénaristes.' },
    { min: 40, label: 'Vrai fan', line: 'Solide. Mais on a vu plus obsédé.' },
    { min: 15, label: 'Spectateur du dimanche', line: "Connaît le générique, c'est un début." },
    { min: 0, label: 'Touriste', line: 'A vu deux épisodes chez un pote.' }
  ];
  const LEVEL_BOUNDS = [[85, 100], [65, 84], [40, 64], [15, 39], [0, 14]];
  const levelFor = (p) => LEVELS.find((l) => p >= l.min);

  // Barème du quiz : points de base, multipliés selon l'indice auquel on trouve
  const BASE = { r: 500, e: 300, s: 100, n: 100 };
  const STEPS = [0.1, 0.5, 1, 2, 4];
  const MULTS = [1, 0.85, 0.7, 0.55, 0.42, 0.3];
  const LAST_MULT = 0.2;
  const fmtMult = (m) => '×' + String(m).replace('.', ',');
  const fmtSec = (d) => String(d).replace('.', ',') + ' s';

  const S = {
    sound: store.get('tf_sound', true),
    setup: store.get('tf_setup', null) || { serie: '', players: [''], total: 10, chrono: 10 },
    duel: store.get('tf_duel', null),
    draft: store.get('tf_draft2', null),
    quiz: null,
    route: null,
    bump: null,
    card: null,
    cardData: null,
    cardText: '',
    shareLink: null
  };

  /* =========================================================
     Son (synthétisé, aucun fichier)
     ========================================================= */
  let AC = null;
  function audio() {
    if (!AC) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { AC = new C(); } catch (e) { return null; }
    }
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function tone(f, d, type, v, at) {
    if (!S.sound) return;
    const a = audio();
    if (!a) return;
    const t = a.currentTime + (at || 0);
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v || 0.16, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(a.destination);
    o.start(t);
    o.stop(t + d + 0.03);
  }
  const SFX = {
    exact() { tone(880, 0.14, 'triangle', 0.18); tone(1318, 0.26, 'triangle', 0.18, 0.1); },
    close() { tone(698, 0.2, 'triangle', 0.16); },
    miss() { tone(155, 0.32, 'sawtooth', 0.09); tone(147, 0.32, 'square', 0.05); },
    found() { tone(1046, 0.14, 'triangle', 0.16); tone(1568, 0.26, 'triangle', 0.15, 0.09); },
    tick() { tone(1250, 0.05, 'square', 0.05); },
    buzz() { tone(110, 0.65, 'sawtooth', 0.13); tone(117, 0.65, 'sawtooth', 0.1); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.14, i * 0.09)); }
  };

  /* =========================================================
     Comparaison des réponses (permissive sur les noms propres)
     ========================================================= */
  function normText(s) {
    return String(s || '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function toks(s) { return normText(s).split(/[^a-z0-9]+/).filter(Boolean); }

  function seqLev(A, B, eq) {
    const n = A.length, m = B.length;
    if (!n) return m;
    if (!m) return n;
    let prev = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (eq(A[i - 1], B[j - 1]) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[m];
  }
  const same = (a, b) => a === b;
  function charRatio(a, b) {
    if (a === b) return 1;
    const m = Math.max(a.length, b.length);
    if (!m) return 1;
    return 1 - seqLev(a, b, same) / m;
  }
  // Clé sonore grossière : Morty = Mortie, Rick = Rik, Meeseeks = Miseeks...
  function phon(t) {
    let s = t.replace(/ph/g, 'f').replace(/qu/g, 'k').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's')
      .replace(/[cq]/g, 'k').replace(/y/g, 'i').replace(/w/g, 'v').replace(/h/g, '').replace(/(.)\1+/g, '$1');
    if (s.length > 3) s = s.replace(/[estxdz]+$/, '');
    return s || t;
  }
  function tokEq(a, b) {
    if (a === b) return true;
    const L = Math.min(a.length, b.length);
    if (L >= 3 && phon(a) === phon(b)) return true;
    if (L < 5) return false;
    return seqLev(a, b, same) <= (L >= 8 ? 2 : 1);
  }

  function lcsMatched(A, B, eq) {
    const n = A.length, m = B.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = eq(A[i], B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const hit = new Set();
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(A[i], B[j])) { hit.add(i); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    return hit;
  }

  // Réplique : 2 = mot pour mot, 1 = presque, 0 = ratée
  function judgeLine(expected, answer) {
    const words = String(expected || '').trim().split(/\s+/).filter(Boolean).map((w) => ({ w, t: toks(w) }));
    const E = [];
    words.forEach((x, wi) => x.t.forEach((t) => E.push({ t, wi })));
    const A = toks(answer);
    const et = E.map((x) => x.t);
    let score = 0, hit = new Set();
    if (A.length && et.length) {
      const d = seqLev(et, A, tokEq);
      const wordSim = 1 - d / Math.max(et.length, A.length);
      const chSim = charRatio(et.map(phon).join(' '), A.map(phon).join(' '));
      hit = lcsMatched(et, A, tokEq);
      const coverage = hit.size / et.length;
      const precision = hit.size / A.length;
      const glued = et.map(phon).join('') === A.map(phon).join('');
      if (glued) hit = new Set(et.map((_, k) => k));
      score = d === 0 || glued ? 2 : (wordSim >= 0.6 || chSim >= 0.72 || (coverage >= 0.45 && precision >= 0.75)) ? 1 : 0;
    }
    const parts = words.map((x, wi) => {
      const idx = [];
      E.forEach((e, k) => { if (e.wi === wi) idx.push(k); });
      if (!idx.length) return { w: x.w, c: '' };
      const n = idx.filter((k) => hit.has(k)).length;
      return { w: x.w, c: n === idx.length ? 'w-ok' : n ? 'w-part' : 'w-miss' };
    });
    return { score, parts };
  }

  const CODE_RE = /\bs\s*0*(\d{1,2})\s*[-.:]?\s*e(?:p|pisode)?\s*0*(\d{1,3})\b|\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b|saison\s*0*(\d{1,2})\D{1,14}?(?:episode|ep|e)\s*0*(\d{1,3})/;
  function parseCode(s) {
    const m = normText(s).match(CODE_RE);
    if (!m) return null;
    const a = m[1] || m[3] || m[5], b = m[2] || m[4] || m[6];
    return [+a, +b];
  }
  const onlyCode = (s) => !normText(s).replace(new RegExp(CODE_RE.source, 'g'), '').replace(/[^a-z0-9]/g, '');

  const STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'a', 'au', 'aux', 'en', 'the', 'of', 'and', 'episode', 'ep']);

  function matchTitle(title, ans) {
    const tt = toks(title), at = toks(ans);
    if (!tt.length || !at.length) return false;
    const tj = tt.map(phon).join(' '), aj = at.map(phon).join(' ');
    if (tj === aj || charRatio(tj, aj) >= 0.72) return true;
    const sig = tt.filter((t) => !STOP.has(t));
    const sigA = at.filter((t) => !STOP.has(t));
    if (!sig.length || !sigA.length) return false;
    if (charRatio(sig.map(phon).join(' '), sigA.map(phon).join(' ')) >= 0.75) return true;
    const hits = sig.filter((t) => sigA.some((a) => tokEq(t, a))).length;
    return hits / sig.length >= 0.7 && sigA.length <= sig.length + 3;
  }
  // Titre d'épisode : plusieurs titres acceptés, séparés par "/"
  function judgeEpisode(q, answer) {
    const ans = String(answer || '').trim();
    if (!ans) return 0;
    return String(q.e || '').split('/').map((x) => x.trim()).filter(Boolean).some((t) => matchTitle(t, ans)) ? 1 : 0;
  }

  /* =========================================================
     YouTube : liens et temps
     ========================================================= */
  function parseT(v) {
    if (/^\d+$/.test(v)) return +v;
    const m = String(v).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }
  function parseYT(url) {
    const s = String(url || '').trim();
    if (!s) return null;
    const m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
    if (!m) return /^[A-Za-z0-9_-]{11}$/.test(s) ? { id: s, t: null } : null;
    const t = s.match(/[?&#](?:t|start)=([0-9hms]+)/);
    return { id: m[1], t: t ? parseT(t[1]) : null };
  }
  // "1:23.4", "1:23,4", "83.4", "1:02:03" ; null si vide, NaN si illisible
  function parseClock(v) {
    v = String(v == null ? '' : v).trim().replace(',', '.');
    if (!v) return null;
    if (/^\d+(\.\d+)?$/.test(v)) return +v;
    let m = v.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return (+m[1]) * 60 + (+m[2]);
    m = v.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    return NaN;
  }
  function fmtClock(s) {
    s = Math.max(0, r1(s));
    const m = Math.floor(s / 60);
    return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
  }
  const validTime = (v) => v != null && !Number.isNaN(v);

  /* =========================================================
     Lecteur YouTube officiel piloté par l'API (rien n'est hébergé ici)
     ========================================================= */
  let ytP = null;
  function ytReady() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!ytP) {
      ytP = new Promise((res, rej) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { ytP = null; rej(new Error('yt')); };
        document.head.appendChild(s);
        setTimeout(() => { if (!(window.YT && window.YT.Player)) { ytP = null; rej(new Error('timeout')); } }, 15000);
      });
    }
    return ytP;
  }

  const PL = { raw: null, p: null, mode: '', videoId: '', card: -1, token: 0, seg: null, raf: 0, free: false };

  function destroyPlayer() {
    segStop();
    PL.token++;
    if (PL.raw) { try { PL.raw.destroy(); } catch (e) { /* déjà parti */ } }
    PL.raw = null;
    PL.p = null;
    PL.card = -1;
    PL.videoId = '';
  }

  async function mountPlayer(slotId, videoId, mode, onReady, card) {
    destroyPlayer();
    const token = PL.token;
    PL.card = card == null ? -1 : card;
    let YT;
    try { YT = await ytReady(); } catch (e) {
      const s = document.getElementById(slotId);
      if (s) s.innerHTML = '<div class="yt-wait">Impossible de charger YouTube. Vérifie ta connexion puis recharge la page.</div>';
      return;
    }
    if (token !== PL.token) return;
    const slot = document.getElementById(slotId);
    if (!slot) return;
    slot.innerHTML = '';
    const host = document.createElement('div');
    slot.appendChild(host);
    PL.mode = mode;
    PL.videoId = videoId;
    const edit = mode === 'edit';
    PL.raw = new YT.Player(host, {
      host: 'https://www.youtube-nocookie.com',
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        controls: edit ? 1 : 0, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3,
        fs: 0, disablekb: edit ? 0 : 1, cc_load_policy: 0, origin: location.origin
      },
      events: {
        onReady: () => {
          if (token !== PL.token) return;
          PL.p = PL.raw;
          if (!edit) { try { PL.p.unloadModule('captions'); } catch (e) { /* pas de sous-titres */ } }
          if (onReady) onReady(PL.p);
        },
        onStateChange: (e) => { if (token === PL.token) onPlayerState(e.data); },
        onError: (e) => { if (token === PL.token) onPlayerError(e.data); }
      }
    });
  }

  function segStop() {
    if (PL.raf) clearTimeout(PL.raf);
    PL.raf = 0;
    PL.seg = null;
  }
  function onPlayerState(s) {
    const sg = PL.seg, p = PL.p;
    if (!p) return;
    const now = performance.now();
    // En jeu, jamais de sous-titres : ils donneraient la réplique
    if (s === 1 && PL.mode === 'game') { try { p.unloadModule('captions'); } catch (e) { /* rien */ } }
    if (sg && sg.frame) {
      if (s === 1) frameLand(p, sg);
      return;
    }
    if (sg) {
      // Le chrono de l'extrait part du vrai démarrage de la lecture
      if (s === 1 && !sg.playAt) sg.playAt = now;
      return;
    }
    // En jeu, pas de lecture hors des extraits débloqués
    if (PL.mode === 'game' && s === 1 && !PL.free) {
      p.pauseVideo();
      toast('Utilise les boutons d\'extrait sous la vidéo');
    }
  }
  function onPlayerError(code) {
    segStop();
    const msg = code === 101 || code === 150 ? 'Cette vidéo ne peut pas être lue ici : supprimée, privée, ou bloquée hors de YouTube par sa chaîne.'
      : code === 100 ? 'Vidéo introuvable ou privée.' : 'Cette vidéo ne peut pas être lue ici.';
    if (PL.mode === 'game' && S.quiz) {
      S.quiz.vidErr = msg;
      updatePlay();
    } else if (PL.mode === 'edit') {
      const box = document.getElementById('ytmsg-' + PL.card);
      if (box) { box.className = 'yt-msg bad'; box.textContent = msg + ' Choisis une autre vidéo.'; }
    }
  }
  // La vidéo a été chargée au début de la scène (pour pouvoir y revenir sans blocage),
  // on se place ensuite en pause sur l'image de la coupure.
  function frameLand(p, sg) {
    try { p.pauseVideo(); p.seekTo(sg.t, true); } catch (e) { /* rien */ }
    segStop();
    setTimeout(() => { try { if (!PL.seg || !PL.seg.frame) p.unMute(); } catch (e) { /* rien */ } }, 400);
  }
  function segLoop() {
    const sg = PL.seg, p = PL.p;
    if (!sg || !p) return;
    const now = performance.now();
    if (sg.frame) {
      let st = -1;
      try { st = p.getPlayerState(); } catch (e) { /* rien */ }
      if ((st === 1 && now - sg.t0 > 600) || now - sg.t0 > 9000) { frameLand(p, sg); return; }
    } else {
      const dur = (sg.to - sg.from) * 1000;
      if (!sg.playAt) {
        let st = -1;
        try { st = p.getPlayerState(); } catch (e) { /* rien */ }
        if (st === 1 && now - sg.t0 > 350) {
          // événement de lecture manqué : on se fie à l'état lu
          sg.playAt = now - 100;
        } else if (!sg.retried && now - sg.t0 > 1800 && PL.videoId) {
          // lecteur bloqué après un saut (ça arrive en revenant en arrière) : on recharge à l'instant voulu
          sg.retried = true;
          sg.t0 = now;
          try { p.loadVideoById({ videoId: PL.videoId, startSeconds: sg.from }); } catch (e) { /* rien */ }
        }
      }
      // Position lue dans le lecteur : fiable seulement une fois le saut vers le début pris en compte
      let ct = NaN;
      try { ct = p.getCurrentTime(); } catch (e) { /* rien */ }
      if (!sg.ctOk && Math.abs(ct - sg.from) <= 0.3 && (ct !== sg.ct0 || Math.abs(sg.ct0 - sg.from) > 0.3)) sg.ctOk = true;
      let over = false;
      if (sg.playAt) over = now - sg.playAt >= dur - 25 || (sg.ctOk && ct >= sg.to - 0.04);
      if (over) {
        p.pauseVideo();
        const cb = sg.cb;
        segStop();
        if (cb) cb();
        return;
      }
      if (now - sg.t0 > dur + 15000) { p.pauseVideo(); segStop(); return; }
    }
    PL.raf = setTimeout(segLoop, 10);
  }
  // Joue exactement [from, to] puis met en pause (chronométré à partir du vrai démarrage)
  function playSeg(from, to, cb) {
    const p = PL.p;
    if (!p) { toast('La vidéo charge encore, réessaie dans une seconde'); return; }
    segStop();
    let ct0 = NaN;
    try { ct0 = p.getCurrentTime(); } catch (e) { /* rien */ }
    PL.seg = { from, to: Math.max(to, from + 0.05), cb, t0: performance.now(), playAt: 0, ct0 };
    try {
      if (p.getPlayerState() === 1) p.pauseVideo();
      p.unMute();
      p.seekTo(from, true);
      p.playVideo();
    } catch (e) { /* rien */ }
    PL.raf = setTimeout(segLoop, 10);
  }
  // Image figée à l'instant t. Pour une nouvelle scène : chargement muet au début de la scène
  // (from), puis pause et saut vers t dès que la lecture démarre.
  function showFrame(t, videoId, from) {
    const p = PL.p;
    if (!p) return;
    segStop();
    try {
      if (videoId) {
        PL.seg = { frame: true, t, t0: performance.now() };
        PL.videoId = videoId;
        p.mute();
        p.loadVideoById({ videoId, startSeconds: from != null && from < t ? from : t });
        PL.raf = setTimeout(segLoop, 10);
      } else {
        p.pauseVideo();
        p.seekTo(t, true);
      }
    } catch (e) { /* rien */ }
  }

  /* =========================================================
     Lien de quiz : tout est dans l'URL (compressé)
     ========================================================= */
  function b64u(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  async function encodeQuiz(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if ('CompressionStream' in window) {
      try {
        const cs = new CompressionStream('deflate-raw');
        const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
        return 'z' + b64u(new Uint8Array(buf));
      } catch (e) { /* on retombe sur la version non compressée */ }
    }
    return 'j' + b64u(bytes);
  }
  async function decodeQuiz(s) {
    const kind = s.charAt(0);
    const bytes = unb64u(s.slice(1));
    let out;
    if (kind === 'z') {
      if (!('DecompressionStream' in window)) throw new Error('old');
      const ds = new DecompressionStream('deflate-raw');
      out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
    } else if (kind === 'j') {
      out = bytes;
    } else {
      throw new Error('format');
    }
    return JSON.parse(new TextDecoder().decode(out));
  }
  function cleanQuiz(d) {
    if (!d || d.v !== 2 || !Array.isArray(d.q)) throw new Error(d && d.v === 1 ? 'v1' : 'vide');
    const q = d.q.slice(0, 40).map((x) => {
      const c = timeOrNull(x.c);
      if (c == null) return null;
      let a = timeOrNull(x.a);
      if (a == null || a >= c) a = Math.max(0, r1(c - 8));
      let z = timeOrNull(x.z);
      if (z != null && z <= c) z = null;
      return {
        y: /^[A-Za-z0-9_-]{11}$/.test(x.y || '') ? x.y : '',
        a, c, z,
        r: str(x.r, 500),
        e: str(x.e, 200),
        s: intOrNull(x.s),
        n: intOrNull(x.n)
      };
    }).filter((x) => x && x.y && x.r && x.e);
    if (!q.length) throw new Error('vide');
    const c = d.c && typeof d.c.n === 'string' && d.c.n.trim()
      ? { n: str(d.c.n, 30), p: clamp(Math.round(+d.c.p || 0), 0, 100), t: Number.isFinite(+d.c.t) && d.c.t != null ? Math.max(0, Math.round(+d.c.t)) : null }
      : null;
    return { s: str(d.s, 60) || 'Série', a: str(d.a, 40), t: str(d.t, 100), q, c };
  }
  const quizUrl = (code) => location.origin + location.pathname + '#/q/' + code;

  /* =========================================================
     Scores
     ========================================================= */
  function tally(list) {
    let rp = 0, ep = 0, exact = 0, close = 0;
    list.forEach((x) => { rp += x.r; ep += x.e; if (x.r === 2) exact++; else if (x.r === 1) close++; });
    const played = list.length;
    const pct = played ? Math.round(100 * (0.5 * rp / (2 * played) + 0.5 * ep / played)) : 0;
    return { played, rp, rpMax: 2 * played, ep, epMax: played, exact, close, pct };
  }
  function pname(d, p) {
    const v = String(d.players[p] || '').trim();
    return v || (d.players.length === 1 ? 'Le fan' : 'Joueur ' + (p + 1));
  }
  function duelTallies(d) {
    const n = d.players.length;
    return d.players.map((_, p) => Object.assign({ name: pname(d, p), p },
      tally(d.rounds.filter((r, i) => i % n === p && r.r != null && r.e != null))));
  }
  const saveDuel = () => store.set('tf_duel', S.duel);

  function stagesFor(q) {
    const L = Math.max(0.2, r1(q.c - q.a));
    const list = [{ k: 'img', label: 'Image', d: 0 }];
    STEPS.filter((d) => d < L - 0.05).forEach((d) => list.push({ k: 'x', label: fmtSec(d), d }));
    list.push({ k: 'full', label: 'Scène', d: L });
    list.forEach((s, i) => { s.m = i === 0 ? 1 : i === list.length - 1 ? LAST_MULT : MULTS[i]; });
    return list;
  }
  const qMax = (q) => BASE.r + (q.noE ? 0 : BASE.e) + (q.s != null ? BASE.s : 0) + (q.n != null ? BASE.n : 0);
  // l'épisode est-il demandé, et est-il trouvé (le titre, ou la saison et le numéro demandés)
  const epAsked = (q) => !q.noE || q.s != null || q.n != null;
  const epFound = (q, F) => !!(F.e || ((q.s != null || q.n != null) && (q.s == null || F.s) && (q.n == null || F.n)));
  function quizTally(res) {
    const t = { pts: 0, max: 0, n: 0, rf: 0, exact: 0, ef: 0, eMax: 0, sn: 0, snMax: 0 };
    res.forEach((r) => {
      if (!r || r.skipped) return;
      t.n++;
      t.pts += r.pts;
      t.max += r.max;
      if (r.r) t.rf++;
      if (r.r === 2) t.exact++;
      if (r.epAsk !== false) t.eMax++;
      if (r.ep != null ? r.ep : r.e) t.ef++;
      if (r.hasSN) { t.snMax++; if (r.s && r.n) t.sn++; }
    });
    t.pct = t.max ? Math.round(100 * t.pts / t.max) : 0;
    return t;
  }

  /* =========================================================
     Rendu et navigation
     ========================================================= */
  function go(h) {
    if (location.hash === h) render(); else location.hash = h;
  }
  function paint(html, routeKey, after) {
    const fresh = routeKey !== S.route;
    S.route = routeKey;
    const y = window.scrollY;
    app.innerHTML = '<div class="view' + (fresh ? ' in' : '') + '">' + html + '</div>';
    if (fresh) window.scrollTo(0, 0); else window.scrollTo(0, y);
    if (after) after();
  }
  function rerender() { render(); }

  function render() {
    stopChrono();
    destroyPlayer();
    const h = location.hash.replace(/^#\/?/, '');
    if (h.indexOf('q/') === 0) { renderQuiz(h.slice(2)); return; }
    if (h.indexOf('rm/') === 0) { renderSeries(h.slice(3)); return; }
    switch (h) {
      case '': paint(vHome(), 'home'); break;
      case 'duel': paint(vDuelSetup(), 'duel'); break;
      case 'duel/jeu':
        if (!S.duel) return go('#/duel');
        if (S.duel.done) return go('#/duel/fin');
        paint(vDuelPlay(), 'duel/jeu', afterPlay);
        break;
      case 'duel/fin':
        if (!S.duel) return go('#/duel');
        paint(vDuelEnd(), 'duel/fin', afterVerdict);
        break;
      case 'creer': paint(vBuilder(), 'creer'); break;
      default: go('#/');
    }
  }

  let toastT = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2400);
  }

  /* =========================================================
     Accueil
     ========================================================= */
  function multChips() {
    const st = [['Image', 1]].concat(STEPS.map((d, i) => [fmtSec(d), MULTS[i + 1]])).concat([['Scène', LAST_MULT]]);
    return '<div class="mults">' + st.map((x) => '<span><b>' + x[0] + '</b><i>' + fmtMult(x[1]) + '</i></span>').join('') + '</div>';
  }
  function vHome() {
    const d = S.duel;
    const resume = d && !d.done ? '<a class="resume" href="#/duel/jeu"><span>Reprendre le duel en cours · ' + esc(d.serie) + '</span><span aria-hidden="true">→</span></a>' : '';
    return `
      <section class="hero">
        <p class="kicker">Le blindtest des répliques</p>
        <h1>T'es fan,<br>ou <em>trop fan</em>&nbsp;?</h1>
        <p class="lead">Une image de la scène, puis 0,1 s, 0,5 s, 1 s… d'extrait. Trouve la réplique qui suit, l'épisode, la saison et le numéro. Plus tôt tu trouves, plus ça rapporte.</p>
      </section>
      ${resume}
      ${vRmCard()}
      <h3 class="modes-h">Autres modes</h3>
      <section class="modes" style="margin-top:12px">
        <a class="mode mode-quiz" href="#/creer">
          <span class="mode-tag">Vrais extraits YouTube</span>
          <h2>Crée ton blindtest</h2>
          <p>Choisis des scènes sur YouTube, coupe juste avant la réplique, envoie le lien. Tes potes ou tes abonnés jouent seuls et doivent battre ton score.</p>
          <span class="mode-cta">Créer mon blindtest</span>
        </a>
        <a class="mode mode-duel" href="#/duel">
          <span class="mode-tag">À deux, un seul téléphone</span>
          <h2>Duel en vrai</h2>
          <p>Tu lances un extrait, l'autre récite la réplique et donne l'épisode. Tu notes, le site compte les points et rend le verdict.</p>
          <span class="mode-cta">Lancer un duel</span>
        </a>
      </section>
      <section>
        <h3>Le barème</h3>
        <div class="rule-grid">
          <div class="rule r-line"><span class="rule-name">La réplique</span>
            <ul><li><b>500</b> mot pour mot</li><li><b>250</b> presque</li></ul></div>
          <div class="rule r-ep"><span class="rule-name">L'épisode</span>
            <ul><li><b>300</b> le titre</li><li><b>100</b> la saison</li><li><b>100</b> le numéro</li></ul></div>
        </div>
        <p class="small-note">Multiplié selon l'indice auquel tu trouves :</p>
        ${multChips()}
        <p class="small-note">Les fautes d'orthographe sur les noms propres passent. En duel : +2 mot pour mot, +1 presque, +1 l'épisode.</p>
        <h3>Le verdict</h3>
        <ol class="scale">
          ${LEVELS.map((l, i) => '<li><b>' + esc(l.label) + '</b><span>' + LEVEL_BOUNDS[i][0] + ' à ' + LEVEL_BOUNDS[i][1] + ' %</span></li>').join('')}
        </ol>
      </section>
      <p class="foot">Trop Fan n'est lié à aucune série, chaîne ou plateforme. Aucune vidéo n'est hébergée ici : les extraits sont lus depuis YouTube avec son lecteur officiel (pour Rick et Morty, uniquement des vidéos des chaînes officielles d'Adult Swim). Pas de compte, pas de cookies.</p>`;
  }

  function vRmCard() {
    const lang = getLang();
    const day = todayKey();
    const done = store.get('tf_jour_' + lang + '_' + day, null);
    const best = store.get('tf_best_' + lang, null);
    const d = RM[lang];
    if (!d) loadCat(lang).then(() => { if (S.route === 'home') paint(vHome(), 'home'); }).catch(() => {});
    const n = d ? fmtNum(d.q.length) + ' scènes officielles en ' + LANGS[lang] : 'Des centaines de scènes officielles';
    return `
      <section class="rm-card">
        <div class="rm-top">
          <span class="mode-tag">Rick et Morty</span>
          <div class="seg lang-pick">${['vf', 'vo'].map((l) => '<button type="button" class="' + (l === lang ? 'on' : '') + '" data-act="rm-lang" data-v="' + l + '">' + LANGS[l] + '</button>').join('')}</div>
        </div>
        <h2>Le blindtest sans fin</h2>
        <p>${n}, tirées au hasard. Trois vies : tiens le plus longtemps possible.</p>
        ${best ? '<p class="rm-best">Ton record en ' + LANGS[lang] + ' : <b>' + fmtNum(best.pts) + ' pts</b></p>' : ''}
        <div class="stack" style="margin-top:16px">
          <a class="btn btn-primary" href="#/rm/infini/${lang}">Mode sans fin</a>
          <a class="btn" href="#/rm/jour/${lang}">${done ? 'Défi du jour n°' + dayNum(day) + ' : ' + fmtNum(done.t.pts) + ' pts ✓' : 'Défi du jour n°' + dayNum(day) + ' · 5 scènes'}</a>
        </div>
      </section>`;
  }

  /* =========================================================
     Duel : réglages
     ========================================================= */
  function vDuelSetup() {
    const s = S.setup;
    const n = s.players.length;
    const serieN = normText(s.serie).trim();
    return `
      <p class="kicker" style="margin-top:18px">Mode duel</p>
      <h1 class="page-title">Duel en vrai</h1>
      <p class="page-sub">Toi, tu tiens le téléphone et tu lances les extraits. Le fan répond à voix haute, tu notes.</p>

      <label class="field"><span>La série</span>
        <input id="f-serie" data-bind="serie" value="${esc(s.serie)}" placeholder="Ex. : Rick et Morty" maxlength="40" autocomplete="off" enterkeyhint="done"></label>
      <div class="chips">${SERIES.map((x) => '<button type="button" class="chip' + (normText(x) === serieN ? ' on' : '') + '" data-act="pick-serie" data-v="' + esc(x) + '">' + esc(x) + '</button>').join('')}</div>

      <div class="field"><span class="field-lbl">${n > 1 ? 'Les joueurs' : 'Qui joue ?'}</span>
        <div class="players">
          ${s.players.map((p, i) => `
            <div class="player-row">
              <input data-bind="player" data-i="${i}" value="${esc(p)}" placeholder="${n > 1 ? 'Joueur ' + (i + 1) : 'Prénom du fan'}" maxlength="24" autocomplete="off">
              ${n > 1 ? '<button type="button" class="icon-btn" data-act="pl-del" data-i="' + i + '" aria-label="Retirer ce joueur">×</button>' : ''}
            </div>`).join('')}
        </div>
        ${n < 4 ? '<button type="button" class="link-btn" style="margin:10px 0 0" data-act="pl-add">+ Ajouter un joueur</button>' : ''}
      </div>

      <div class="field"><span class="field-lbl">Manches${n > 1 ? ' par joueur' : ''}</span>
        <div class="seg">${[5, 10, 15, 20].map((v) => '<button type="button" class="' + (s.total === v ? 'on' : '') + '" data-act="set-total" data-v="' + v + '">' + v + '</button>').join('')}</div>
      </div>

      <div class="field"><span class="field-lbl">Chrono pour répondre</span>
        <div class="seg">${[[0, 'Sans'], [5, '5 s'], [10, '10 s'], [15, '15 s']].map((v) => '<button type="button" class="' + (s.chrono === v[0] ? 'on' : '') + '" data-act="set-chrono" data-v="' + v[0] + '">' + v[1] + '</button>').join('')}</div>
      </div>

      <p class="form-err" id="setup-err"></p>
      <div class="stack"><button type="button" class="btn btn-primary" data-act="duel-start">Lancer le duel</button></div>
      <p class="tip"><b>Pour une vidéo :</b> filmez-vous avec l'écran visible. Les points tombent en direct et la carte du verdict fait une fin toute trouvée.</p>`;
  }

  function duelStart() {
    const s = S.setup;
    const serie = s.serie.trim();
    if (!serie) {
      const f = document.getElementById('f-serie');
      if (f) { f.classList.add('err-field'); f.focus(); }
      const er = document.getElementById('setup-err');
      if (er) er.textContent = 'Choisis une série pour commencer.';
      return;
    }
    const players = s.players.map((x) => x.trim().slice(0, 24));
    S.duel = {
      serie: serie.slice(0, 40),
      players,
      total: s.total,
      chrono: s.chrono,
      rounds: Array.from({ length: s.total * players.length }, () => ({ r: null, e: null })),
      cur: 0,
      done: false
    };
    saveDuel();
    audio();
    go('#/duel/jeu');
  }

  /* =========================================================
     Duel : partie
     ========================================================= */
  function vDuelPlay() {
    const d = S.duel;
    const n = d.players.length;
    const i = d.cur;
    const R = d.rounds[i];
    const p = i % n;
    const manche = Math.floor(i / n) + 1;
    const ts = duelTallies(d);
    const last = i === d.rounds.length - 1;
    const ready = R.r != null && R.e != null;
    const who = esc(pname(d, p));
    const bump = (k) => (S.bump === k ? ' bump' : '');

    const board = n === 1 ? `
      <div class="board">
        <div class="board-tile t-line"><span class="k">Répliques</span><span class="v${bump('r')}">${ts[0].rp}<small> pts</small></span></div>
        <div class="board-tile t-ep"><span class="k">Épisodes</span><span class="v${bump('e')}">${ts[0].ep}<small>/${ts[0].played}</small></span></div>
      </div>` : `
      <div class="board-multi">
        ${ts.map((t) => `<div class="pl${t.p === p ? ' cur' : ''}"><b>${esc(t.name)}</b><span class="pl-l${t.p === p ? bump('r') : ''}">${t.rp} pts</span><span class="pl-e${t.p === p ? bump('e') : ''}">${t.ep} ép.</span></div>`).join('')}
      </div>`;

    const chrono = d.chrono ? `
      <button type="button" class="chrono" id="chrono" data-act="chrono" aria-label="Lancer le chrono">
        <svg viewBox="0 0 132 132" aria-hidden="true"><circle class="trk" cx="66" cy="66" r="58"/><circle class="arc" id="chrono-arc" cx="66" cy="66" r="58" stroke-dasharray="364.4" stroke-dashoffset="0"/></svg>
        <span class="chrono-in"><span class="chrono-num" id="chrono-num">${d.chrono}</span><span class="chrono-lbl" id="chrono-lbl">Top chrono</span></span>
      </button>` : '';

    const opt = (k, v, label, pts) => `<button type="button" class="opt${v === 0 ? ' zero' : ''}${R[k] === v ? ' on' : ''}" data-act="judge" data-k="${k}" data-v="${v}" aria-pressed="${R[k] === v}"><b>${label}</b><i>${pts}</i></button>`;

    return `
      ${board}
      <div class="round-head">
        <span class="round-n">Manche ${manche}<small>/${d.total}</small></span>
        <span class="pill">${esc(d.serie)}</span>
      </div>
      ${n > 1 ? '<p class="turn">Au tour de <b>' + who + '</b></p>' : ''}
      <ol class="how">
        <li>Lance un extrait (TikTok, YouTube, ta télé…)</li>
        <li>${who} récite la réplique et donne l'épisode</li>
        <li>Tu notes, les points tombent</li>
      </ol>
      ${chrono}
      <div class="judge j-line">
        <div class="judge-h"><span>La réplique</span></div>
        <div class="judge-opts">${opt('r', 2, 'Mot pour mot', '+2')}${opt('r', 1, 'Presque', '+1')}${opt('r', 0, 'Ratée', '0')}</div>
      </div>
      <div class="judge j-ep">
        <div class="judge-h"><span>L'épisode</span></div>
        <div class="judge-opts">${opt('e', 1, 'Trouvé', '+1')}${opt('e', 0, 'Raté', '0')}</div>
      </div>
      <div class="play-nav">
        <button type="button" class="btn btn-ghost" data-act="prev"${i === 0 ? ' disabled' : ''}>Retour</button>
        <button type="button" class="btn btn-primary${ready ? ' ready' : ''}" data-act="next"${ready ? '' : ' disabled'}>${last ? 'Voir le verdict' : 'Manche suivante'}</button>
      </div>
      <button type="button" class="link-btn" data-act="duel-stop">Terminer maintenant</button>`;
  }
  function afterPlay() { S.bump = null; }

  function duelFinish() {
    S.duel.done = true;
    saveDuel();
    SFX.win();
    go('#/duel/fin');
  }

  /* ---------- chrono ---------- */
  const CH = { raf: 0, end: 0, dur: 0, lastSec: 0, running: false };
  function stopChrono() {
    if (CH.raf) cancelAnimationFrame(CH.raf);
    CH.raf = 0;
    CH.running = false;
  }
  function chronoUI(left, state) {
    const btn = document.getElementById('chrono');
    if (!btn) return;
    const arc = document.getElementById('chrono-arc');
    const numEl = document.getElementById('chrono-num');
    const lbl = document.getElementById('chrono-lbl');
    const frac = CH.dur ? left / (CH.dur * 1000) : 1;
    arc.setAttribute('stroke-dashoffset', String(364.4 * (1 - frac)));
    numEl.textContent = String(Math.ceil(left / 1000));
    btn.classList.toggle('low', state === 'run' && left <= 3000);
    btn.classList.toggle('over', state === 'over');
    lbl.textContent = state === 'run' ? 'Stop' : state === 'over' ? 'Temps écoulé' : 'Top chrono';
  }
  function chronoTick() {
    const left = Math.max(0, CH.end - performance.now());
    const sec = Math.ceil(left / 1000);
    if (sec !== CH.lastSec) {
      CH.lastSec = sec;
      if (sec > 0 && sec <= 3) SFX.tick();
    }
    if (left <= 0) {
      stopChrono();
      chronoUI(0, 'over');
      SFX.buzz();
      if (navigator.vibrate) navigator.vibrate(200);
      return;
    }
    chronoUI(left, 'run');
    CH.raf = requestAnimationFrame(chronoTick);
  }
  function chronoToggle() {
    if (CH.running) {
      stopChrono();
      chronoUI(S.duel.chrono * 1000, 'idle');
      return;
    }
    audio();
    CH.dur = S.duel.chrono;
    CH.end = performance.now() + CH.dur * 1000;
    CH.lastSec = CH.dur;
    CH.running = true;
    chronoTick();
  }

  /* =========================================================
     Verdict (duel et quiz)
     ========================================================= */
  function duelTiles(t) {
    return [
      { cls: 's-line', k: 'Répliques', v: t.rp, max: t.rpMax, sub: t.exact + ' mot pour mot · ' + t.close + ' presque', csub: t.exact + ' mot pour mot' },
      { cls: 's-ep', k: 'Épisodes', v: t.ep, max: t.epMax, sub: t.ep > 1 ? 'trouvés' : 'trouvé' }
    ];
  }

  function vDuelEnd() {
    const d = S.duel;
    const ts = duelTallies(d);
    const played = ts.reduce((a, t) => a + t.played, 0);
    if (!played) {
      return `<div class="center-msg"><h1 class="page-title">Aucune manche notée</h1><p>Le duel s'est arrêté avant la première note.</p>
        <div class="stack"><button type="button" class="btn btn-primary" data-act="duel-replay">Recommencer</button><a class="btn btn-ghost" href="#/">Accueil</a></div></div>`;
    }
    const sorted = ts.slice().sort((a, b) => b.pct - a.pct || b.rp - a.rp || b.ep - a.ep);
    const top = sorted[0];
    const multi = ts.length > 1;
    let extra = '', foot = '';
    if (multi) {
      extra = '<ol class="rank">' + sorted.map((t, k) => `<li class="${k === 0 ? 'first' : ''}"><span class="rk">${k + 1}</span><b>${esc(t.name)}</b><em>${t.pct} %</em><small>${t.rp}/${t.rpMax} pts de répliques · ${t.ep}/${t.epMax} épisodes</small></li>`).join('') + '</ol>';
      foot = 'Duel : ' + sorted.map((t) => t.name + ' ' + t.pct + ' %').join(' · ');
    }
    const tiles = duelTiles(top);
    S.cardData = { who: top.name, serie: d.serie, pct: top.pct, tiles, pts: null, foot };
    S.cardText = top.name + ' est « ' + levelFor(top.pct).label + ' » de ' + d.serie + ' (' + top.pct + ' %). Fais le test : ' + location.origin + location.pathname;
    return vVerdict({
      who: top.name,
      whoPrefix: multi ? 'Vainqueur du duel' : 'Le verdict pour',
      serie: d.serie,
      pct: top.pct,
      tiles,
      extra,
      actions: `<div class="stack">
          <button type="button" class="btn" data-act="duel-replay">Rejouer avec les mêmes réglages</button>
          <a class="btn btn-ghost" href="#/creer">Créer un blindtest pour tes abonnés</a>
        </div>`
    });
  }

  function vVerdict(o) {
    const L = levelFor(o.pct);
    return `
      <section class="verdict">
        <p class="kicker">${esc(o.serie)}</p>
        <p class="v-who">${esc(o.whoPrefix)} <b>${esc(o.who)}</b></p>
        <h1 class="v-level">${esc(L.label)}</h1>
        <p class="v-line">${esc(L.line)}</p>
        <div class="ring" id="ring" data-p="${o.pct}"><span><b>${o.pct}</b> %</span></div>
        ${o.pts != null ? '<p class="v-pts"><b>' + fmtNum(o.pts) + '</b> points</p>' : ''}
        <div class="stats">
          ${o.tiles.map((t) => `<div class="stat ${t.cls}"><span class="stat-k">${esc(t.k)}</span><b>${t.v}<small>/${t.max}</small></b><span class="stat-sub">${esc(t.sub)}</span></div>`).join('')}
        </div>
        ${o.extra || ''}
      </section>
      <section class="share">
        <img class="card-img" id="card-img" alt="Carte du verdict à partager en story">
        <button type="button" class="btn btn-primary" data-act="card-share">Partager la carte</button>
        <button type="button" class="btn" data-act="card-dl">Enregistrer l'image</button>
        <p class="hint">Dans Instagram ou TikTok, appuie longuement sur l'image pour l'enregistrer.</p>
      </section>
      ${o.actions || ''}`;
  }

  function afterVerdict() {
    const ring = document.getElementById('ring');
    if (ring) requestAnimationFrame(() => requestAnimationFrame(() => ring.style.setProperty('--p', ring.dataset.p)));
    if (S.cardData) {
      makeCard(S.cardData).then((c) => {
        S.card = c;
        const img = document.getElementById('card-img');
        if (img) img.src = c.toDataURL('image/png');
      }).catch(() => { /* la carte reste vide, le reste marche */ });
    }
  }

  /* =========================================================
     Carte du verdict (image 1080 x 1920 pour les stories)
     ========================================================= */
  let fontsP = null;
  function fontsReady() {
    if (!fontsP) {
      const load = document.fonts && document.fonts.load
        ? Promise.all(['800 100px', '700 40px', '500 40px'].map((f) => document.fonts.load(f + ' "Bricolage Grotesque"')))
        : Promise.resolve();
      fontsP = Promise.race([load, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
    }
    return fontsP;
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function glow(g, x, y, r, col) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function fitFont(g, text, maxW, weight, max, min, F) {
    let size = max;
    g.font = weight + ' ' + size + 'px ' + F;
    while (size > min && g.measureText(text).width > maxW) {
      size -= 4;
      g.font = weight + ' ' + size + 'px ' + F;
    }
    return size;
  }
  function wrapLines(g, text, maxW) {
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    words.forEach((w) => {
      const t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  async function makeCard(o) {
    await fontsReady();
    const W = 1080, H = 1920, X = 84, CW = W - 2 * X;
    const F = '"Bricolage Grotesque", system-ui, sans-serif';
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const L = levelFor(o.pct);

    g.fillStyle = '#0A0A0D';
    g.fillRect(0, 0, W, H);
    glow(g, 930, 220, 760, 'rgba(201,242,61,0.20)');
    glow(g, 80, 1720, 820, 'rgba(255,111,160,0.17)');
    g.textBaseline = 'alphabetic';

    // logo + site
    g.font = '800 54px ' + F;
    g.fillStyle = '#F3F2EE';
    g.fillText('TROP', X, 150);
    const lw = g.measureText('TROP ').width;
    g.fillStyle = '#C9F23D';
    g.fillText('FAN', X + lw, 150);

    // série
    g.font = '700 38px ' + F;
    const serie = o.serie.toUpperCase();
    const sw = Math.min(g.measureText(serie).width, CW - 70);
    rr(g, X, 224, sw + 68, 80, 40);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fill();
    g.fillStyle = '#F3F2EE';
    g.fillText(serie, X + 34, 278, CW - 70);

    // qui
    let y = 450;
    g.font = '500 50px ' + F;
    g.fillStyle = '#9B9AA5';
    g.fillText('Le verdict pour', X, y);
    const ws = fitFont(g, o.who, CW, '800', 150, 72, F);
    y += ws * 0.95 + 18;
    g.fillStyle = '#F3F2EE';
    g.fillText(o.who, X, y, CW);

    // niveau
    const lbl = L.label.toUpperCase();
    g.fillStyle = '#C9F23D';
    let ls = fitFont(g, lbl, CW, '800', 176, 112, F);
    if (g.measureText(lbl).width > CW) {
      g.font = '800 132px ' + F;
      let lines = wrapLines(g, lbl, CW);
      ls = 132;
      while (ls > 84 && lines.some((ln) => g.measureText(ln).width > CW)) {
        ls -= 6;
        g.font = '800 ' + ls + 'px ' + F;
        lines = wrapLines(g, lbl, CW);
      }
      lines.slice(0, 2).forEach((ln) => { y += ls * 0.92; g.fillText(ln, X, y); });
    } else {
      y += ls * 0.92;
      g.fillText(lbl, X, y);
    }

    // phrase
    g.font = '500 46px ' + F;
    g.fillStyle = 'rgba(243,242,238,0.82)';
    y += 40;
    wrapLines(g, L.line, CW).slice(0, 2).forEach((ln) => { y += 58; g.fillText(ln, X, y); });

    // anneau
    const hasPts = o.pts != null;
    const R = 160, cx = W / 2, cy = Math.max(y + 240, 1190);
    g.lineWidth = 32;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    if (o.pct > 0) {
      g.strokeStyle = '#C9F23D';
      g.beginPath();
      g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (o.pct / 100));
      g.stroke();
    }
    g.textAlign = 'left';
    g.font = '800 124px ' + F;
    const pw = g.measureText(String(o.pct)).width;
    g.font = '700 52px ' + F;
    const uw = g.measureText(' %').width;
    const sx = cx - (pw + uw) / 2;
    g.font = '800 124px ' + F;
    g.fillStyle = '#F3F2EE';
    g.fillText(String(o.pct), sx, cy + 42);
    g.font = '700 52px ' + F;
    g.fillStyle = '#9B9AA5';
    g.fillText(' %', sx + pw, cy + 42);

    if (hasPts) {
      g.textAlign = 'center';
      g.font = '800 46px ' + F;
      g.fillStyle = '#F3F2EE';
      g.fillText(fmtNum(o.pts) + ' points', cx, cy + R + 76);
      g.textAlign = 'left';
    }

    // tuiles
    const ty = cy + R + (hasPts ? 116 : 80), tw = (CW - 28) / 2, th = 236;
    const tile = (tx, col, bg, t) => {
      rr(g, tx, ty, tw, th, 34);
      g.fillStyle = bg;
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = col;
      g.globalAlpha = 0.45;
      g.stroke();
      g.globalAlpha = 1;
      g.font = '700 32px ' + F;
      g.fillStyle = col;
      g.fillText(t.k.toUpperCase(), tx + 34, ty + 62);
      g.font = '800 96px ' + F;
      g.fillStyle = '#F3F2EE';
      g.fillText(t.v + '/' + t.max, tx + 34, ty + 160, tw - 60);
      g.font = '500 32px ' + F;
      g.fillStyle = '#9B9AA5';
      g.fillText(t.csub || t.sub, tx + 34, ty + 208, tw - 60);
    };
    tile(X, '#C9F23D', 'rgba(201,242,61,0.08)', o.tiles[0]);
    tile(X + tw + 28, '#FF6FA0', 'rgba(255,111,160,0.08)', o.tiles[1]);

    // ligne bonus (défi, classement)
    if (o.foot) {
      g.font = '700 38px ' + F;
      g.fillStyle = '#F3F2EE';
      g.textAlign = 'center';
      g.fillText(o.foot, W / 2, ty + th + 72, CW);
    }

    // pied
    const ft = 'Fais le test sur ';
    let fs = 40, fw = 0, hw = 0;
    for (; fs >= 24; fs -= 2) {
      g.font = '600 ' + fs + 'px ' + F;
      fw = g.measureText(ft).width;
      g.font = '800 ' + fs + 'px ' + F;
      hw = g.measureText(SITE).width;
      if (fw + hw <= CW) break;
    }
    g.textAlign = 'left';
    const fx = (W - fw - hw) / 2;
    g.font = '600 ' + fs + 'px ' + F;
    g.fillStyle = '#9B9AA5';
    g.fillText(ft, fx, H - 70);
    g.font = '800 ' + fs + 'px ' + F;
    g.fillStyle = '#C9F23D';
    g.fillText(SITE, fx + fw, H - 70);
    return c;
  }

  function cardBlob() {
    return new Promise((res) => {
      if (!S.card) return res(null);
      S.card.toBlob((b) => res(b), 'image/png');
    });
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  async function cardShare() {
    const blob = await cardBlob();
    if (!blob) { toast('La carte se prépare, réessaie dans une seconde'); return; }
    const file = new File([blob], 'trop-fan.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: S.cardText }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(blob, 'trop-fan.png');
    toast('Image enregistrée');
  }
  async function cardDownload() {
    const blob = await cardBlob();
    if (!blob) { toast('La carte se prépare, réessaie dans une seconde'); return; }
    downloadBlob(blob, 'trop-fan.png');
    toast('Image enregistrée');
  }

  /* =========================================================
     Partage de lien
     ========================================================= */
  function linkBox(url, text) {
    S.shareLink = { url, text };
    return `<div class="linkbox">
        <input readonly value="${esc(url)}" id="lb-in" aria-label="Lien à partager">
        <div class="lb-btns">
          <button type="button" class="btn" data-act="copy">Copier</button>
          <button type="button" class="btn btn-primary" data-act="share-link">Partager</button>
        </div>
      </div>`;
  }
  async function copyLink() {
    const url = S.shareLink && S.shareLink.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié');
    } catch (e) {
      const inp = document.getElementById('lb-in');
      if (inp) {
        inp.focus();
        inp.select();
        try { document.execCommand('copy'); toast('Lien copié'); } catch (er) { toast('Sélectionne le lien pour le copier'); }
      }
    }
  }
  async function shareLink() {
    const L = S.shareLink;
    if (!L) return;
    if (navigator.share) {
      try { await navigator.share({ title: 'Trop Fan', text: L.text, url: L.url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    copyLink();
  }

  /* =========================================================
     Créer un blindtest (éditeur avec lecteur YouTube)
     ========================================================= */
  const newQ = () => ({ y: '', a: '', c: '', z: '', r: '', e: '', s: '', n: '' });
  function draft() {
    if (!S.draft || S.draft.v !== 2) S.draft = { v: 2, serie: '', author: '', title: '', qs: [newQ(), newQ(), newQ()] };
    return S.draft;
  }
  let draftT = null;
  function saveDraft() {
    clearTimeout(draftT);
    draftT = setTimeout(() => store.set('tf_draft2', S.draft), 300);
  }

  function vBuilder() {
    const B = draft();
    return `
      <p class="kicker" style="margin-top:18px">Vrais extraits YouTube</p>
      <h1 class="page-title">Crée ton blindtest</h1>
      <p class="page-sub">Pour chaque réplique : une scène sur YouTube, l'instant juste avant la réplique, puis la réplique, le titre, la saison et le numéro de l'épisode. Les joueurs verront d'abord l'image, puis 0,1 s, 0,5 s, 1 s, 2 s, 4 s et toute la scène.</p>

      <label class="field"><span>La série</span>
        <input id="b-serie" data-bind="b" data-f="serie" value="${esc(B.serie)}" placeholder="Ex. : Rick et Morty" maxlength="40" autocomplete="off"></label>
      <div class="row2 even">
        <label class="field"><span>Ton pseudo</span>
          <input data-bind="b" data-f="author" value="${esc(B.author)}" placeholder="@toncompte" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>Titre (optionnel)</span>
          <input data-bind="b" data-f="title" value="${esc(B.title)}" placeholder="Le blindtest de…" maxlength="90" autocomplete="off"></label>
      </div>
      <p class="tip warn"><b>Bon à savoir :</b> le lecteur YouTube affiche le titre de la vidéo. Choisis des vidéos dont le titre ne donne pas l'épisode. Si une chaîne interdit la lecture hors de YouTube, le site te prévient.</p>

      <div id="qlist">${B.qs.map(vQCard).join('')}</div>
      ${B.qs.length < 30 ? '<button type="button" class="btn btn-ghost add" data-act="q-add">+ Ajouter une réplique</button>' : ''}

      <p class="form-err" id="build-err"></p>
      <div class="stack"><button type="button" class="btn btn-pink" data-act="build">Générer le lien du blindtest</button></div>
      <div id="build-out"></div>
      <p class="tip"><b>Astuce :</b> fais jouer ton blindtest à quelqu'un. À la fin, son bouton « Créer mon lien défi » donne un lien avec son score à battre. C'est celui-là qu'il faut poster.</p>
      <button type="button" class="link-btn" data-act="draft-reset">Tout effacer</button>`;
  }

  function ytMsg(q) {
    if (!q.y.trim()) return { c: '', t: 'Colle le lien d\'une scène de la série.' };
    const y = parseYT(q.y);
    if (!y) return { c: 'bad', t: 'Lien YouTube non reconnu.' };
    const c = parseClock(q.c), a = parseClock(q.a), z = parseClock(q.z);
    if ([c, a, z].some((v) => Number.isNaN(v))) return { c: 'bad', t: 'Temps au format 1:23.4 ou en secondes.' };
    if (c == null) return { c: 'ok', t: 'Vidéo reconnue. Ouvre-la, mets pause juste avant la réplique, puis appuie sur « Ici ».' };
    const start = a != null ? a : Math.max(0, c - 8);
    if (start >= c) return { c: 'bad', t: 'Le début de la scène doit venir avant la coupure.' };
    if (z != null && z <= c) return { c: 'bad', t: 'La fin de la réplique doit venir après la coupure.' };
    return { c: 'ok', t: 'Scène de ' + fmtClock(start) + ' à ' + fmtClock(c) + ' (' + fmtSec(r1(c - start)) + '), puis la réplique.' };
  }

  function vQCard(q, i) {
    const y = parseYT(q.y);
    const m = ytMsg(q);
    const f = (k) => 'data-bind="q" data-f="' + k + '" data-i="' + i + '"';
    return `
      <div class="qcard" id="qc-${i}">
        <div class="qcard-h"><span>Réplique ${i + 1}</span>${draft().qs.length > 1 ? '<button type="button" data-act="q-del" data-i="' + i + '">Supprimer</button>' : ''}</div>
        <label class="field"><span>Lien YouTube de la scène</span>
          <input ${f('y')} value="${esc(q.y)}" placeholder="https://youtu.be/…" inputmode="url" autocomplete="off"></label>
        <p class="yt-msg ${m.c}" id="ytmsg-${i}">${esc(m.t)}</p>
        <div class="yt-embed ed" id="ed-slot-${i}" hidden></div>
        <button type="button" class="btn btn-sm ed-open" data-act="ed-open" data-i="${i}" id="ed-open-${i}"${y ? '' : ' hidden'}>Ouvrir la vidéo pour régler les temps</button>

        <div class="trow">
          <label class="field"><span>Coupure : juste avant la réplique</span>
            <input ${f('c')} value="${esc(q.c)}" placeholder="1:23.4" autocomplete="off"></label>
          <button type="button" class="btn btn-sm now" data-act="t-now" data-f="c" data-i="${i}">Ici</button>
        </div>
        <div class="nudge">
          <button type="button" data-act="t-nudge" data-d="-0.5" data-i="${i}">-0,5 s</button>
          <button type="button" data-act="t-nudge" data-d="-0.1" data-i="${i}">-0,1 s</button>
          <button type="button" data-act="t-nudge" data-d="0.1" data-i="${i}">+0,1 s</button>
          <button type="button" data-act="t-nudge" data-d="0.5" data-i="${i}">+0,5 s</button>
          <button type="button" class="t-test" data-act="t-test" data-k="cut" data-i="${i}">▶ Jusqu'à la coupure</button>
          <button type="button" class="t-test" data-act="t-test" data-k="line" data-i="${i}">▶ La réplique</button>
        </div>
        <div class="trow">
          <label class="field"><span>Début de la scène</span>
            <input ${f('a')} value="${esc(q.a)}" placeholder="Par défaut : 8 s avant la coupure" autocomplete="off"></label>
          <button type="button" class="btn btn-sm now" data-act="t-now" data-f="a" data-i="${i}">Ici</button>
        </div>
        <div class="trow">
          <label class="field"><span>Fin de la réplique (pour la révélation)</span>
            <input ${f('z')} value="${esc(q.z)}" placeholder="Optionnel" autocomplete="off"></label>
          <button type="button" class="btn btn-sm now" data-act="t-now" data-f="z" data-i="${i}">Ici</button>
        </div>

        <label class="field"><span>La réplique qui suit, mot pour mot</span>
          <textarea ${f('r')} rows="2" maxlength="500" placeholder="Telle qu'elle est dite dans la scène">${esc(q.r)}</textarea></label>
        <label class="field"><span>Titre de l'épisode</span>
          <input ${f('e')} value="${esc(q.e)}" maxlength="200" placeholder="Plusieurs titres acceptés : sépare-les par /" autocomplete="off"></label>
        <div class="row2 even">
          <label class="field"><span>Saison</span>
            <input ${f('s')} value="${esc(q.s)}" maxlength="3" inputmode="numeric" placeholder="3" autocomplete="off"></label>
          <label class="field"><span>Épisode n°</span>
            <input ${f('n')} value="${esc(q.n)}" maxlength="3" inputmode="numeric" placeholder="7" autocomplete="off"></label>
        </div>
      </div>`;
  }

  function refreshYtMsg(i) {
    const q = draft().qs[i];
    const box = document.getElementById('ytmsg-' + i);
    if (!q || !box) return;
    const m = ytMsg(q);
    box.className = 'yt-msg ' + m.c;
    box.textContent = m.t;
  }
  function setQField(i, k, v) {
    const q = draft().qs[i];
    if (!q) return;
    q[k] = v;
    const el = document.querySelector('[data-bind="q"][data-f="' + k + '"][data-i="' + i + '"]');
    if (el) { el.value = v; el.classList.remove('err-field'); }
    saveDraft();
    refreshYtMsg(i);
  }
  function closeEditors() {
    document.querySelectorAll('.yt-embed.ed').forEach((el) => { el.hidden = true; el.innerHTML = ''; });
    draft().qs.forEach((q, i) => {
      const b = document.getElementById('ed-open-' + i);
      if (b) b.hidden = !parseYT(q.y);
    });
  }
  function openEditor(i) {
    const q = draft().qs[i];
    const y = parseYT(q.y);
    if (!y) return;
    destroyPlayer();
    closeEditors();
    const slot = document.getElementById('ed-slot-' + i);
    const btn = document.getElementById('ed-open-' + i);
    if (!slot) return;
    slot.hidden = false;
    slot.innerHTML = '<div class="yt-wait">Chargement de la vidéo…</div>';
    if (btn) btn.hidden = true;
    const c = parseClock(q.c);
    const t = validTime(c) ? c : (y.t || 0);
    mountPlayer('ed-slot-' + i, y.id, 'edit', (p) => {
      if (t) p.cueVideoById({ videoId: y.id, startSeconds: t });
    }, i);
  }
  function editorFor(i) {
    if (PL.p && PL.mode === 'edit' && PL.card === i) return PL.p;
    toast('Ouvre d\'abord la vidéo de cette réplique');
    return null;
  }

  function onInput(e) {
    const el = e.target;
    const bind = el.dataset && el.dataset.bind;
    if (!bind) return;
    el.classList.remove('err-field');
    if (bind === 'serie') {
      S.setup.serie = el.value;
      store.set('tf_setup', S.setup);
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', normText(c.dataset.v) === normText(el.value).trim()));
      const er = document.getElementById('setup-err');
      if (er) er.textContent = '';
    } else if (bind === 'player') {
      S.setup.players[+el.dataset.i] = el.value;
      store.set('tf_setup', S.setup);
    } else if (bind === 'b') {
      draft()[el.dataset.f] = el.value;
      saveDraft();
    } else if (bind === 'q') {
      const i = +el.dataset.i;
      const q = draft().qs[i];
      if (!q) return;
      const k = el.dataset.f;
      q[k] = el.value;
      if (k === 'y') {
        if (PL.mode === 'edit' && PL.card === i) { destroyPlayer(); closeEditors(); }
        const y = parseYT(el.value);
        const b = document.getElementById('ed-open-' + i);
        if (b && !(PL.mode === 'edit' && PL.card === i)) b.hidden = !y;
        if (y && y.t && !q.c.trim()) setQField(i, 'c', fmtClock(y.t));
      }
      saveDraft();
      refreshYtMsg(i);
    } else if (bind === 'qname') {
      if (S.quiz) S.quiz.name = el.value;
      store.set('tf_name', el.value);
    } else if (bind === 'qa') {
      if (S.quiz && S.quiz.T) S.quiz.T[el.dataset.f] = el.value;
      const box = el.closest('.ans');
      if (box) box.classList.remove('wrong');
    }
  }

  function syncDraftFromDom() {
    document.querySelectorAll('[data-bind="q"]').forEach((el) => {
      const q = draft().qs[+el.dataset.i];
      if (q) q[el.dataset.f] = el.value;
    });
  }

  async function build() {
    const B = draft();
    const err = document.getElementById('build-err');
    const out = document.getElementById('build-out');
    err.textContent = '';
    out.innerHTML = '';
    document.querySelectorAll('.err-field').forEach((x) => x.classList.remove('err-field'));
    const mark = (sel) => { const el = document.querySelector(sel); if (el) el.classList.add('err-field'); return el; };

    if (!B.serie.trim()) {
      err.textContent = 'Indique la série du blindtest.';
      const el = mark('#b-serie');
      if (el) el.focus();
      return;
    }
    const problems = [];
    const qs = [];
    B.qs.forEach((q, i) => {
      const filled = Object.keys(q).some((k) => String(q[k]).trim());
      if (!filled) return;
      const sel = (k) => '[data-bind="q"][data-f="' + k + '"][data-i="' + i + '"]';
      const y = parseYT(q.y);
      const c = parseClock(q.c), a = parseClock(q.a), z = parseClock(q.z);
      const miss = [];
      if (!y) { miss.push('un lien YouTube valide'); mark(sel('y')); }
      if (!validTime(c)) { miss.push('la coupure'); mark(sel('c')); }
      if (Number.isNaN(a) || (validTime(a) && validTime(c) && a >= c)) { miss.push('un début avant la coupure'); mark(sel('a')); }
      if (Number.isNaN(z) || (validTime(z) && validTime(c) && z <= c)) { miss.push('une fin après la coupure'); mark(sel('z')); }
      if (!q.r.trim()) { miss.push('la réplique'); mark(sel('r')); }
      if (!q.e.trim()) { miss.push('le titre de l\'épisode'); mark(sel('e')); }
      if (q.s.trim() && intOrNull(q.s) == null) { miss.push('une saison en chiffres'); mark(sel('s')); }
      if (q.n.trim() && intOrNull(q.n) == null) { miss.push('un numéro en chiffres'); mark(sel('n')); }
      if (miss.length) { problems.push('Réplique ' + (i + 1) + ' : il manque ' + miss.join(', ') + '.'); return; }
      const o = { y: y.id, c: r1(c), r: q.r.trim(), e: q.e.trim() };
      if (validTime(a)) o.a = r1(a);
      if (validTime(z)) o.z = r1(z);
      if (intOrNull(q.s) != null) o.s = intOrNull(q.s);
      if (intOrNull(q.n) != null) o.n = intOrNull(q.n);
      qs.push(o);
    });
    if (problems.length) {
      err.textContent = problems.slice(0, 3).join(' ');
      return;
    }
    if (!qs.length) {
      err.textContent = 'Ajoute au moins une réplique.';
      return;
    }
    const data = { v: 2, s: B.serie.trim(), q: qs };
    if (B.author.trim()) data.a = B.author.trim();
    if (B.title.trim()) data.t = B.title.trim();
    const code = await encodeQuiz(data);
    const url = quizUrl(code);
    out.innerHTML = `<h3>Ton lien est prêt</h3>
      <p class="page-sub">${plural(qs.length, 'réplique')}. Envoie-le, mets-le en bio ou en story.</p>
      ${linkBox(url, 'Mon blindtest ' + data.s + ' : t\'es fan, ou trop fan ?')}
      <a class="btn btn-ghost" style="margin-top:8px" href="${esc(url)}">Tester mon blindtest</a>`;
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* =========================================================
     Jouer à un blindtest
     ========================================================= */
  function newRound(Q) {
    Q.stage = 0;
    Q.F = {};
    Q.T = { r: '', e: '', s: '', n: '' };
    Q.wrong = {};
    Q.tries = {};
    Q.vidErr = '';
    Q.lost = false;
  }

  async function renderQuiz(code) {
    if (!S.quiz || S.quiz.key !== code) {
      S.quiz = { key: code, loading: true };
      paint('<div class="center-msg"><p>Chargement du blindtest…</p></div>', 'q-load');
      try {
        const raw = await decodeQuiz(code);
        const data = cleanQuiz(raw);
        delete raw.c;
        S.quiz = { key: code, raw, data, phase: 'intro', idx: 0, res: [], name: store.get('tf_name', '') || '' };
        newRound(S.quiz);
      } catch (e) {
        S.quiz = { key: code, error: e && (e.message === 'old' || e.message === 'v1') ? e.message : 'bad' };
      }
      if (S.quiz.key !== code || location.hash.replace(/^#\/?/, '') !== 'q/' + code) return;
    }
    const Q = S.quiz;
    if (Q.loading) return;
    if (Q.error) {
      const why = Q.error === 'old' ? 'Ton navigateur est trop ancien pour ouvrir ce blindtest. Essaie avec Chrome ou Safari à jour.'
        : Q.error === 'v1' ? 'Ce lien vient de l\'ancienne version du site, sans extraits vidéo. Demande un nouveau lien à son créateur.'
          : 'Ce lien est cassé ou incomplet. Demande-le à nouveau à la personne qui te l\'a envoyé.';
      paint(`<div class="center-msg"><h1 class="page-title">Lien illisible</h1><p>${why}</p>
        <div class="stack"><a class="btn btn-primary" href="#/">Découvrir Trop Fan</a></div></div>`, 'q-err');
      return;
    }
    if (Q.phase === 'intro') paint(vQuizIntro(), 'q-intro');
    else if (Q.phase === 'end') paint(vQuizEnd(), 'q-end', afterVerdict);
    else paintPlay();
  }

  function vQuizIntro() {
    const { data, name } = S.quiz;
    const title = data.t || ('Le blindtest ' + data.s + (data.a ? ' de ' + data.a : ''));
    const c = data.c;
    return `
      <p class="kicker" style="margin-top:18px">${esc(data.s)}</p>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-sub">${data.a ? 'Par ' + esc(data.a) + ' · ' : ''}${plural(data.q.length, 'scène')} à reconnaître</p>
      ${c ? `<div class="beat"><div><span>Score à battre</span><br><b>${esc(c.n)}</b></div><strong>${c.t != null ? fmtNum(c.t) + ' pts' : c.p + ' %'}</strong></div>` : ''}
      <ol class="how" style="margin-top:20px">
        <li>Tu vois une image de la scène, juste avant une réplique.</li>
        <li>Trouve la réplique qui suit, le titre de l'épisode, la saison et le numéro.</li>
        <li>Bloqué ? Débloque 0,1 s, 0,5 s, 1 s, 2 s, 4 s puis toute la scène. Chaque indice fait baisser les points.</li>
      </ol>
      ${multChips()}
      <label class="field"><span>Ton prénom</span>
        <input data-bind="qname" value="${esc(name)}" placeholder="Pour la carte du verdict" maxlength="24" autocomplete="off" enterkeyhint="go"></label>
      <div class="stack"><button type="button" class="btn btn-primary" data-act="quiz-go">C'est parti, avec le son</button></div>`;
  }

  function paintPlay() {
    paint(`<div id="q-head"></div>
      <div class="yt-embed game" id="yt-slot"><div class="yt-wait">Chargement de la scène…</div></div>
      <div id="q-dyn"></div>`, 'q-play', () => { updatePlay(); loadQuestionVideo(); });
  }
  function loadQuestionVideo() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    PL.free = Q.phase === 'reveal';
    if (PL.p && PL.mode === 'game') { showFrame(q.c, q.y, q.a); return; }
    mountPlayer('yt-slot', q.y, 'game', () => { showFrame(q.c, q.y, q.a); });
  }

  function curPts(F) { return ['r', 'e', 's', 'n'].reduce((a, k) => a + (F[k] ? F[k].pts : 0), 0); }

  function updatePlay() {
    const Q = S.quiz;
    const head = document.getElementById('q-head');
    const dyn = document.getElementById('q-dyn');
    if (!head || !dyn) { paintPlay(); return; }
    const total = Q.data.q.length;
    const done = Q.res.reduce((a, r) => a + (r ? r.pts : 0), 0) + (Q.phase === 'q' ? curPts(Q.F) : 0);
    const prog = (Q.idx + (Q.phase === 'reveal' ? 1 : 0)) / total;
    if (Q.kind === 'infini') {
      const hearts = Array.from({ length: VIES }, (x, k) => '<i class="' + (k < Q.lives ? 'on' : '') + '">♥</i>').join('');
      head.innerHTML = `<div class="q-count"><span>Scène ${Q.idx + 1} · ${LANGS[Q.lang]}</span><span class="lives" aria-label="${plural(Q.lives, 'vie')}">${hearts}</span><span><b class="pts-live">${fmtNum(done)}</b> pts</span></div>`;
    } else {
      head.innerHTML = `<div class="progress"><i style="width:${prog * 100}%"></i></div>
      <div class="q-count"><span>Scène ${Q.idx + 1}/${total}</span><span><b class="pts-live">${fmtNum(done)}</b> pts</span></div>`;
    }
    dyn.innerHTML = Q.phase === 'reveal' ? vPlayReveal() : vPlayQ();
  }

  function vPlayQ() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const stages = stagesFor(q);
    const st = stages[Q.stage];
    const F = Q.F, T = Q.T, W = Q.wrong;
    const last = Q.stage === stages.length - 1;
    if (Q.vidErr) {
      return `<p class="vid-err">${esc(Q.vidErr)}</p>
        <div class="stack"><button type="button" class="btn btn-primary" data-act="q-skipvid">Passer cette scène</button></div>`;
    }
    const chips = stages.map((s, k) => `<button type="button" class="stg${k < Q.stage ? ' used' : ''}${k === Q.stage ? ' cur' : ''}" data-act="stg" data-k="${k}"${k > Q.stage ? ' disabled' : ''} aria-label="${s.label}"><b>${s.label}</b><i>${fmtMult(s.m)}</i></button>`).join('');
    const info = Q.stage === 0
      ? 'L\'image juste avant la réplique.'
      : st.k === 'full' ? 'Toute la scène (' + fmtSec(st.d) + '). Dernière chance.' : 'Extrait de ' + st.label + ' débloqué.';
    const lockBox = (k, label, val, extra) => `<div class="ans locked"><span class="ans-k">${label}</span><p class="ans-v">${esc(val)}</p><span class="ans-pts">${extra} · +${F[k].pts}</span></div>`;
    const fieldR = F.r ? lockBox('r', 'La réplique qui suit', F.r.ans, F.r.score === 2 ? 'Mot pour mot' : 'Presque')
      : `<label class="ans${W.r ? ' wrong' : ''}"><span class="ans-k">La réplique qui suit</span><textarea data-bind="qa" data-f="r" rows="2" maxlength="500" placeholder="Écris-la mot pour mot">${esc(T.r)}</textarea></label>`;
    const fieldE = q.noE ? givenBox(q)
      : F.e ? lockBox('e', 'Le titre de l\'épisode', F.e.ans, 'Trouvé')
        : `<label class="ans${W.e ? ' wrong' : ''}"><span class="ans-k">Le titre de l'épisode</span><input id="a-ep" data-bind="qa" data-f="e" value="${esc(T.e)}" maxlength="200" placeholder="Le titre, à peu près suffit" autocomplete="off" enterkeyhint="done"></label>`;
    const givenSN = !q.noE && q.given ? '<p class="given-note">' + (q.given & 2 ? 'La saison' : 'Le numéro') + ' est déjà écrit' + (q.given & 2 ? 'e' : '') + ' dans le titre de la vidéo : ' + (q.given & 2 ? 'elle ne compte' : 'il ne compte') + ' pas.</p>' : '';
    const small = (k, label) => {
      if (q[k] == null) return '';
      if (F[k]) return `<div class="ans locked"><span class="ans-k">${label}</span><p class="ans-v">${q[k]}</p><span class="ans-pts">+${F[k].pts}</span></div>`;
      return `<label class="ans${W[k] ? ' wrong' : ''}"><span class="ans-k">${label}</span><input data-bind="qa" data-f="${k}" value="${esc(T[k])}" maxlength="3" inputmode="numeric" placeholder="?" autocomplete="off"></label>`;
    };
    const sn = small('s', 'Saison') + small('n', 'Épisode n°');
    const worth = 'Une bonne réponse vaut maintenant : réplique ' + round5(BASE.r * st.m) + (q.noE ? '' : ' · titre ' + round5(BASE.e * st.m)) +
      (q.s != null ? ' · saison ' + round5(BASE.s * st.m) : '') + (q.n != null ? ' · numéro ' + round5(BASE.n * st.m) : '');
    return `
      <div class="stages">${chips}</div>
      <div class="stage-info"><span>${info}</span><button type="button" class="btn btn-sm" data-act="stg" data-k="${Q.stage}">${Q.stage === 0 ? 'Revoir l\'image' : '▶ Réécouter'}</button></div>
      ${fieldR}
      ${fieldE}
      ${sn ? '<div class="sn-row">' + sn + '</div>' : ''}
      ${givenSN}
      <div class="stack">
        <button type="button" class="btn btn-primary" data-act="q-check">Valider</button>
        <button type="button" class="btn btn-ghost" data-act="q-pass">${last ? 'Je donne ma langue au chat' : 'Passer : extrait suivant'}</button>
      </div>
      <p class="worth">${worth}</p>`;
  }

  // épisode déjà écrit dans le titre YouTube : on le donne, il ne rapporte rien
  function givenBox(q) {
    const k = q.given || 0;
    let v = (q.disp || []).join(' · ');
    if ((k & 2) && (k & 4)) v += ' · ' + q.code;
    else if (k & 2) v += ' · saison ' + (+q.code.slice(1, 3));
    return `<div class="ans given"><span class="ans-k">L'épisode</span><p class="ans-v">${esc(v)}</p><span class="ans-pts">Déjà écrit sur la vidéo, ne compte pas</span></div>`;
  }

  function stageTxt(q, k) {
    const st = stagesFor(q)[k];
    return k === 0 ? 'dès l\'image' : st.k === 'full' ? 'avec la scène' : 'à ' + st.label;
  }

  function vPlayReveal() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const F = Q.F;
    const R = Q.res[Q.idx] || { pts: 0, max: qMax(q) };
    const endless = Q.kind === 'infini';
    const last = endless ? Q.lives <= 0 : Q.idx === Q.data.q.length - 1;
    const lifeMsg = endless && Q.lost
      ? '<p class="life-lost">' + (Q.lives > 0 ? 'Une vie en moins. Il t\'en reste ' + Q.lives + '.' : 'Plus de vies : fin de la partie.') + '</p>' : '';
    const epTxt = (q.disp || q.e.split('/')).map((x) => x.trim()).filter(Boolean).join(' · ');
    const row = (cls, k, label, good, txt) => `<div class="verdict-row ${cls}"><span class="vr-k">${label}</span><span class="vr-v ${good}">${txt}</span></div>`;
    let parts = null, mine = '';
    if (F.r) { parts = F.r.parts; mine = F.r.ans; } else if (Q.tries.r) { parts = Q.tries.r.parts; mine = Q.tries.r.ans; }
    const diff = parts ? parts.map((p) => (p.c ? '<span class="' + p.c + '">' + esc(p.w) + '</span>' : esc(p.w))).join(' ') : esc(q.r);
    const lineRow = F.r
      ? row('vr-line', 'r', 'La réplique', F.r.score === 2 ? 'good' : 'mid', (F.r.score === 2 ? 'Mot pour mot' : 'Presque') + ' ' + stageTxt(q, F.r.k) + ' · +' + F.r.pts)
      : row('vr-line', 'r', 'La réplique', 'bad', 'Pas trouvée');
    const epRow = q.noE ? '' : F.e ? row('vr-ep', 'e', 'Le titre', 'good', 'Trouvé ' + stageTxt(q, F.e.k) + ' · +' + F.e.pts) : row('vr-ep', 'e', 'Le titre', 'bad', 'Pas trouvé');
    const snRow = (k, label, val) => (q[k] == null ? '' : F[k]
      ? row('vr-sn', k, label + ' ' + val, 'good', 'Trouvé · +' + F[k].pts)
      : row('vr-sn', k, label + ' ' + val, 'bad', 'Raté'));
    return `
      <p class="reveal-pts"><b>+${fmtNum(R.pts)}</b> pts sur ${fmtNum(R.max)}</p>
      ${lifeMsg}
      ${lineRow}
      <div class="answer">
        ${mine && !F.r ? '<span class="lbl">Ta dernière réponse</span><p class="mine">' + esc(mine) + '</p>' : ''}
        <span class="lbl">La vraie réplique</span>
        <p>${diff}</p>
        ${parts && (!F.r || F.r.score < 2) ? '<p class="legend"><span class="w-ok">en vert</span> : trouvé · <span class="w-miss">souligné</span> : manqué</p>' : ''}
      </div>
      ${epRow}
      <div class="answer"><span class="lbl">L'épisode</span><p>${esc(epTxt)}${q.code ? ' <span class="ep-code">' + q.code + '</span>' : ''}</p></div>
      ${snRow('s', 'Saison', q.s)}
      ${snRow('n', 'Épisode', q.n)}
      <div class="stack">
        <button type="button" class="btn" data-act="q-scene">▶ Revoir la scène avec la réplique</button>
        <button type="button" class="btn btn-primary" data-act="q-next">${last ? 'Voir mon verdict' : 'Scène suivante'}</button>
      </div>`;
  }

  function playStage(k) {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const st = stagesFor(q)[k];
    if (!st) return;
    if (k === 0) { showFrame(q.c); return; }
    const to = st.k === 'full' ? q.c : Math.min(q.c, q.a + st.d);
    showPlayer();
    playSeg(q.a, to);
  }
  function showPlayer() {
    const slot = document.getElementById('yt-slot');
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function quizCheck() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const stages = stagesFor(q);
    const m = stages[Q.stage].m;
    const F = Q.F, T = Q.T;
    Q.wrong = {};
    let tried = false;
    const gained = [];
    if (!F.r && T.r.trim()) {
      tried = true;
      const j = judgeLine(q.r, T.r);
      Q.tries.r = { ans: T.r, parts: j.parts };
      if (j.score) {
        F.r = { score: j.score, pts: round5((j.score === 2 ? BASE.r : BASE.r / 2) * m), k: Q.stage, ans: T.r, parts: j.parts };
        gained.push('r');
      } else Q.wrong.r = 1;
    }
    const code = parseCode(T.e);
    if (!q.noE && !F.e && T.e.trim() && !onlyCode(T.e)) {
      tried = true;
      if (judgeEpisode(q, T.e)) { F.e = { pts: round5(BASE.e * m), k: Q.stage, ans: T.e }; gained.push('e'); } else Q.wrong.e = 1;
    }
    const sv = intOrNull(T.s) != null ? intOrNull(T.s) : code ? code[0] : null;
    const nv = intOrNull(T.n) != null ? intOrNull(T.n) : code ? code[1] : null;
    if (q.s != null && !F.s && sv != null) {
      tried = true;
      if (sv === q.s) { F.s = { pts: round5(BASE.s * m), k: Q.stage }; gained.push('s'); } else Q.wrong.s = 1;
    }
    if (q.n != null && !F.n && nv != null) {
      tried = true;
      if (nv === q.n) { F.n = { pts: round5(BASE.n * m), k: Q.stage }; gained.push('n'); } else Q.wrong.n = 1;
    }
    if (!tried) { toast('Écris une réponse, ou passe à l\'extrait suivant'); return; }
    if (gained.indexOf('r') >= 0) (F.r.score === 2 ? SFX.exact : SFX.close)();
    else if (gained.length) SFX.found();
    else SFX.miss();
    const need = ['r'].concat(q.noE ? [] : ['e']).concat(q.s != null ? ['s'] : []).concat(q.n != null ? ['n'] : []);
    if (need.every((k) => F[k])) { setTimeout(toReveal, 350); updatePlay(); return; }
    const names = { r: 'la réplique', e: 'le titre', s: 'la saison', n: 'le numéro' };
    const msg = gained.length ? 'Bien vu pour ' + gained.map((k) => names[k]).join(', ') + '. ' : '';
    advanceStage(msg);
  }

  function advanceStage(msg) {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const stages = stagesFor(q);
    if (Q.stage >= stages.length - 1) { toReveal(); return; }
    Q.stage++;
    const st = stages[Q.stage];
    toast((msg || '') + (st.k === 'full' ? 'Toute la scène débloquée.' : 'Extrait de ' + st.label + ' débloqué.'));
    updatePlay();
    playStage(Q.stage);
  }

  function toReveal() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const F = Q.F;
    Q.res[Q.idx] = {
      pts: curPts(F), max: qMax(q),
      r: F.r ? F.r.score : 0, e: !!F.e, s: !!F.s, n: !!F.n,
      hasSN: q.s != null && q.n != null
    };
    if (Q.kind) {
      Q.res[Q.idx].epAsk = epAsked(q);
      Q.res[Q.idx].ep = epFound(q, F);
    }
    if (Q.kind === 'infini' && !Q.lost) {
      // une vie en moins si ni la réplique ni l'épisode (titre, ou saison et numéro)
      if (!(F.r || epFound(q, F))) { Q.lost = true; Q.lives = Math.max(0, Q.lives - 1); }
    }
    Q.phase = 'reveal';
    PL.free = true;
    updatePlay();
    showPlayer();
    playSeg(q.a, q.z != null ? q.z : q.c + 5);
  }

  function vQuizEnd() {
    const Q = S.quiz;
    const d = Q.data;
    const t = quizTally(Q.res);
    const who = (Q.name || '').trim() || 'Toi';
    if (!t.n) {
      S.cardData = null;
      return `<div class="center-msg"><h1 class="page-title">Aucune scène jouable</h1><p>Les vidéos de ce blindtest ne peuvent pas être lues ici.</p>
        <div class="stack"><a class="btn btn-primary" href="#/creer">Créer mon blindtest</a></div></div>`;
    }
    let extra = '', foot = '';
    if (d.c) {
      const byPts = d.c.t != null;
      const mine = byPts ? t.pts : t.pct, theirs = byPts ? d.c.t : d.c.p;
      const unit = byPts ? ' pts' : ' %';
      const win = mine > theirs, tie = mine === theirs;
      extra = `<div class="beat ${win ? 'win' : tie ? '' : 'lose'}"><div><span>${win ? 'Tu bats' : tie ? 'Égalité avec' : 'Toujours devant toi'}</span><br><b>${esc(d.c.n)}</b></div><strong>${fmtNum(theirs)}${unit}</strong></div>`;
      foot = win ? 'Bat ' + d.c.n + ' (' + fmtNum(theirs) + unit + ')' : tie ? 'Égalité avec ' + d.c.n : d.c.n + ' reste devant (' + fmtNum(theirs) + unit + ')';
    }
    const tiles = [
      { cls: 's-line', k: 'Répliques', v: t.rf, max: t.n, sub: t.exact + ' mot pour mot' },
      { cls: 's-ep', k: 'Épisodes', v: t.ef, max: t.n, sub: t.snMax ? t.sn + '/' + t.snMax + ' saison et numéro' : (t.ef > 1 ? 'titres trouvés' : 'titre trouvé') }
    ];
    S.cardData = { who, serie: d.s, pct: t.pct, tiles, pts: t.pts, foot };
    S.cardText = 'J\'ai fait ' + fmtNum(t.pts) + ' points au blindtest ' + d.s + ' : « ' + levelFor(t.pct).label + ' ». À toi : ' + quizUrl(Q.key);
    return vVerdict({
      who,
      whoPrefix: 'Le verdict pour',
      serie: d.s,
      pct: t.pct,
      pts: t.pts,
      tiles,
      extra,
      actions: `
        <section>
          <h3>Défie tes potes</h3>
          <p class="page-sub">Le lien garde ton score : pour te battre, il faudra faire plus de ${fmtNum(t.pts)} points.</p>
          <div class="stack" style="margin-top:12px"><button type="button" class="btn btn-pink" data-act="quiz-defi">Créer mon lien défi</button></div>
          <div id="defi-out"></div>
        </section>
        <div class="stack">
          <button type="button" class="btn" data-act="quiz-replay">Rejouer ce blindtest</button>
          <a class="btn btn-ghost" href="#/creer">Créer mon propre blindtest</a>
        </div>`
    });
  }

  async function quizDefi() {
    const Q = S.quiz;
    const t = quizTally(Q.res);
    const who = (Q.name || '').trim() || 'Ton pote';
    const data = Object.assign({}, Q.raw, { c: { n: who.slice(0, 30), p: t.pct, t: t.pts } });
    const code = await encodeQuiz(data);
    const out = document.getElementById('defi-out');
    if (!out) return;
    out.innerHTML = linkBox(quizUrl(code), who + ' a fait ' + fmtNum(t.pts) + ' points au blindtest ' + Q.data.s + '. Tu fais mieux ?');
  }

  /* =========================================================
     Rick et Morty : mode sans fin et défi du jour
     (extraits des chaînes YouTube officielles, lus avec le lecteur YouTube)
     ========================================================= */
  const RM = { vf: null, vo: null };
  const LANGS = { vf: 'VF', vo: 'VO' };
  const DAY0 = Date.UTC(2026, 10, 25);
  const JOUR_N = 5;
  const VIES = 3;

  const getLang = () => (store.get('tf_lang', 'vf') === 'vo' ? 'vo' : 'vf');
  const RM_P = {};
  function loadCat(lang) {
    if (RM[lang]) return Promise.resolve(RM[lang]);
    if (!RM_P[lang]) {
      RM_P[lang] = fetch('data/rm-' + lang + '.json').then((r) => {
        if (!r.ok) throw new Error('cat');
        return r.json();
      }).then((d) => {
        const byEp = {};
        d.q.forEach((x, i) => { (byEp[x[5]] = byEp[x[5]] || []).push(i); });
        d.byEp = byEp;
        d.epList = Object.keys(byEp).sort();
        RM[lang] = d;
        return d;
      }).catch((e) => { RM_P[lang] = null; throw e; });
    }
    return RM_P[lang];
  }
  function catQ(d, i) {
    const x = d.q[i];
    const code = x[5];
    const titles = (d.eps[code] || []).filter(Boolean);
    const disp = titles.slice(0, 2).filter((t, k, arr) => arr.indexOf(t) === k);
    // masque : ce que le titre de la vidéo YouTube montre déjà (1 titre, 2 saison, 4 numéro)
    const k = x[6] || 0;
    return {
      id: i, y: x[0], a: x[1], c: x[2], z: x[3], r: x[4], e: titles.join(' / '), disp, code,
      s: k & 2 ? null : +code.slice(1, 3), n: k & 4 ? null : +code.slice(4, 6), noE: !!(k & 1), given: k
    };
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayNum(key) {
    const p = key.split('-').map(Number);
    return Math.max(1, Math.floor((Date.UTC(p[0], p[1] - 1, p[2]) - DAY0) / 864e5) + 1);
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Les mêmes 5 scènes pour tout le monde ce jour-là, dans 5 épisodes différents
  function dailyPicks(d, key, lang) {
    const R = rng(hashStr('tropfan-rm-' + lang + '-' + key));
    const eps = d.epList.slice();
    const out = [];
    while (out.length < JOUR_N && eps.length) {
      const e = eps.splice(Math.floor(R() * eps.length), 1)[0];
      // de préférence une scène où l'épisode n'est pas écrit sur la vidéo
      const full = d.byEp[e].filter((i) => !d.q[i][6]);
      const ids = full.length ? full : d.byEp[e];
      out.push(ids[Math.floor(R() * ids.length)]);
    }
    return out;
  }
  // Mode sans fin : un épisode au hasard, puis une scène jamais vue de cet épisode
  function nextEndless(Q) {
    const d = Q.cat;
    const seenKey = 'tf_vu_' + Q.lang;
    let seen = new Set(store.get(seenKey, []));
    const used = new Set(Q.data.q.map((q) => q.id));
    const bad = Q.bad || new Set();
    const ok = (i) => !seen.has(i) && !used.has(i) && !bad.has(d.q[i][0]);
    const fresh = (e) => d.byEp[e].some(ok);
    let eps = d.epList.filter(fresh);
    if (!eps.length) {
      seen = new Set();
      eps = d.epList.filter(fresh);
    }
    if (!eps.length) eps = d.epList.slice();
    const last = Q.data.q.length ? Q.data.q[Q.data.q.length - 1].code : null;
    const pool = eps.length > 1 ? eps.filter((e) => e !== last) : eps;
    const e = pool[Math.floor(Math.random() * pool.length)];
    let ids = d.byEp[e].filter(ok);
    if (!ids.length) ids = d.byEp[e].filter((i) => !used.has(i));
    if (!ids.length) ids = d.byEp[e];
    const id = ids[Math.floor(Math.random() * ids.length)];
    seen.add(id);
    store.set(seenKey, Array.from(seen).slice(-4000));
    Q.data.q.push(catQ(d, id));
  }

  async function renderSeries(path) {
    const parts = path.split('?');
    const seg = parts[0].split('/');
    const kind = seg[0], lang = seg[1] === 'vo' ? 'vo' : 'vf';
    if (kind !== 'infini' && kind !== 'jour') { go('#/'); return; }
    store.set('tf_lang', lang);
    const day = todayKey();
    const key = 'rm/' + kind + '/' + lang + (kind === 'jour' ? '/' + day : '') + (parts[1] ? '?' + parts[1] : '');
    if (!S.quiz || S.quiz.key !== key) {
      S.quiz = { key, loading: true };
      paint('<div class="center-msg"><p>Chargement des scènes…</p></div>', 'q-load');
      try {
        const cat = await loadCat(lang);
        const Q = {
          key, kind, lang, cat, day, phase: 'intro', idx: 0, res: [], lives: VIES,
          name: store.get('tf_name', '') || '',
          data: { s: 'Rick et Morty', q: [], c: null }
        };
        if (kind === 'jour') {
          Q.data.q = dailyPicks(cat, day, lang).map((i) => catQ(cat, i));
          Q.done = store.get('tf_jour_' + lang + '_' + day, null);
          if (Q.done) Q.phase = 'end';
        }
        const m = parts[1] && parts[1].match(/(?:^|&)d=([^&]*)/);
        if (m) {
          let raw = m[1];
          try { raw = decodeURIComponent(raw); } catch (e) { /* lien abîmé : on garde le texte brut */ }
          const v = raw.split('~');
          if (v[0] && /^\d{1,7}$/.test(v[1] || '')) Q.data.c = { n: v[0].slice(0, 30), t: +v[1], p: 0 };
        }
        newRound(Q);
        S.quiz = Q;
      } catch (e) {
        S.quiz = { key, error: 'cat' };
      }
      if (S.quiz.key !== key || location.hash.replace(/^#\/?/, '') !== 'rm/' + path) return;
    }
    const Q = S.quiz;
    if (Q.loading) return;
    if (Q.error) {
      paint(`<div class="center-msg"><h1 class="page-title">Scènes indisponibles</h1><p>Impossible de charger les scènes. Vérifie ta connexion puis recharge la page.</p>
        <div class="stack"><a class="btn btn-primary" href="#/">Accueil</a></div></div>`, 'q-err');
      return;
    }
    if (Q.phase === 'intro') paint(vSeriesIntro(), 'q-intro');
    else if (Q.phase === 'end') paint(vSeriesEnd(), 'q-end', afterVerdict);
    else paintPlay();
  }

  function langSeg(kind, lang) {
    return '<div class="seg lang-seg">' + ['vf', 'vo'].map((l) => '<a class="' + (l === lang ? 'on' : '') + '" href="#/rm/' + kind + '/' + l + '">' + LANGS[l] + '</a>').join('') + '</div>';
  }

  function vSeriesIntro() {
    const Q = S.quiz;
    const c = Q.data.c;
    const best = store.get('tf_best_' + Q.lang, null);
    const n = Q.cat.q.length;
    const endless = Q.kind === 'infini';
    return `
      <p class="kicker" style="margin-top:18px">Rick et Morty · ${LANGS[Q.lang]}</p>
      <h1 class="page-title">${endless ? 'Mode sans fin' : 'Défi du jour n°' + dayNum(Q.day)}</h1>
      <p class="page-sub">${endless
        ? fmtNum(n) + ' scènes officielles en ' + LANGS[Q.lang] + ', tirées au hasard. Tu as ' + VIES + ' vies.'
        : JOUR_N + ' scènes, les mêmes pour tout le monde aujourd\'hui. Un seul essai.'}</p>
      ${langSeg(Q.kind, Q.lang)}
      ${c ? `<div class="beat"><div><span>Score à battre</span><br><b>${esc(c.n)}</b></div><strong>${fmtNum(c.t)} pts</strong></div>` : ''}
      ${endless && best ? `<p class="rm-best">Ton record en ${LANGS[Q.lang]} : <b>${fmtNum(best.pts)} pts</b> (${plural(best.n, 'scène')})</p>` : ''}
      <ol class="how" style="margin-top:20px">
        <li>Tu vois une image de la scène, juste avant une réplique.</li>
        <li>Trouve la réplique qui suit, le titre de l'épisode, la saison et le numéro.</li>
        <li>Bloqué ? Débloque 0,1 s, 0,5 s, 1 s, 2 s, 4 s puis toute la scène. Chaque indice fait baisser les points.</li>
        <li>Quand l'épisode est déjà écrit dans le titre de la vidéo YouTube, on te le donne : seule la réplique compte.</li>
        ${endless ? '<li>Une vie en moins quand tu ne trouves ni la réplique ni l\'épisode.</li>' : ''}
      </ol>
      ${multChips()}
      <label class="field"><span>Ton prénom</span>
        <input data-bind="qname" value="${esc(Q.name)}" placeholder="Pour la carte du verdict" maxlength="24" autocomplete="off" enterkeyhint="go"></label>
      <div class="stack"><button type="button" class="btn btn-primary" data-act="quiz-go">C'est parti, avec le son</button></div>
      <p class="small-note">Extraits officiels (${Q.lang === 'vf' ? 'Adult Swim France' : 'chaîne Rick and Morty d\'Adult Swim'}), lus sur YouTube. Les répliques ${Q.lang === 'vf' ? 'ont été transcrites automatiquement : une petite faute peut traîner' : 'viennent des transcriptions des fans'}.</p>`;
  }

  function dayGrid(res) {
    const line = res.map((r) => (!r || r.skipped ? '▫️' : r.r === 2 ? '🟩' : r.r === 1 ? '🟨' : '⬛')).join('');
    const ep = res.map((r) => (!r || r.skipped || r.epAsk === false ? '▫️' : r.ep ? '🟩' : r.s || r.n ? '🟨' : '⬛')).join('');
    return { line, ep };
  }
  function untilTomorrow() {
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const m = Math.max(1, Math.round((t - now) / 60000));
    return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
  }

  function vSeriesEnd() {
    const Q = S.quiz;
    const lang = LANGS[Q.lang];
    const who = (Q.name || '').trim() || 'Toi';
    const base = location.origin + location.pathname;
    let t, grid;
    if (Q.kind === 'jour' && Q.done && !Q.res.length) {
      t = Q.done.t;
      grid = Q.done.g;
    } else {
      t = quizTally(Q.res);
      if (Q.kind === 'jour') {
        grid = dayGrid(Q.res);
        if (!Q.done) {
          Q.done = { t, g: grid };
          store.set('tf_jour_' + Q.lang + '_' + Q.day, Q.done);
        }
      }
    }
    const tiles = [
      { cls: 's-line', k: 'Répliques', v: t.rf, max: t.n, sub: t.exact + ' mot pour mot' },
      { cls: 's-ep', k: 'Épisodes', v: t.ef, max: t.eMax, sub: t.snMax ? t.sn + '/' + t.snMax + ' saison et numéro' : 'reconnus', csub: t.snMax ? t.sn + ' saison et numéro' : 'reconnus' }
    ];
    let extra = '', foot = '';
    if (Q.kind === 'infini') {
      if (!Q.saved) {
        const best = store.get('tf_best_' + Q.lang, null);
        Q.prevBest = best;
        Q.record = t.pts > 0 && (!best || t.pts > best.pts);
        if (Q.record) store.set('tf_best_' + Q.lang, { pts: t.pts, n: t.n });
        Q.saved = true;
      }
      extra = Q.record ? '<p class="rm-best record">Nouveau record en ' + lang + ' !</p>'
        : Q.prevBest ? '<p class="rm-best">Ton record en ' + lang + ' : <b>' + fmtNum(Q.prevBest.pts) + ' pts</b></p>' : '';
      foot = plural(t.n, 'scène') + ' tenue' + (t.n > 1 ? 's' : '') + ' en ' + lang;
      if (Q.data.c) {
        const win = t.pts > Q.data.c.t, tie = t.pts === Q.data.c.t;
        extra += `<div class="beat ${win ? 'win' : tie ? '' : 'lose'}"><div><span>${win ? 'Tu bats' : tie ? 'Égalité avec' : 'Toujours devant toi'}</span><br><b>${esc(Q.data.c.n)}</b></div><strong>${fmtNum(Q.data.c.t)} pts</strong></div>`;
        foot = win ? 'Bat ' + Q.data.c.n + ' (' + fmtNum(Q.data.c.t) + ' pts)' : foot;
      }
      S.cardText = 'J\'ai tenu ' + plural(t.n, 'scène') + ' de Rick et Morty en ' + lang + ' : ' + fmtNum(t.pts) + ' points. Bats-moi : ' + base + '#/rm/infini/' + Q.lang;
    } else {
      foot = 'Défi du jour n°' + dayNum(Q.day) + ' en ' + lang;
      S.cardText = shareDayText(Q, t, grid);
      extra = `<pre class="grid">${esc(grid.line)}\n${esc(grid.ep)}</pre><p class="rm-best">Prochain défi dans ${untilTomorrow()}</p>`;
    }
    S.cardData = { who, serie: 'Rick et Morty ' + lang, pct: t.pct, tiles, pts: t.pts, foot };
    const other = Q.lang === 'vf' ? 'vo' : 'vf';
    return vVerdict({
      who,
      whoPrefix: 'Le verdict pour',
      serie: 'Rick et Morty · ' + lang + (Q.kind === 'jour' ? ' · Défi du jour n°' + dayNum(Q.day) : ' · Mode sans fin'),
      pct: t.pct,
      pts: t.pts,
      tiles,
      extra,
      actions: Q.kind === 'infini' ? `
        <section>
          <h3>Défie tes potes</h3>
          <p class="page-sub">Le lien affiche ton score à battre : ${fmtNum(t.pts)} points.</p>
          <div class="stack" style="margin-top:12px"><button type="button" class="btn btn-pink" data-act="rm-defi">Créer mon lien défi</button></div>
          <div id="defi-out"></div>
        </section>
        <div class="stack">
          <button type="button" class="btn btn-primary" data-act="quiz-replay">Rejouer</button>
          <a class="btn" href="#/rm/jour/${Q.lang}">Défi du jour</a>
          <a class="btn btn-ghost" href="#/rm/infini/${other}">Essayer en ${LANGS[other]}</a>
        </div>` : `
        <div class="stack">
          <button type="button" class="btn btn-pink" data-act="rm-share-day">Partager mon résultat</button>
          <a class="btn btn-primary" href="#/rm/infini/${Q.lang}">Mode sans fin</a>
          <a class="btn btn-ghost" href="#/rm/jour/${other}">Défi du jour en ${LANGS[other]}</a>
        </div>`
    });
  }
  function shareDayText(Q, t, grid) {
    return 'Trop Fan · Rick et Morty ' + LANGS[Q.lang] + ' · Défi n°' + dayNum(Q.day) + '\n' +
      'Répliques ' + grid.line + '\nÉpisodes  ' + grid.ep + '\n' + fmtNum(t.pts) + ' points\n' +
      location.origin + location.pathname + '#/rm/jour/' + Q.lang;
  }
  async function shareDay() {
    const txt = S.cardText;
    if (navigator.share) {
      try { await navigator.share({ text: txt }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(txt); toast('Résultat copié, colle-le où tu veux'); } catch (e) { toast('Copie impossible sur ce navigateur'); }
  }
  function rmDefi() {
    const Q = S.quiz;
    const t = quizTally(Q.res);
    const who = ((Q.name || '').trim() || 'Ton pote').replace(/[~&#?]/g, '').slice(0, 30);
    const url = location.origin + location.pathname + '#/rm/infini/' + Q.lang + '?d=' + encodeURIComponent(who + '~' + t.pts);
    const out = document.getElementById('defi-out');
    if (out) out.innerHTML = linkBox(url, who + ' a fait ' + fmtNum(t.pts) + ' points sur Rick et Morty en ' + LANGS[Q.lang] + '. Tu fais mieux ?');
  }

  /* =========================================================
     Actions (délégation des clics)
     ========================================================= */
  const ACT = {
    sound(b) {
      S.sound = !S.sound;
      store.set('tf_sound', S.sound);
      b.setAttribute('aria-pressed', String(S.sound));
      b.setAttribute('aria-label', S.sound ? 'Couper le son' : 'Activer le son');
      if (S.sound) SFX.found();
    },
    'pick-serie'(b) {
      S.setup.serie = b.dataset.v;
      store.set('tf_setup', S.setup);
      const f = document.getElementById('f-serie');
      if (f) { f.value = b.dataset.v; f.classList.remove('err-field'); }
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
      const er = document.getElementById('setup-err');
      if (er) er.textContent = '';
    },
    'pl-add'() {
      if (S.setup.players.length >= 4) return;
      S.setup.players.push('');
      store.set('tf_setup', S.setup);
      rerender();
      const ins = document.querySelectorAll('[data-bind="player"]');
      if (ins.length) ins[ins.length - 1].focus();
    },
    'pl-del'(b) {
      S.setup.players.splice(+b.dataset.i, 1);
      if (!S.setup.players.length) S.setup.players.push('');
      store.set('tf_setup', S.setup);
      rerender();
    },
    'set-total'(b) { S.setup.total = +b.dataset.v; store.set('tf_setup', S.setup); rerender(); },
    'set-chrono'(b) { S.setup.chrono = +b.dataset.v; store.set('tf_setup', S.setup); rerender(); },
    'duel-start': duelStart,
    chrono: chronoToggle,
    judge(b) {
      const d = S.duel;
      const k = b.dataset.k, v = +b.dataset.v;
      d.rounds[d.cur][k] = v;
      saveDuel();
      if (k === 'r') (v === 2 ? SFX.exact : v === 1 ? SFX.close : SFX.miss)();
      else (v ? SFX.found : SFX.miss)();
      S.bump = k;
      rerender();
    },
    next() {
      const d = S.duel;
      const R = d.rounds[d.cur];
      if (R.r == null || R.e == null) return;
      if (d.cur >= d.rounds.length - 1) { duelFinish(); return; }
      d.cur++;
      saveDuel();
      S.route = null;
      render();
    },
    prev() {
      const d = S.duel;
      if (d.cur === 0) return;
      d.cur--;
      saveDuel();
      S.route = null;
      render();
    },
    'duel-stop'() {
      const d = S.duel;
      const any = d.rounds.some((r) => r.r != null && r.e != null);
      if (!any) {
        if (!confirm('Aucune manche notée. Quitter le duel ?')) return;
        S.duel = null;
        store.del('tf_duel');
        go('#/');
        return;
      }
      if (!confirm('Arrêter ici et voir le verdict ?')) return;
      duelFinish();
    },
    'duel-replay'() {
      const d = S.duel;
      if (d) {
        S.setup = { serie: d.serie, players: d.players.slice(), total: d.total, chrono: d.chrono };
        store.set('tf_setup', S.setup);
      }
      duelStart();
    },
    'card-share': cardShare,
    'card-dl': cardDownload,
    copy: copyLink,
    'share-link': shareLink,

    // éditeur
    'q-add'() {
      syncDraftFromDom();
      draft().qs.push(newQ());
      saveDraft();
      rerender();
      const cards = document.querySelectorAll('.qcard');
      const lastCard = cards[cards.length - 1];
      if (lastCard) {
        lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const inp = lastCard.querySelector('input');
        if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 350);
      }
    },
    'q-del'(b) {
      syncDraftFromDom();
      const i = +b.dataset.i;
      const q = draft().qs[i];
      const filled = q && Object.keys(q).some((k) => String(q[k]).trim());
      if (filled && !confirm('Supprimer la réplique ' + (i + 1) + ' ?')) return;
      draft().qs.splice(i, 1);
      saveDraft();
      rerender();
    },
    'ed-open'(b) { openEditor(+b.dataset.i); },
    't-now'(b) {
      const i = +b.dataset.i;
      const p = editorFor(i);
      if (!p) return;
      const t = r1(p.getCurrentTime() || 0);
      setQField(i, b.dataset.f, fmtClock(t));
      const names = { c: 'Coupure', a: 'Début', z: 'Fin' };
      toast(names[b.dataset.f] + ' réglée à ' + fmtClock(t));
    },
    't-nudge'(b) {
      const i = +b.dataset.i;
      const q = draft().qs[i];
      const c = parseClock(q.c);
      if (!validTime(c)) { toast('Règle d\'abord la coupure'); return; }
      const nc = Math.max(0, r1(c + +b.dataset.d));
      setQField(i, 'c', fmtClock(nc));
      if (PL.p && PL.mode === 'edit' && PL.card === i) { try { PL.p.pauseVideo(); PL.p.seekTo(nc, true); } catch (e) { /* rien */ } }
    },
    't-test'(b) {
      const i = +b.dataset.i;
      const p = editorFor(i);
      if (!p) return;
      const q = draft().qs[i];
      const c = parseClock(q.c);
      if (!validTime(c)) { toast('Règle d\'abord la coupure'); return; }
      if (b.dataset.k === 'cut') playSeg(Math.max(0, c - 3), c);
      else { const z = parseClock(q.z); playSeg(c, validTime(z) && z > c ? z : c + 4); }
    },
    build,
    'draft-reset'() {
      if (!confirm('Effacer tout le blindtest en cours ?')) return;
      S.draft = null;
      store.del('tf_draft2');
      rerender();
    },

    // partie
    'quiz-go'() {
      const Q = S.quiz;
      if (!Q || !Q.data) return;
      if (Q.kind === 'jour' && Q.done) return;
      audio();
      Q.phase = 'q';
      Q.idx = 0;
      Q.res = [];
      if (Q.kind === 'infini') {
        Q.data.q = [];
        Q.lives = VIES;
        Q.saved = false;
        nextEndless(Q);
      }
      newRound(Q);
      S.route = null;
      paintPlay();
    },
    stg(b) {
      const Q = S.quiz;
      const k = +b.dataset.k;
      if (k > Q.stage) return;
      playStage(k);
    },
    'q-check': quizCheck,
    'q-pass'() { advanceStage(''); },
    'q-scene'() {
      const q = S.quiz.data.q[S.quiz.idx];
      showPlayer();
      playSeg(q.a, q.z != null ? q.z : q.c + 5);
    },
    'q-skipvid'() {
      const Q = S.quiz;
      Q.res[Q.idx] = { pts: 0, max: 0, skipped: true };
      if (Q.kind) (Q.bad = Q.bad || new Set()).add(Q.data.q[Q.idx].y);
      ACT['q-next']();
    },
    'q-next'() {
      const Q = S.quiz;
      segStop();
      const over = Q.kind === 'infini' ? Q.lives <= 0 : Q.idx >= Q.data.q.length - 1;
      if (over) {
        Q.phase = 'end';
        SFX.win();
        destroyPlayer();
        S.route = null;
        paint(Q.kind ? vSeriesEnd() : vQuizEnd(), 'q-end', afterVerdict);
        return;
      }
      if (Q.kind === 'infini') nextEndless(Q);
      Q.idx++;
      Q.phase = 'q';
      newRound(Q);
      PL.free = false;
      updatePlay();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      loadQuestionVideo();
    },
    'quiz-replay'() {
      const Q = S.quiz;
      if (Q.kind === 'infini') { ACT['quiz-go'](); return; }
      if (Q.kind === 'jour') return;
      Q.phase = 'q';
      Q.idx = 0;
      Q.res = [];
      newRound(Q);
      S.route = null;
      paintPlay();
    },
    'quiz-defi': quizDefi,
    'rm-defi': rmDefi,
    'rm-share-day': shareDay,
    'rm-lang'(b) {
      store.set('tf_lang', b.dataset.v === 'vo' ? 'vo' : 'vf');
      paint(vHome(), 'home');
    }
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = ACT[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b, e); }
  });
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.bind === 'qa' && t.tagName === 'INPUT') { e.preventDefault(); quizCheck(); }
    else if (t.dataset.bind === 'qname') { e.preventDefault(); ACT['quiz-go'](); }
  });
  window.addEventListener('hashchange', () => { S.route = null; render(); });

  const sb = document.querySelector('.snd');
  if (sb) {
    sb.setAttribute('aria-pressed', String(S.sound));
    sb.setAttribute('aria-label', S.sound ? 'Couper le son' : 'Activer le son');
  }

  // Exposé pour les essais automatiques uniquement
  window.__tropfan = { judgeLine, judgeEpisode, parseYT, parseClock, fmtClock, parseCode, onlyCode, stagesFor, encodeQuiz, decodeQuiz, PL };

  render();
})();
