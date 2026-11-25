'use strict';
(function () {
  const app = document.getElementById('app');

  /* =========================================================
     Outils
     ========================================================= */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v) => (v == null || v === '' || !Number.isFinite(+v) || +v < 0 ? null : Math.floor(+v));
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');

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
    { min: 90, label: 'Inquiétant', line: 'Ça commence sérieusement à faire peur.' },
    { min: 70, label: 'Trop fan', line: 'Connaît les répliques mieux que les scénaristes.' },
    { min: 45, label: 'Vrai fan', line: 'Solide. Mais on a vu plus obsédé.' },
    { min: 20, label: 'Spectateur du dimanche', line: "Connaît le générique, c'est un début." },
    { min: 0, label: 'Touriste', line: 'A vu deux épisodes chez un pote.' }
  ];
  const levelFor = (p) => LEVELS.find((l) => p >= l.min);

  const S = {
    sound: store.get('tf_sound', true),
    setup: store.get('tf_setup', null) || { serie: '', players: [''], total: 10, chrono: 10 },
    duel: store.get('tf_duel', null),
    draft: store.get('tf_draft', null),
    quiz: null,
    route: null,
    bump: null,
    card: null,
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
     Comparaison des réponses
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
  // Deux mots sont "pareils" s'ils sont identiques, ou à une faute de frappe près pour les mots longs.
  function tokEq(a, b) {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 5) return false;
    return charRatio(a, b) >= 0.8;
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
      const chSim = charRatio(et.join(' '), A.join(' '));
      hit = lcsMatched(et, A, tokEq);
      // "Presque" aussi quand près de la moitié de la réplique est juste, dans l'ordre, sans mots inventés
      const coverage = hit.size / et.length;
      const precision = hit.size / A.length;
      score = d === 0 ? 2 : (wordSim >= 0.6 || chSim >= 0.75 || (coverage >= 0.45 && precision >= 0.8)) ? 1 : 0;
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

  function parseCode(s) {
    const t = normText(s);
    const m = t.match(/\bs\s*0*(\d{1,2})\s*[-.:]?\s*e(?:p|pisode)?\s*0*(\d{1,3})\b/) ||
      t.match(/\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/) ||
      t.match(/saison\s*0*(\d{1,2})\D{1,14}?(?:episode|ep|e)\s*0*(\d{1,3})/);
    return m ? [+m[1], +m[2]] : null;
  }

  const STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'a', 'au', 'aux', 'en', 'the', 'of', 'and', 'episode', 'ep']);

  function judgeEpisode(q, answer) {
    const ans = String(answer || '').trim();
    if (!ans) return 0;
    if (q.n) {
      const ec = parseCode(q.n), ac = parseCode(ans);
      if (ec && ac && ec[0] === ac[0] && ec[1] === ac[1]) return 1;
    }
    const tt = toks(q.e), at = toks(ans);
    if (!tt.length || !at.length) return 0;
    const tj = tt.join(' '), aj = at.join(' ');
    if (tj === aj || charRatio(tj, aj) >= 0.75) return 1;
    const sig = tt.filter((t) => !STOP.has(t));
    const sigA = at.filter((t) => !STOP.has(t));
    if (sig.length && sigA.length) {
      if (charRatio(sig.join(' '), sigA.join(' ')) >= 0.8) return 1;
      const hits = sig.filter((t) => sigA.some((a) => tokEq(t, a))).length;
      if (hits / sig.length >= 0.75 && sigA.length <= sig.length + 3) return 1;
    }
    return 0;
  }

  /* =========================================================
     YouTube et temps
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
  function parseClock(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) return +v;
    const m = v.match(/^(\d+)[:h'.](\d{1,2})(?:[:'.](\d{1,2}))?$/);
    if (!m) return NaN;
    return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  }
  const fmtClock = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

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
    if (!d || !Array.isArray(d.q)) throw new Error('vide');
    const q = d.q.slice(0, 40).map((x) => ({
      p: str(x.p, 400),
      r: str(x.r, 500),
      e: str(x.e, 140),
      n: str(x.n, 24),
      y: /^[A-Za-z0-9_-]{11}$/.test(x.y || '') ? x.y : '',
      st: num(x.st),
      en: num(x.en)
    })).filter((x) => x.r && x.e);
    if (!q.length) throw new Error('vide');
    const c = d.c && typeof d.c.n === 'string' && d.c.n.trim() ? { n: str(d.c.n, 30), p: clamp(Math.round(+d.c.p || 0), 0, 100) } : null;
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
  function rerender() { S.route = S.route || ''; render(true); }

  function render() {
    stopChrono();
    const h = location.hash.replace(/^#\/?/, '');
    if (h.indexOf('q/') === 0) { renderQuiz(h.slice(2)); return; }
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
      case 'creer': paint(vBuilder(), 'creer', afterBuilder); break;
      default: go('#/');
    }
  }

  let toastT = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* =========================================================
     Accueil
     ========================================================= */
  function vHome() {
    const d = S.duel;
    const resume = d && !d.done ? '<a class="resume" href="#/duel/jeu"><span>Reprendre le duel en cours · ' + esc(d.serie) + '</span><span aria-hidden="true">→</span></a>' : '';
    const bounds = [[90, 100], [70, 89], [45, 69], [20, 44], [0, 19]];
    return `
      <section class="hero">
        <p class="kicker">Le blindtest des répliques</p>
        <h1>T'es fan,<br>ou <em>trop fan</em>&nbsp;?</h1>
        <p class="lead">Un extrait, une réplique à réciter mot pour mot, un épisode à nommer. Deux scores, un verdict.</p>
      </section>
      ${resume}
      <section class="modes">
        <a class="mode mode-duel" href="#/duel">
          <span class="mode-tag">À deux, un seul téléphone</span>
          <h2>Duel en vrai</h2>
          <p>Tu lances un extrait, l'autre récite la réplique et donne l'épisode. Tu notes, le site compte les points et rend le verdict.</p>
          <span class="mode-cta">Lancer un duel</span>
        </a>
        <a class="mode mode-quiz" href="#/creer">
          <span class="mode-tag">Chacun sur son écran</span>
          <h2>Quiz à partager</h2>
          <p>Écris tes répliques, envoie le lien. Tes potes ou tes abonnés jouent seuls et doivent battre ton score.</p>
          <span class="mode-cta">Créer mon quiz</span>
        </a>
      </section>
      <section>
        <h3>Le barème</h3>
        <div class="rule-grid">
          <div class="rule r-line"><span class="rule-name">La réplique</span>
            <ul><li><b>+2</b> mot pour mot</li><li><b>+1</b> presque</li><li><b>0</b> ratée</li></ul></div>
          <div class="rule r-ep"><span class="rule-name">L'épisode</span>
            <ul><li><b>+1</b> trouvé</li><li><b>0</b> raté</li></ul></div>
        </div>
        <h3>Le verdict</h3>
        <ol class="scale">
          ${LEVELS.map((l, i) => '<li><b>' + esc(l.label) + '</b><span>' + bounds[i][0] + ' à ' + bounds[i][1] + ' %</span></li>').join('')}
        </ol>
      </section>
      <p class="foot">Trop Fan n'est lié à aucune série, chaîne ou plateforme. Aucun extrait n'est hébergé ici : les répliques sont écrites par les joueurs et les vidéos restent sur YouTube. Pas de compte, pas de cookies.</p>`;
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
      document.getElementById('setup-err').textContent = 'Choisis une série pour commencer.';
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
    const d = S.duel;
    d.done = true;
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
     Duel : verdict
     ========================================================= */
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
    S.cardData = { who: top.name, serie: d.serie, t: top, foot };
    S.cardText = top.name + ' est « ' + levelFor(top.pct).label + ' » de ' + d.serie + ' (' + top.pct + ' %). Fais le test : ' + location.origin + location.pathname;
    return vVerdict({
      who: top.name,
      whoPrefix: multi ? 'Vainqueur du duel' : 'Le verdict pour',
      serie: d.serie,
      t: top,
      extra,
      actions: `<div class="stack">
          <button type="button" class="btn" data-act="duel-replay">Rejouer avec les mêmes réglages</button>
          <a class="btn btn-ghost" href="#/creer">Créer un quiz pour tes abonnés</a>
        </div>`
    });
  }

  function vVerdict(o) {
    const L = levelFor(o.t.pct);
    return `
      <section class="verdict">
        <p class="kicker">${esc(o.serie)}</p>
        <p class="v-who">${esc(o.whoPrefix)} <b>${esc(o.who)}</b></p>
        <h1 class="v-level">${esc(L.label)}</h1>
        <p class="v-line">${esc(L.line)}</p>
        <div class="ring" id="ring" data-p="${o.t.pct}"><span><b>${o.t.pct}</b> %</span></div>
        <div class="stats">
          <div class="stat s-line"><span class="stat-k">Répliques</span><b>${o.t.rp}<small>/${o.t.rpMax}</small></b><span class="stat-sub">${o.t.exact} mot pour mot · ${o.t.close} presque</span></div>
          <div class="stat s-ep"><span class="stat-k">Épisodes</span><b>${o.t.ep}<small>/${o.t.epMax}</small></b><span class="stat-sub">${o.t.ep > 1 ? 'trouvés' : 'trouvé'}</span></div>
        </div>
        ${o.extra || ''}
      </section>
      ${o.before || ''}
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
    const L = levelFor(o.t.pct);

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
    g.font = '600 34px ' + F;
    g.fillStyle = '#9B9AA5';
    g.textAlign = 'right';
    g.fillText(SITE, W - X, 146);
    g.textAlign = 'left';

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
    const cx = W / 2, cy = Math.max(y + 250, 1210), R = 168;
    g.lineWidth = 34;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    if (o.t.pct > 0) {
      g.strokeStyle = '#C9F23D';
      g.beginPath();
      g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (o.t.pct / 100));
      g.stroke();
    }
    g.textAlign = 'center';
    g.fillStyle = '#F3F2EE';
    g.font = '800 128px ' + F;
    const pw = g.measureText(String(o.t.pct)).width;
    g.font = '700 54px ' + F;
    const uw = g.measureText(' %').width;
    g.textAlign = 'left';
    const sx = cx - (pw + uw) / 2;
    g.font = '800 128px ' + F;
    g.fillText(String(o.t.pct), sx, cy + 44);
    g.font = '700 54px ' + F;
    g.fillStyle = '#9B9AA5';
    g.fillText(' %', sx + pw, cy + 44);

    // tuiles
    const ty = cy + R + 80, tw = (CW - 28) / 2, th = 236;
    const tile = (tx, col, bg, k, v, sub) => {
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
      g.fillText(k, tx + 34, ty + 62);
      g.font = '800 96px ' + F;
      g.fillStyle = '#F3F2EE';
      g.fillText(v, tx + 34, ty + 160);
      g.font = '500 32px ' + F;
      g.fillStyle = '#9B9AA5';
      g.fillText(sub, tx + 34, ty + 208, tw - 60);
    };
    tile(X, '#C9F23D', 'rgba(201,242,61,0.08)', 'RÉPLIQUES', o.t.rp + '/' + o.t.rpMax, o.t.exact + ' mot pour mot');
    tile(X + tw + 28, '#FF6FA0', 'rgba(255,111,160,0.08)', 'ÉPISODES', o.t.ep + '/' + o.t.epMax, o.t.ep > 1 ? 'trouvés' : 'trouvé');

    // ligne bonus (défi, classement)
    if (o.foot) {
      g.font = '700 38px ' + F;
      g.fillStyle = '#F3F2EE';
      g.textAlign = 'center';
      g.fillText(o.foot, W / 2, ty + th + 82, CW);
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
    g.fillText(ft, fx, H - 74);
    g.font = '800 ' + fs + 'px ' + F;
    g.fillStyle = '#C9F23D';
    g.fillText(SITE, fx + fw, H - 74);
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
     Créer un quiz
     ========================================================= */
  const newQ = () => ({ p: '', r: '', e: '', n: '', y: '', st: '', en: '' });
  function draft() {
    if (!S.draft) S.draft = { serie: '', author: '', title: '', qs: [newQ(), newQ(), newQ()] };
    return S.draft;
  }
  let draftT = null;
  function saveDraft() {
    clearTimeout(draftT);
    draftT = setTimeout(() => store.set('tf_draft', S.draft), 300);
  }

  function vBuilder() {
    const B = draft();
    return `
      <p class="kicker" style="margin-top:18px">Mode quiz</p>
      <h1 class="page-title">Crée ton quiz</h1>
      <p class="page-sub">Pour chaque réplique : ce que le joueur voit, la réplique exacte à trouver et l'épisode. Tout tient dans le lien, rien n'est stocké chez nous.</p>

      <label class="field"><span>La série</span>
        <input id="b-serie" data-bind="b" data-f="serie" value="${esc(B.serie)}" placeholder="Ex. : Rick et Morty" maxlength="40" autocomplete="off"></label>
      <div class="row2 even">
        <label class="field"><span>Ton pseudo</span>
          <input data-bind="b" data-f="author" value="${esc(B.author)}" placeholder="@toncompte" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>Titre (optionnel)</span>
          <input data-bind="b" data-f="title" value="${esc(B.title)}" placeholder="Le blindtest de…" maxlength="90" autocomplete="off"></label>
      </div>

      <div id="qlist">${B.qs.map(vQCard).join('')}</div>
      ${B.qs.length < 30 ? '<button type="button" class="btn btn-ghost add" data-act="q-add">+ Ajouter une réplique</button>' : ''}

      <p class="form-err" id="build-err"></p>
      <div class="stack"><button type="button" class="btn btn-pink" data-act="build">Générer le lien du quiz</button></div>
      <div id="build-out"></div>
      <p class="tip"><b>Astuce :</b> fais jouer ton quiz à quelqu'un. À la fin, son bouton « Créer mon lien défi » donne un lien avec son score à battre. C'est celui-là qu'il faut poster.</p>
      <button type="button" class="link-btn" data-act="draft-reset">Tout effacer</button>`;
  }

  function vQCard(q, i) {
    const yt = ytMsg(q);
    return `
      <div class="qcard" data-qi="${i}">
        <div class="qcard-h"><span>Réplique ${i + 1}</span>${draft().qs.length > 1 ? '<button type="button" data-act="q-del" data-i="' + i + '">Supprimer</button>' : ''}</div>
        <label class="field"><span>Ce que le joueur voit</span>
          <textarea data-bind="q" data-f="p" data-i="${i}" rows="2" maxlength="400" placeholder="Le début de la réplique, ou qui parle et dans quelle scène">${esc(q.p)}</textarea></label>
        <label class="field"><span>La réplique à trouver, mot pour mot</span>
          <textarea data-bind="q" data-f="r" data-i="${i}" rows="2" maxlength="500" placeholder="La suite exacte, telle qu'elle est dite">${esc(q.r)}</textarea></label>
        <div class="row2">
          <label class="field"><span>L'épisode</span>
            <input data-bind="q" data-f="e" data-i="${i}" value="${esc(q.e)}" maxlength="140" placeholder="Titre de l'épisode" autocomplete="off"></label>
          <label class="field"><span>Numéro</span>
            <input data-bind="q" data-f="n" data-i="${i}" value="${esc(q.n)}" maxlength="24" placeholder="S1E5" autocomplete="off"></label>
        </div>
        <details class="yt"${q.y ? ' open' : ''}>
          <summary>Extrait YouTube (optionnel)</summary>
          <label class="field"><span>Lien de la vidéo</span>
            <input data-bind="q" data-f="y" data-i="${i}" value="${esc(q.y)}" placeholder="https://youtu.be/…" inputmode="url" autocomplete="off"></label>
          <div class="row2 even">
            <label class="field"><span>Début</span>
              <input data-bind="q" data-f="st" data-i="${i}" value="${esc(q.st)}" placeholder="1:23" autocomplete="off"></label>
            <label class="field"><span>Fin</span>
              <input data-bind="q" data-f="en" data-i="${i}" value="${esc(q.en)}" placeholder="1:31" autocomplete="off"></label>
          </div>
          <p class="yt-msg ${yt.c}" id="ytmsg-${i}">${esc(yt.t)}</p>
        </details>
      </div>`;
  }

  function ytMsg(q) {
    if (!q.y.trim()) return { c: '', t: "Coupe l'extrait juste avant la réplique : le joueur doit la trouver seul." };
    const y = parseYT(q.y);
    if (!y) return { c: 'bad', t: 'Lien YouTube non reconnu.' };
    const st = parseClock(q.st), en = parseClock(q.en);
    if (Number.isNaN(st) || Number.isNaN(en)) return { c: 'bad', t: 'Temps au format 1:23 ou en secondes.' };
    const s = st != null ? st : (y.t || 0);
    if (en != null && en <= s) return { c: 'bad', t: 'La fin doit venir après le début.' };
    return { c: 'ok', t: 'Extrait reconnu : de ' + fmtClock(s) + (en != null ? ' à ' + fmtClock(en) : " jusqu'au bout") + '.' };
  }

  function afterBuilder() { /* rien à faire, les champs sont reliés par délégation */ }

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
      q[el.dataset.f] = el.value;
      if (el.dataset.f === 'y' && !q.st.trim()) {
        const y = parseYT(el.value);
        if (y && y.t) {
          q.st = fmtClock(y.t);
          const stIn = document.querySelector('[data-bind="q"][data-f="st"][data-i="' + i + '"]');
          if (stIn) stIn.value = q.st;
        }
      }
      if (['y', 'st', 'en'].indexOf(el.dataset.f) >= 0) {
        const m = ytMsg(q);
        const box = document.getElementById('ytmsg-' + i);
        if (box) { box.className = 'yt-msg ' + m.c; box.textContent = m.t; }
      }
      saveDraft();
    } else if (bind === 'qname') {
      if (S.quiz) S.quiz.name = el.value;
      store.set('tf_name', el.value);
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
      err.textContent = 'Indique la série du quiz.';
      const el = mark('#b-serie');
      if (el) el.focus();
      return;
    }
    const problems = [];
    const qs = [];
    B.qs.forEach((q, i) => {
      const filled = ['p', 'r', 'e', 'n', 'y'].some((k) => q[k].trim());
      if (!filled) return;
      const sel = (f) => '[data-bind="q"][data-f="' + f + '"][data-i="' + i + '"]';
      const y = q.y.trim() ? parseYT(q.y) : null;
      const miss = [];
      if (!q.r.trim()) { miss.push('la réplique'); mark(sel('r')); }
      if (!q.e.trim()) { miss.push("l'épisode"); mark(sel('e')); }
      if (!q.p.trim() && !y) { miss.push('ce que le joueur voit (ou un extrait)'); mark(sel('p')); }
      if (q.y.trim() && !y) { miss.push('un lien YouTube valide'); mark(sel('y')); }
      const st = parseClock(q.st), en = parseClock(q.en);
      if (y && (Number.isNaN(st) || Number.isNaN(en))) { miss.push('des temps valides'); mark(sel('st')); }
      if (miss.length) { problems.push('Réplique ' + (i + 1) + ' : il manque ' + miss.join(', ') + '.'); return; }
      const o = { r: q.r.trim(), e: q.e.trim() };
      if (q.p.trim()) o.p = q.p.trim();
      if (q.n.trim()) o.n = q.n.trim();
      if (y) {
        o.y = y.id;
        if (st != null) o.st = st; else if (y.t) o.st = y.t;
        if (en != null && en > (o.st || 0)) o.en = en;
      }
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
    const data = { v: 1, s: B.serie.trim(), q: qs };
    if (B.author.trim()) data.a = B.author.trim();
    if (B.title.trim()) data.t = B.title.trim();
    const code = await encodeQuiz(data);
    const url = quizUrl(code);
    out.innerHTML = `<h3>Ton lien est prêt</h3>
      <p class="page-sub">${plural(qs.length, 'réplique')}. Envoie-le, mets-le en bio ou en story.</p>
      ${linkBox(url, 'Mon blindtest ' + data.s + ' : t\'es fan, ou trop fan ?')}
      <a class="btn btn-ghost" style="margin-top:8px" href="${esc(url)}">Tester mon quiz</a>`;
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* =========================================================
     Jouer à un quiz
     ========================================================= */
  async function renderQuiz(code) {
    if (!S.quiz || S.quiz.key !== code) {
      S.quiz = { key: code, loading: true };
      paint('<div class="center-msg"><p>Chargement du quiz…</p></div>', 'q-load');
      try {
        const raw = await decodeQuiz(code);
        const data = cleanQuiz(raw);
        delete raw.c;
        S.quiz = { key: code, raw, data, phase: 'intro', idx: 0, res: [], name: store.get('tf_name', '') || '' };
      } catch (e) {
        S.quiz = { key: code, error: e && e.message === 'old' ? 'old' : 'bad' };
      }
      if (S.quiz.key !== code || location.hash.replace(/^#\/?/, '') !== 'q/' + code) return;
    }
    const Q = S.quiz;
    if (Q.loading) return;
    if (Q.error) {
      paint(`<div class="center-msg"><h1 class="page-title">Lien illisible</h1>
        <p>${Q.error === 'old' ? 'Ton navigateur est trop ancien pour ouvrir ce quiz. Essaie avec Chrome ou Safari à jour.' : 'Ce lien de quiz est cassé ou incomplet. Demande-le à nouveau à la personne qui te l\'a envoyé.'}</p>
        <div class="stack"><a class="btn btn-primary" href="#/">Découvrir Trop Fan</a></div></div>`, 'q-err');
      return;
    }
    const key = 'q-' + Q.phase + '-' + Q.idx;
    if (Q.phase === 'intro') paint(vQuizIntro(), key);
    else if (Q.phase === 'q') paint(vQuizQ(), key);
    else if (Q.phase === 'reveal') paint(vQuizReveal(), key);
    else paint(vQuizEnd(), key, afterVerdict);
  }

  function vQuizIntro() {
    const { data, name } = S.quiz;
    const title = data.t || ('Le blindtest ' + data.s + (data.a ? ' de ' + data.a : ''));
    return `
      <p class="kicker" style="margin-top:18px">${esc(data.s)}</p>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-sub">${data.a ? 'Par ' + esc(data.a) + ' · ' : ''}${plural(data.q.length, 'réplique')} à trouver</p>
      ${data.c ? `<div class="beat"><div><span>Score à battre</span><br><b>${esc(data.c.n)}</b></div><strong>${data.c.p} %</strong></div>` : ''}
      <div class="rule-grid" style="margin-top:22px">
        <div class="rule r-line"><span class="rule-name">La réplique</span><ul><li><b>+2</b> mot pour mot</li><li><b>+1</b> presque</li></ul></div>
        <div class="rule r-ep"><span class="rule-name">L'épisode</span><ul><li><b>+1</b> titre ou numéro</li><li><b>0</b> raté</li></ul></div>
      </div>
      <label class="field"><span>Ton prénom</span>
        <input data-bind="qname" value="${esc(name)}" placeholder="Pour la carte du verdict" maxlength="24" autocomplete="off" enterkeyhint="go"></label>
      <div class="stack"><button type="button" class="btn btn-primary" data-act="quiz-go">C'est parti</button></div>`;
  }

  function ytEmbed(q) {
    const params = ['rel=0', 'playsinline=1', 'modestbranding=1'];
    if (q.st != null) params.push('start=' + q.st);
    if (q.en != null) params.push('end=' + q.en);
    return 'https://www.youtube-nocookie.com/embed/' + q.y + '?' + params.join('&');
  }

  function vQuizQ() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const total = Q.data.q.length;
    const t = tally(Q.res);
    return `
      <div class="progress"><i style="width:${(Q.idx / total) * 100}%"></i></div>
      <div class="q-count"><span>Réplique ${Q.idx + 1}/${total}</span><span>${t.rp} pts · ${t.ep} ép.</span></div>
      ${q.y ? `<div class="yt-embed"><iframe id="yt-frame" src="${esc(ytEmbed(q))}" title="Extrait vidéo" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
        <button type="button" class="btn btn-ghost replay" data-act="yt-replay">Revoir l'extrait</button>` : ''}
      ${q.p ? '<blockquote class="prompt">' + esc(q.p) + '</blockquote>' : (q.y ? '' : '<blockquote class="prompt">Trouve la réplique.</blockquote>')}
      <label class="field"><span>La réplique, mot pour mot</span>
        <textarea id="a-line" rows="3" maxlength="500" placeholder="Écris la réplique exacte"></textarea></label>
      <label class="field"><span>L'épisode</span>
        <input id="a-ep" maxlength="140" placeholder="Titre ou numéro (ex. S2E4)" autocomplete="off" enterkeyhint="done"></label>
      <div class="stack">
        <button type="button" class="btn btn-primary" data-act="quiz-check">Valider</button>
        <button type="button" class="btn btn-ghost" data-act="quiz-skip">Je sèche</button>
      </div>`;
  }

  function quizAnswer(skip) {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const line = skip ? '' : (document.getElementById('a-line') || {}).value || '';
    const ep = skip ? '' : (document.getElementById('a-ep') || {}).value || '';
    if (!skip && !line.trim() && !ep.trim()) { toast('Écris au moins quelque chose, ou appuie sur « Je sèche »'); return; }
    const jl = judgeLine(q.r, line);
    const je = judgeEpisode(q, ep);
    Q.res[Q.idx] = { r: jl.score, e: je, line, ep, parts: jl.parts };
    Q.phase = 'reveal';
    if (jl.score === 2) SFX.exact(); else if (jl.score === 1) SFX.close(); else SFX.miss();
    setTimeout(() => (je ? SFX.found() : null), 260);
    renderQuiz(Q.key);
  }

  function vQuizReveal() {
    const Q = S.quiz;
    const q = Q.data.q[Q.idx];
    const R = Q.res[Q.idx];
    const total = Q.data.q.length;
    const last = Q.idx === total - 1;
    const t = tally(Q.res);
    const lineV = R.r === 2 ? ['good', 'Mot pour mot · +2'] : R.r === 1 ? ['mid', 'Presque · +1'] : ['bad', 'Ratée · 0'];
    const epV = R.e ? ['good', 'Trouvé · +1'] : ['bad', 'Raté · 0'];
    const diff = R.parts.map((p) => (p.c ? '<span class="' + p.c + '">' + esc(p.w) + '</span>' : esc(p.w))).join(' ');
    return `
      <div class="progress"><i style="width:${((Q.idx + 1) / total) * 100}%"></i></div>
      <div class="q-count"><span>Réplique ${Q.idx + 1}/${total}</span><span>${t.rp} pts · ${t.ep} ép.</span></div>

      <div class="verdict-row vr-line"><span class="vr-k">La réplique</span><span class="vr-v ${lineV[0]}">${lineV[1]}</span></div>
      <div class="answer">
        <span class="lbl">Ta réponse</span>
        <p class="${R.line.trim() ? 'mine' : 'empty'}">${R.line.trim() ? esc(R.line) : 'Rien écrit'}</p>
        <span class="lbl">La vraie réplique</span>
        <p>${diff}</p>
        ${R.line.trim() && R.r < 2 ? '<p class="legend"><span class="w-ok">en vert</span> : trouvé · <span class="w-miss">souligné</span> : manqué</p>' : ''}
      </div>

      <div class="verdict-row vr-ep"><span class="vr-k">L'épisode</span><span class="vr-v ${epV[0]}">${epV[1]}</span></div>
      <div class="answer">
        <span class="lbl">Ta réponse</span>
        <p class="${R.ep.trim() ? 'mine' : 'empty'}">${R.ep.trim() ? esc(R.ep) : 'Rien écrit'}</p>
        <span class="lbl">Le bon épisode</span>
        <p>${esc(q.e)}${q.n ? ' <span style="color:var(--mu)">(' + esc(q.n) + ')</span>' : ''}</p>
      </div>

      <div class="stack"><button type="button" class="btn btn-primary" data-act="quiz-next">${last ? 'Voir mon verdict' : 'Réplique suivante'}</button></div>`;
  }

  function vQuizEnd() {
    const Q = S.quiz;
    const d = Q.data;
    const t = tally(Q.res);
    const who = (Q.name || '').trim() || 'Toi';
    let before = '', foot = '';
    if (d.c) {
      const win = t.pct > d.c.p, tie = t.pct === d.c.p;
      before = `<div class="beat ${win ? 'win' : tie ? '' : 'lose'}"><div><span>${win ? 'Tu bats' : tie ? 'Égalité avec' : 'Toujours devant toi'}</span><br><b>${esc(d.c.n)}</b></div><strong>${d.c.p} %</strong></div>`;
      foot = win ? 'Bat ' + d.c.n + ' (' + d.c.p + ' %)' : tie ? 'Égalité avec ' + d.c.n : d.c.n + ' reste devant (' + d.c.p + ' %)';
    }
    S.cardData = { who, serie: d.s, t, foot };
    S.cardText = 'J\'ai fait ' + t.pct + ' % au blindtest ' + d.s + ' : « ' + levelFor(t.pct).label + ' ». À toi : ' + quizUrl(Q.key);
    return vVerdict({
      who,
      whoPrefix: 'Le verdict pour',
      serie: d.s,
      t,
      extra: before,
      actions: `
        <section>
          <h3>Défie tes potes</h3>
          <p class="page-sub">Le lien garde ton score : pour te battre, il faudra faire mieux que ${t.pct} %.</p>
          <div class="stack" style="margin-top:12px"><button type="button" class="btn btn-pink" data-act="quiz-defi">Créer mon lien défi</button></div>
          <div id="defi-out"></div>
        </section>
        <div class="stack">
          <button type="button" class="btn" data-act="quiz-replay">Rejouer ce quiz</button>
          <a class="btn btn-ghost" href="#/creer">Créer mon propre quiz</a>
        </div>`
    });
  }

  async function quizDefi() {
    const Q = S.quiz;
    const t = tally(Q.res);
    const who = (Q.name || '').trim() || 'Ton pote';
    const data = Object.assign({}, Q.raw, { c: { n: who.slice(0, 30), p: t.pct } });
    const code = await encodeQuiz(data);
    const out = document.getElementById('defi-out');
    if (!out) return;
    out.innerHTML = linkBox(quizUrl(code), who + ' a fait ' + t.pct + ' % au blindtest ' + Q.data.s + '. Tu fais mieux ?');
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
      const R = d.rounds[d.cur];
      R[k] = v;
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
    'q-add'() {
      syncDraftFromDom();
      draft().qs.push(newQ());
      saveDraft();
      rerender();
      const cards = document.querySelectorAll('.qcard');
      const lastCard = cards[cards.length - 1];
      if (lastCard) {
        lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const ta = lastCard.querySelector('textarea');
        if (ta) setTimeout(() => ta.focus({ preventScroll: true }), 350);
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
    build,
    'draft-reset'() {
      if (!confirm('Effacer tout le quiz en cours ?')) return;
      S.draft = null;
      store.del('tf_draft');
      rerender();
    },
    'quiz-go'() {
      const Q = S.quiz;
      audio();
      Q.phase = 'q';
      Q.idx = 0;
      Q.res = [];
      renderQuiz(Q.key);
    },
    'quiz-check'() { quizAnswer(false); },
    'quiz-skip'() { quizAnswer(true); },
    'quiz-next'() {
      const Q = S.quiz;
      if (Q.idx >= Q.data.q.length - 1) {
        Q.phase = 'end';
        SFX.win();
      } else {
        Q.idx++;
        Q.phase = 'q';
      }
      renderQuiz(Q.key);
    },
    'quiz-replay'() {
      const Q = S.quiz;
      Q.phase = 'q';
      Q.idx = 0;
      Q.res = [];
      renderQuiz(Q.key);
    },
    'quiz-defi': quizDefi,
    'yt-replay'() {
      const f = document.getElementById('yt-frame');
      if (!f) return;
      const q = S.quiz.data.q[S.quiz.idx];
      f.src = ytEmbed(q) + '&autoplay=1';
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
    const id = e.target && e.target.id;
    if (id === 'a-ep') { e.preventDefault(); quizAnswer(false); }
    else if (e.target && e.target.dataset && e.target.dataset.bind === 'qname') { e.preventDefault(); ACT['quiz-go'](); }
  });
  window.addEventListener('hashchange', () => { S.route = null; render(); });

  const sb = document.querySelector('.snd');
  if (sb) {
    sb.setAttribute('aria-pressed', String(S.sound));
    sb.setAttribute('aria-label', S.sound ? 'Couper le son' : 'Activer le son');
  }

  // Exposé pour les essais automatiques uniquement
  window.__tropfan = { judgeLine, judgeEpisode, parseYT, parseClock, parseCode, encodeQuiz, decodeQuiz };

  render();
})();
