'use strict';

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const state = {
  lib: { liked: [], playlists: [], history: [], albums: [], artists: [], plays: [] },
  route: { name: 'home' },
  search: { query: '', status: 'idle', results: [], albums: [], artists: [], tab: 'all', error: '' },
  queue: [],          // contexto: a lista de onde a faixa atual veio
  userQueue: [],      // fila montada pelo usuario ("Adicionar à fila" / "Tocar a seguir")
  fromUserQueue: false,
  heard: new Set(),      // tudo que ja tocou nesta sessao (o radio nunca repete)
  radioIds: new Set(),   // faixas do contexto que vieram do radio automatico
  radioLoading: false,
  radioWaiting: false,   // a faixa acabou e estamos esperando o radio chegar
  index: -1,
  played: new Set(),
  back: [],
  shuffle: false,
  repeat: 'off', // 'off' | 'all' | 'one'
  current: null,
  loading: false,
  retried: false,
  historyLogged: false,
  failStreak: 0,
  lastError: '',
  queueOpen: false,
  lyricsOpen: false,
  engine: null,
};

/* ---------- icones (desenhados para o Openfy; f = preenchido, s = traco) ---------- */
const ICONS = {
  play: { f: 'M8 5v14l11-7z' },
  pause: { f: 'M6 5h4v14H6zM14 5h4v14h-4z' },
  next: { f: 'M6 5l9 7-9 7zM16 5h2v14h-2z' },
  prev: { f: 'M18 5l-9 7 9 7zM6 5h2v14H6z' },
  shuffle: { s: 'M3 7h3.5c5 0 5.5 10 10.5 10H21M3 17h3.5c1.6 0 2.7-1 3.6-2.4M13.9 9.4C14.8 8 15.9 7 17 7h4M18 4l3 3-3 3M18 14l3 3-3 3' },
  repeat: { s: 'M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3' },
  heart: { s: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z' },
  heartOn: { f: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z' },
  home: { s: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z' },
  search: { s: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4' },
  plus: { s: 'M12 5v14M5 12h14' },
  more: { f: 'M6 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM18 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z' },
  queue: { s: 'M4 6h16M4 11h16M4 16h9M16 14v6l5-3z' },
  volume: { s: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11' },
  mute: { s: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6' },
  library: { s: 'M5 4v16M10 4v16M15 5l4 15' },
  note: { s: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z' },
  clock: { s: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2' },
  winMin: { s: 'M6 12h12' },
  winMax: { s: 'M6.5 6.5h11v11h-11z' },
  winRestore: { s: 'M6 9h9v9H6zM9 9V6h9v9h-3' },
  winClose: { s: 'M6.5 6.5l11 11M17.5 6.5l-11 11' },
  lyrics: { s: 'M4 6h16M4 11h11M4 16h8M18 12v7m0-7l3-1' },
};

function icon(name) {
  const i = ICONS[name];
  const paint = i.f
    ? `<path d="${i.f}" fill="currentColor"/>`
    : `<path d="${i.s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${paint}</svg>`;
}

function setIcon(el, name) {
  if (el.dataset.icon === name && el.firstChild) return;
  el.dataset.icon = name;
  el.innerHTML = icon(name);
}

/* ---------- DOM: tudo que vem do YouTube entra como texto, nunca como HTML ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = icon(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
// Faixas do catalogo trazem a capa quadrada do album; as demais usam o quadro do video.
const cover = (track) => track.cover || thumb(track.id);

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function fmtTotal(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const min = Math.round(total / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const countLabel = (n) => (n === 1 ? '1 música' : `${n} músicas`);
const isLiked = (id) => state.lib.liked.some((t) => t.id === id);
const findPlaylist = (id) => state.lib.playlists.find((p) => p.id === id);

function hueOf(text) {
  let x = 0;
  for (const ch of String(text)) x = (x * 31 + ch.codePointAt(0)) % 360;
  return x;
}

/* ---------- avisos ---------- */
let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

function fail(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || String(err);
  state.lastError = msg;
  console.error(err);
  toast(msg, true);
}

/* ---------- biblioteca ---------- */
async function mutate(cmd, args, okMsg) {
  try {
    state.lib = await invoke(cmd, args);
    renderSidebar();
    renderView();
    renderPlayer();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

async function createPlaylist(track) {
  if (!(await mutate('create_playlist'))) return;
  const pl = state.lib.playlists[0];
  if (!pl) return;
  if (track) await mutate('add_to_playlist', { playlistId: pl.id, track }, `Adicionada a ${pl.name}`);
  go({ name: 'playlist', id: pl.id });
}

/* ---------- menu de contexto ---------- */
function closeMenu() {
  $('menu').hidden = true;
}

function openMenu(anchor, items) {
  const menu = $('menu');
  menu.replaceChildren(
    ...items.map((it) => {
      if (it === 'sep') return h('hr');
      if (it.heading) return h('div', { class: 'menu-label' }, it.heading);
      return h('button', { role: 'menuitem', onclick: () => { closeMenu(); it.run(); } }, it.label);
    }),
  );
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
  const below = r.bottom + 4;
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const first = menu.querySelector('button');
  if (first) first.focus();
}

function trackMenu(anchor, track, ctx) {
  const items = [
    { label: 'Adicionar à fila', run: () => addToQueue(track) },
    { label: 'Tocar a seguir', run: () => playNext(track) },
    'sep',
    {
      label: isLiked(track.id) ? 'Remover das Curtidas' : 'Salvar nas Curtidas',
      run: () => mutate('toggle_like', { track }),
    },
    'sep',
    { heading: 'Adicionar à playlist' },
    { label: 'Nova playlist', run: () => createPlaylist(track) },
    ...state.lib.playlists.map((p) => ({
      label: p.name,
      run: () => mutate('add_to_playlist', { playlistId: p.id, track }, `Adicionada a ${p.name}`),
    })),
  ];
  if (ctx && ctx.playlistId) {
    items.push('sep', {
      label: 'Remover desta playlist',
      run: () => mutate('remove_from_playlist', { playlistId: ctx.playlistId, trackId: track.id }),
    });
  }
  openMenu(anchor, items);
}

document.addEventListener('click', (e) => {
  if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('[data-menu]')) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

/* ---------- reproducao ---------- */
let playToken = 0;

function playFrom(tracks, i) {
  state.queue = tracks.slice();
  state.played = new Set();
  state.back = [];
  state.failStreak = 0;
  radioToken += 1; // descarta um radio pedido para o contexto antigo
  state.radioIds = new Set();
  state.radioLoading = false;
  state.radioWaiting = false;
  playAt(i);
}

let radioToken = 0;

/* ---------- pre-carregamento: resolve a URL de audio antes do clique ---------- */
const WARM_TTL_MS = 2.5 * 60 * 60 * 1000; // as URLs do YouTube expiram depois de algumas horas
const WARM_PARALLEL = 3; // cada resolucao e um processo yt-dlp; nao abrir dezenas de uma vez
const warmed = new Map(); // id -> { at, promise }
const warmQueue = [];
let warmActive = 0;

/** Deixa a faixa pronta para tocar. `urgent` fura a fila (o mouse esta em cima dela). */
function prewarm(track, urgent = false) {
  if (!track || !track.id) return Promise.resolve();
  const hit = warmed.get(track.id);
  if (hit && Date.now() - hit.at < WARM_TTL_MS) return hit.promise;
  let done;
  const promise = new Promise((resolve) => { done = resolve; });
  warmed.set(track.id, { at: Date.now(), promise });
  const job = { id: track.id, done };
  if (urgent) warmQueue.unshift(job);
  else warmQueue.push(job);
  pumpWarm();
  return promise;
}

function pumpWarm() {
  while (warmActive < WARM_PARALLEL && warmQueue.length) {
    const job = warmQueue.shift();
    warmActive++;
    invoke('resolve_stream', { id: job.id, force: false })
      .catch(() => { warmed.delete(job.id); }) // falhou: o clique tenta de novo e mostra o erro
      .finally(() => { warmActive--; job.done(); pumpWarm(); });
  }
}

/** Atributos para pre-carregar quando o mouse para sobre a faixa. */
function hoverWarm(track) {
  let timer = 0;
  return {
    onmouseenter: () => { timer = setTimeout(() => prewarm(track, true), 150); },
    onmouseleave: () => clearTimeout(timer),
  };
}

/** Pre-carrega a faixa que vai tocar quando a atual acabar. */
function warmUpcoming() {
  const upcoming = state.userQueue[0] || (state.shuffle ? null : state.queue[state.index + 1]);
  if (upcoming) prewarm(upcoming, true);
}

/** Ainda ha faixa do contexto para tocar depois da atual? */
function contextHasNext() {
  if (state.repeat === 'all') return true;
  if (state.shuffle) return state.queue.some((t) => !state.played.has(t.id));
  return state.index + 1 < state.queue.length;
}

/** Quando o contexto esta acabando, busca faixas no mesmo estilo da atual e as poe no fim dele. */
async function ensureRadio() {
  if (!state.current || state.radioLoading || contextHasNext()) return;
  const token = radioToken;
  state.radioLoading = true;
  renderQueue();
  let tracks = [];
  try {
    tracks = await invoke('related', { id: state.current.id });
  } catch (e) {
    console.error(e);
    state.lastError = String(e);
  }
  if (token !== radioToken) return;
  state.radioLoading = false;
  const taken = new Set([...state.heard, ...state.queue.map((t) => t.id), ...state.userQueue.map((t) => t.id)]);
  const fresh = tracks.filter((t) => !taken.has(t.id));
  fresh.forEach((t) => { state.queue.push(t); state.radioIds.add(t.id); });
  renderQueue();
  warmUpcoming();
  if (state.radioWaiting) {
    state.radioWaiting = false;
    if (fresh.length) next();
    else toast('Não encontrei mais músicas parecidas.', true);
  }
}

/** Toca a faixa `i` do contexto (playlist, busca...). */
function playAt(i) {
  const track = state.queue[i];
  if (!track) return;
  state.index = i;
  state.fromUserQueue = false;
  start(track);
}

/** Carrega e toca uma faixa, venha ela do contexto ou da fila do usuario. */
async function start(track, isRetry = false) {
  const token = ++playToken;
  // Retomada de sessao: a faixa restaurada volta do ponto em que parou.
  const resumeAt = pendingSeek > 0 && track.id === resumeId ? pendingSeek : 0;
  pendingSeek = 0;
  state.current = track;
  // Uma faixa que comeca a tocar nao deve continuar esperando na fila.
  state.userQueue = state.userQueue.filter((t) => t.id !== track.id);
  state.loading = true;
  state.retried = isRetry;
  // Retomar de onde parou nao conta como uma nova reproducao.
  if (!isRetry) state.historyLogged = resumeAt > 0;
  state.played.add(track.id);
  state.heard.add(track.id);
  state.radioWaiting = false;
  audio.pause();
  renderPlayer();
  markCurrent();
  renderQueue();
  renderLyrics();
  saveSession();
  ensureRadio();
  warmUpcoming();

  let url;
  try {
    url = await invoke('resolve_stream', { id: track.id, force: isRetry });
  } catch (e) {
    if (token !== playToken) return;
    state.loading = false;
    renderPlayer();
    fail(e);
    return;
  }
  if (token !== playToken) return; // o usuario ja pediu outra faixa
  audio.src = url;
  if (resumeAt) {
    audio.addEventListener('loadedmetadata', () => {
      if (token === playToken) audio.currentTime = resumeAt;
    }, { once: true });
  }
  // Se play() falhar por erro de midia, o evento 'error' abaixo cuida do retry.
  audio.play().catch(() => {});
}

function nextIndex() {
  const n = state.queue.length;
  if (!n) return null;
  if (state.shuffle) {
    let rest = state.queue.map((_, i) => i).filter((i) => !state.played.has(state.queue[i].id));
    if (!rest.length) {
      if (state.repeat !== 'all') return null;
      state.played = new Set();
      rest = state.queue.map((_, i) => i).filter((i) => i !== state.index || n === 1);
    }
    return rest[Math.floor(Math.random() * rest.length)];
  }
  if (state.index + 1 < n) return state.index + 1;
  return state.repeat === 'all' ? 0 : null;
}

function next() {
  // A fila montada pelo usuario tem prioridade; o contexto continua depois dela.
  if (state.userQueue.length) {
    state.fromUserQueue = true;
    start(state.userQueue.shift());
    return true;
  }
  const i = nextIndex();
  if (i == null) {
    // Contexto acabou: o radio continua. Se ele ainda esta chegando, esperamos por ele.
    ensureRadio();
    if (state.radioLoading) {
      state.radioWaiting = true;
      return true;
    }
    audio.pause();
    return false;
  }
  if (state.index >= 0) state.back.push(state.index);
  playAt(i);
  return true;
}

function prev() {
  if (!state.current) return;
  if (audio.currentTime > 3 || (!state.fromUserQueue && !state.back.length && state.index === 0)) {
    audio.currentTime = 0;
    return;
  }
  // Vindo da fila do usuario, "anterior" volta para a faixa do contexto.
  if (state.fromUserQueue) return playAt(state.index);
  const i = state.back.length ? state.back.pop() : state.index - 1;
  playAt(Math.max(0, Math.min(i, state.queue.length - 1)));
}

function togglePlay() {
  if (!state.current) return;
  if (!audio.src) {
    start(state.current);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

/** Poe a faixa na fila do usuario sem duplicar; devolve false se ela ja e a faixa atual. */
function enqueue(track, atNext) {
  if (state.current && state.current.id === track.id) return false;
  state.userQueue = state.userQueue.filter((t) => t.id !== track.id);
  if (atNext) state.userQueue.unshift(track);
  else state.userQueue.push(track);
  return true;
}

function addToQueue(track) {
  if (!state.current) return playFrom([track], 0);
  if (enqueue(track, false)) toast('Adicionada à fila');
  renderQueue();
  warmUpcoming();
}

function playNext(track) {
  if (!state.current) return playFrom([track], 0);
  if (enqueue(track, true)) toast('Toca a seguir');
  renderQueue();
  warmUpcoming();
}

audio.addEventListener('playing', () => {
  state.loading = false;
  state.failStreak = 0;
  renderPlayer();
  if (!state.historyLogged && state.current) {
    state.historyLogged = true;
    invoke('push_history', { track: state.current })
      .then((lib) => {
        state.lib = lib;
        if (state.route.name === 'home') renderView();
      })
      .catch(fail);
  }
});
audio.addEventListener('waiting', () => { state.loading = true; renderPlayer(); });
audio.addEventListener('canplay', () => { state.loading = false; renderPlayer(); });
audio.addEventListener('pause', renderPlayer);
audio.addEventListener('play', renderPlayer);
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (!next()) renderPlayer();
});
audio.addEventListener('error', () => {
  if (!state.current || !audio.getAttribute('src')) return;
  const code = audio.error ? audio.error.code : 0;
  // URLs do googlevideo expiram: a primeira falha pede uma URL nova ao yt-dlp.
  if (!state.retried) {
    start(state.current, true);
    return;
  }
  state.loading = false;
  state.failStreak += 1;
  state.lastError = `erro de midia (codigo ${code})`;
  toast(`Não foi possível tocar "${state.current.title}".`, true);
  renderPlayer();
  if (state.failStreak < 3) next();
});

/* ---------- barra do player ---------- */
const seek = $('seek');
const volume = $('volume');
let seeking = false;
let lastVolume = 80;

function duration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return (state.current && state.current.duration) || 0;
}

function setFill(el, pct) {
  el.style.setProperty('--p', `${Math.max(0, Math.min(100, pct))}%`);
}

function renderProgress() {
  const d = duration();
  const pos = position();
  const cur = seeking ? (seek.value / 1000) * d : pos;
  $('time-cur').textContent = fmt(cur);
  $('time-dur').textContent = fmt(d);
  if (!seeking) seek.value = d ? Math.round((pos / d) * 1000) : 0;
  setFill(seek, seek.value / 10);
}

/** Posicao atual; antes de o audio carregar, e o ponto guardado da sessao anterior. */
function position() {
  return audio.getAttribute('src') ? audio.currentTime : pendingSeek;
}

function seekTo(sec) {
  const d = duration();
  if (!state.current || !d) return;
  const to = Math.max(0, Math.min(sec, d - 0.25));
  if (audio.getAttribute('src')) {
    audio.currentTime = to;
  } else {
    pendingSeek = to;
    resumeId = state.current.id;
  }
  renderProgress();
}
const seekBy = (delta) => seekTo(position() + delta);

audio.addEventListener('timeupdate', renderProgress);
audio.addEventListener('durationchange', renderProgress);
seek.addEventListener('input', () => { seeking = true; renderProgress(); });
seek.addEventListener('change', () => {
  seeking = false;
  seekTo((seek.value / 1000) * duration());
  renderProgress();
});

function renderPlayer() {
  const t = state.current;
  const img = $('now-thumb');
  img.hidden = !t;
  if (t && img.dataset.id !== t.id) {
    img.dataset.id = t.id;
    img.src = cover(t);
  }
  $('now-title').textContent = t ? t.title : '';
  const by = $('now-artist');
  const byKey = t ? t.id : '';
  if (by.dataset.id !== byKey) {
    by.dataset.id = byKey;
    by.replaceChildren(...(t ? credits(t) : []));
  }

  const like = $('now-like');
  like.hidden = !t;
  if (t) {
    const on = isLiked(t.id);
    setIcon(like, on ? 'heartOn' : 'heart');
    like.classList.toggle('on', on);
    like.title = on ? 'Remover das Curtidas' : 'Salvar nas Curtidas';
    like.setAttribute('aria-label', like.title);
  }

  const play = $('btn-play');
  const playing = !!t && !audio.paused;
  setIcon(play, playing ? 'pause' : 'play');
  play.title = playing ? 'Pausar' : 'Tocar';
  play.setAttribute('aria-label', play.title);
  play.classList.toggle('loading', state.loading);
  play.disabled = !t;
  $('btn-prev').disabled = !t;
  $('btn-next').disabled = !t;
  seek.disabled = !t;

  $('btn-shuffle').classList.toggle('on', state.shuffle);
  const rep = $('btn-repeat');
  rep.classList.toggle('on', state.repeat !== 'off');
  rep.classList.toggle('one', state.repeat === 'one');
  rep.title = { off: 'Repetir', all: 'Repetindo a fila', one: 'Repetindo a faixa' }[state.repeat];
  $('btn-queue').classList.toggle('on', state.queueOpen);
  $('btn-lyrics').classList.toggle('on', state.lyricsOpen);

  document.title = t ? `${t.title} • ${t.artist}` : 'Openfy';
  renderProgress();
  updateMediaSession();
}

$('btn-play').addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', next);
$('btn-prev').addEventListener('click', prev);
$('btn-shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  state.played = new Set(state.current ? [state.current.id] : []);
  renderPlayer();
});
$('btn-repeat').addEventListener('click', () => {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  renderPlayer();
});
$('now-like').addEventListener('click', () => {
  if (state.current) mutate('toggle_like', { track: state.current });
});
/** Fila e letra dividem a mesma coluna: abrir um painel fecha o outro. */
function openPanel(which) {
  state.queueOpen = which === 'queue';
  state.lyricsOpen = which === 'lyrics';
  $('app').classList.toggle('queue-open', state.queueOpen);
  $('app').classList.toggle('lyrics-open', state.lyricsOpen);
  $('queue-panel').hidden = !state.queueOpen;
  $('lyrics-panel').hidden = !state.lyricsOpen;
  renderQueue();
  renderLyrics();
  renderPlayer();
}
$('btn-queue').addEventListener('click', () => openPanel(state.queueOpen ? null : 'queue'));
$('btn-lyrics').addEventListener('click', () => openPanel(state.lyricsOpen ? null : 'lyrics'));

/* ---------- letra ---------- */
const lyricsCache = new Map(); // id da faixa -> { status: 'loading'|'done'|'error', data, error }
let lyricLine = -1;            // linha destacada agora

function loadLyrics(track) {
  lyricsCache.set(track.id, { status: 'loading', data: null, error: '' });
  const isCurrent = state.current && state.current.id === track.id;
  invoke('lyrics', {
    title: track.title,
    artist: track.artist,
    album: track.album || null,
    // A duracao separa a gravacao certa de outra versao da mesma musica.
    duration: track.duration || (isCurrent ? duration() : 0) || null,
  })
    .then((data) => lyricsCache.set(track.id, { status: 'done', data, error: '' }))
    .catch((e) => lyricsCache.set(track.id, { status: 'error', data: null, error: String(e) }))
    .then(() => { if (state.current && state.current.id === track.id) renderLyrics(); });
}

function renderLyrics() {
  if (!state.lyricsOpen) return;
  const panel = $('lyrics-panel');
  const t = state.current;
  const body = [h('h3', null, 'Letra')];
  const note = (text) => h('div', { class: 'q-empty' }, text);
  lyricLine = -1;
  if (!t) {
    body.push(note('Toque uma música para ver a letra.'));
  } else {
    body.push(h('div', { class: 'lyrics-track' }, h('strong', null, t.title), h('span', null, t.artist)));
    if (!lyricsCache.has(t.id)) loadLyrics(t);
    const entry = lyricsCache.get(t.id);
    const data = entry.data;
    if (entry.status === 'loading') {
      body.push(note('Buscando a letra…'));
    } else if (entry.status === 'error') {
      body.push(note('Não deu para buscar a letra agora.'),
        h('button', { class: 'follow-btn', title: entry.error, onclick: () => { lyricsCache.delete(t.id); renderLyrics(); } }, 'Tentar de novo'));
    } else if (!data) {
      body.push(note('Ainda não há letra para esta faixa.'));
    } else if (data.synced.length) {
      body.push(h('div', { class: 'lyrics-lines' },
        data.synced.map((line) => h('button', { class: 'lyric', onclick: () => seekTo(line.time) }, line.text || '♪'))));
    } else if (data.plain) {
      body.push(h('p', { class: 'lyrics-plain' }, data.plain), h('div', { class: 'lyrics-note' }, 'Letra sem sincronia.'));
    } else {
      body.push(note(data.instrumental ? 'Faixa instrumental.' : 'Ainda não há letra para esta faixa.'));
    }
    if (data) body.push(h('div', { class: 'lyrics-note' }, 'Letras: LRCLIB'));
  }
  panel.replaceChildren(...body);
  panel.scrollTop = 0;
  syncLyrics(true);
}

/** Destaca a linha que esta sendo cantada e a mantem no meio do painel. */
function syncLyrics(jump = false) {
  if (!state.lyricsOpen || !state.current) return;
  const entry = lyricsCache.get(state.current.id);
  const lines = entry && entry.data ? entry.data.synced : [];
  if (!lines.length) return;
  // Enquanto a faixa nova carrega, o <audio> ainda guarda a posicao da anterior.
  const now = (state.loading ? 0 : position()) + 0.15;
  let i = -1;
  for (let k = 0; k < lines.length && lines[k].time <= now; k += 1) i = k;
  if (i === lyricLine && !jump) return;
  lyricLine = i;
  const panel = $('lyrics-panel');
  const els = panel.querySelectorAll('.lyric');
  els.forEach((el, k) => el.classList.toggle('on', k === i));
  const el = els[i];
  if (!el) return;
  const smooth = !jump && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  panel.scrollTo({ top: el.offsetTop - panel.clientHeight / 2 + el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}
audio.addEventListener('timeupdate', () => syncLyrics());
audio.addEventListener('seeked', () => syncLyrics(true));

function applyVolume(v, remember = true) {
  volume.value = v;
  audio.volume = v / 100;
  setFill(volume, v);
  setIcon($('btn-mute'), v === 0 ? 'mute' : 'volume');
  if (v > 0) lastVolume = v;
  if (remember) {
    try { localStorage.setItem('openfy.volume', String(v)); } catch (_) { /* sem storage: so nao lembra */ }
  }
}
volume.addEventListener('input', () => applyVolume(Number(volume.value)));
$('btn-mute').addEventListener('click', () => applyVolume(audio.volume > 0 ? 0 : lastVolume));

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = state.current;
  if (!t) return;
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  if (navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === t.title) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album || '',
    artwork: [{ src: cover(t) }],
  });
}

/** Conta ao sistema onde a faixa esta, para a barra do Windows mostrar o progresso. */
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, d),
    });
  } catch (_) { /* valores fora da faixa: o sistema fica sem a posicao */ }
}
['durationchange', 'seeked', 'playing', 'pause', 'ratechange'].forEach((ev) => audio.addEventListener(ev, updatePositionState));

if ('mediaSession' in navigator) {
  const actions = {
    play: () => { if (audio.paused) togglePlay(); },
    pause: () => audio.pause(),
    nexttrack: next,
    previoustrack: prev,
    seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
    seekforward: (d) => seekBy(d.seekOffset || 10),
    seekto: (d) => seekTo(d.seekTime),
    stop: () => audio.pause(),
  };
  Object.entries(actions).forEach(([name, fn]) => {
    // Cada WebView aceita um conjunto diferente de acoes; a que faltar nao derruba as outras.
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (_) { /* acao nao suportada */ }
  });
}

/* ---------- retomar a sessao ---------- */
// O app reabre na mesma faixa, fila e posicao, pausado: quem decide tocar e o usuario.
let pendingSeek = 0;   // posicao guardada enquanto o audio ainda nao foi carregado
let resumeId = '';     // faixa a que `pendingSeek` pertence
let sessionReady = false; // so grava depois de ler a sessao anterior (senao apagaria ela)

function snapshotSession() {
  return {
    queue: state.queue,
    index: state.index,
    current: state.current,
    position: position(),
    user_queue: state.userQueue,
  };
}

function saveSession() {
  if (!sessionReady || !state.current) return;
  invoke('save_session', { session: snapshotSession() }).catch((e) => console.error(e));
}

function applySession(s) {
  if (!s || !s.current) return false;
  state.queue = s.queue || [];
  state.userQueue = s.user_queue || [];
  state.index = Number.isInteger(s.index) ? s.index : -1;
  state.current = s.current;
  const inContext = state.queue[state.index];
  state.fromUserQueue = !(inContext && inContext.id === s.current.id);
  state.played = new Set([s.current.id]);
  state.heard.add(s.current.id);
  const d = s.current.duration || 0;
  const pos = Number(s.position) || 0;
  pendingSeek = pos > 0 && (!d || pos < d - 5) ? pos : 0; // no finzinho, recomeca a faixa
  resumeId = s.current.id;
  state.loading = false;
  renderPlayer();
  renderProgress();
  renderQueue();
  renderLyrics();
  markCurrent();
  return true;
}

async function restoreSession() {
  applySession(await invoke('load_session'));
}

audio.addEventListener('pause', saveSession);
setInterval(() => { if (!audio.paused) saveSession(); }, 5000);
window.addEventListener('beforeunload', saveSession);

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea');
  if (e.key === 'Escape') {
    closeMenu();
    return;
  }
  if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
    e.preventDefault();
    $('search-input').focus();
    $('search-input').select();
    return;
  }
  if (e.code === 'Space' && !typing && !e.target.matches('button')) {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (typing || e.altKey || e.metaKey || !$('menu').hidden) return;
  const arrows = {
    ArrowRight: () => (e.ctrlKey ? next() : seekBy(5)),
    ArrowLeft: () => (e.ctrlKey ? prev() : seekBy(-5)),
    // Sem Ctrl, as setas para cima/baixo continuam rolando a pagina.
    ArrowUp: () => e.ctrlKey && applyVolume(Math.min(100, Number(volume.value) + 5)),
    ArrowDown: () => e.ctrlKey && applyVolume(Math.max(0, Number(volume.value) - 5)),
  };
  if (arrows[e.key]) {
    if (e.shiftKey || (!e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) return;
    e.preventDefault();
    arrows[e.key]();
    return;
  }
  if (e.ctrlKey || e.shiftKey) return;
  const buttons = { m: 'btn-mute', l: 'btn-lyrics', q: 'btn-queue', s: 'btn-shuffle', r: 'btn-repeat', f: 'now-like' };
  const id = buttons[e.key.toLowerCase()];
  if (id) {
    e.preventDefault();
    $(id).click();
  }
});

/* ---------- lista de faixas ---------- */
/** Nome que leva a uma pagina quando o catalogo deu o id; texto simples caso contrario. */
function linkTo(text, route) {
  if (!route) return h('span', null, text);
  return h('button', {
    class: 'ref',
    onclick: (e) => { e.stopPropagation(); go(route); },
    ondblclick: (e) => e.stopPropagation(),
  }, text);
}

/** "Artista • Album" da faixa. `ctx.album` omite o album (a pagina ja e dele). */
function credits(track, ctx) {
  const parts = [linkTo(track.artist, track.artist_id && { name: 'artist', id: track.artist_id })];
  if (track.album && !(ctx && ctx.album)) {
    parts.push(h('span', { class: 'sep' }, '•'), linkTo(track.album, track.album_id && { name: 'album', id: track.album_id }));
  }
  return parts;
}

function trackRow(track, i, list, ctx) {
  const liked = isLiked(track.id);
  // Na busca, a escolha e so aquela faixa; o radio continua com musicas parecidas.
  const play = () => (ctx && ctx.single ? playFrom([track], 0) : playFrom(list, i));
  return h(
    'div',
    { class: 'track', 'data-id': track.id, ondblclick: play, ...hoverWarm(track) },
    h('button', { class: 't-num', title: `Tocar ${track.title}`, 'aria-label': `Tocar ${track.title}`, onclick: play },
      h('span', null, i + 1),
      h('span', { class: 't-play', icon: 'play' })),
    h('div', { class: 't-main' },
      h('img', { class: 't-thumb', src: cover(track), alt: '', loading: 'lazy' }),
      h('div', { class: 't-text' },
        h('div', { class: 't-title' }, track.title),
        h('div', { class: 't-artist credits' }, credits(track, ctx)))),
    h('button', {
      class: `icon-btn t-like${liked ? ' on' : ''}`,
      icon: liked ? 'heartOn' : 'heart',
      title: liked ? 'Remover das Curtidas' : 'Salvar nas Curtidas',
      'aria-label': liked ? 'Remover das Curtidas' : 'Salvar nas Curtidas',
      onclick: () => mutate('toggle_like', { track }),
    }),
    h('div', { class: 't-dur' }, track.duration ? fmt(track.duration) : '—'),
    h('button', {
      class: 'icon-btn t-more', icon: 'more', 'data-menu': true,
      title: 'Mais opções', 'aria-label': `Mais opções para ${track.title}`,
      onclick: (e) => trackMenu(e.currentTarget, track, ctx),
    }),
  );
}

function trackList(tracks, ctx) {
  // Ha listas do catalogo sem duracao (as populares do artista): a coluna some em vez de mostrar tracos.
  const timed = tracks.some((t) => t.duration);
  return h('div', { class: timed ? 'tracks' : 'tracks no-dur' },
    h('div', { class: 't-head' },
      h('div', { class: 't-num' }, '#'),
      h('div', null, 'Título'),
      h('div'),
      h('div', { class: 't-dur', icon: 'clock', title: 'Duração' }),
      h('div')),
    tracks.map((t, i) => trackRow(t, i, tracks, ctx)));
}

function markCurrent() {
  const id = state.current && state.current.id;
  document.querySelectorAll('.track, .q-item').forEach((el) => {
    el.classList.toggle('is-current', !!id && el.dataset.id === id);
  });
}

/* ---------- barra lateral ---------- */
function playlistTile(pl, extra = '') {
  const tile = h('div', { class: `lib-tile ${extra}`.trim(), icon: 'note' });
  tile.style.setProperty('--hue', hueOf(pl.id));
  return tile;
}

function renderSidebar() {
  const r = state.route;
  const items = [
    h('button', { class: `lib-item${r.name === 'liked' ? ' active' : ''}`, onclick: () => go({ name: 'liked' }) },
      h('div', { class: 'lib-tile liked', icon: 'heartOn' }),
      h('div', { class: 'lib-text' },
        h('div', { class: 'lib-name' }, 'Músicas Curtidas'),
        h('div', { class: 'lib-sub' }, `Playlist • ${countLabel(state.lib.liked.length)}`))),
    ...state.lib.playlists.map((pl) =>
      h('button', {
        class: `lib-item${r.name === 'playlist' && r.id === pl.id ? ' active' : ''}`,
        onclick: () => go({ name: 'playlist', id: pl.id }),
      },
        playlistTile(pl),
        h('div', { class: 'lib-text' },
          h('div', { class: 'lib-name' }, pl.name),
          h('div', { class: 'lib-sub' }, `Playlist • ${countLabel(pl.tracks.length)}`)))),
  ];
  if (!state.lib.playlists.length) {
    items.push(h('div', { class: 'side-empty' },
      h('p', null, 'Crie sua primeira playlist'),
      h('small', null, 'É rápido, e ela fica salva neste computador.'),
      h('button', { class: 'pill', onclick: () => createPlaylist() }, 'Criar playlist')));
  }
  const saved = (kind, route, sub) => (state.lib[kind] || []).forEach((it) => {
    const round = route === 'artist' ? ' round' : '';
    items.push(h('button', {
      class: `lib-item${r.name === route && r.id === it.id ? ' active' : ''}`,
      onclick: () => go({ name: route, id: it.id }),
    },
      it.cover
        ? h('img', { class: `lib-tile lib-img${round}`, src: it.cover, alt: '', loading: 'lazy' })
        : h('div', { class: `lib-tile${round}`, icon: 'note' }),
      h('div', { class: 'lib-text' },
        h('div', { class: 'lib-name' }, it.title),
        h('div', { class: 'lib-sub' }, sub(it)))));
  });
  saved('albums', 'album', (it) => (it.subtitle ? `Álbum • ${it.subtitle}` : 'Álbum'));
  saved('artists', 'artist', () => 'Artista');
  $('library-list').replaceChildren(...items);
  $('btn-home').classList.toggle('active', r.name === 'home');
}

$('btn-new-playlist').addEventListener('click', () => createPlaylist());

/* ---------- telas ---------- */
const GENRES = ['Pop', 'Rock', 'Sertanejo', 'Funk', 'MPB', 'Hip hop', 'Eletrônica', 'Jazz', 'Lo-fi', 'Pagode', 'Indie', 'Clássica'];

function trackCard(t, sub) {
  return h('button', { class: 'card', title: `Tocar ${t.title}`, onclick: () => playFrom([t], 0), ...hoverWarm(t) },
    h('img', { src: cover(t), alt: '', loading: 'lazy' }),
    h('span', { class: 'card-play', icon: 'play' }),
    h('div', { class: 'card-title' }, t.title),
    h('div', { class: 'card-sub' }, sub));
}

/** Faixas por numero de reproducoes; no empate, a ouvida mais recentemente vem antes. */
function topPlays() {
  return [...state.lib.plays].sort((a, b) => b.count - a.count || b.at - a.at);
}

/** Soma as reproducoes por artista. `plays` ja vem ordenado, entao a 1a faixa de cada um e a mais ouvida. */
function topArtists(plays) {
  const byKey = new Map();
  plays.forEach((p) => {
    const key = p.track.artist_id || p.track.artist;
    if (!key) return;
    let a = byKey.get(key);
    if (!a) {
      const followed = state.lib.artists.find((x) => x.id === p.track.artist_id);
      // "Artista A, Artista B": o id pertence ao primeiro nome.
      const name = p.track.artist.split(',')[0].trim();
      a = { id: p.track.artist_id || '', name, count: 0, seed: p.track, cover: (followed && followed.cover) || cover(p.track) };
      byKey.set(key, a);
    }
    a.count += p.count;
  });
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

async function playMix(seed) {
  toast('Montando o mix…');
  try {
    const rel = await invoke('related', { id: seed.id });
    playFrom([seed, ...rel.filter((t) => t.id !== seed.id)], 0);
  } catch (e) {
    fail(e);
  }
}

function viewHome() {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Boa madrugada' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const page = h('div', { class: 'page' }, h('h1', null, greeting));

  page.append(h('div', { class: 'shortcuts' },
    h('button', { class: 'shortcut', onclick: () => go({ name: 'liked' }) },
      h('div', { class: 'lib-tile liked', icon: 'heartOn' }), h('span', null, 'Músicas Curtidas')),
    state.lib.playlists.slice(0, 7).map((pl) =>
      h('button', { class: 'shortcut', onclick: () => go({ name: 'playlist', id: pl.id }) },
        playlistTile(pl), h('span', null, pl.name)))));

  const shelf = (title, cards) => {
    if (cards.length) page.append(h('h2', null, title), h('div', { class: 'cards' }, cards));
  };
  const hist = state.lib.history;
  if (hist.length) {
    shelf('Tocadas recentemente', hist.slice(0, 10).map((t) => trackCard(t, t.artist)));
  } else {
    page.append(h('h2', null, 'Tocadas recentemente'), h('div', { class: 'empty' },
      h('strong', null, 'Nada tocado ainda'),
      'Busque uma música acima e o que você ouvir aparece aqui.'));
  }

  // Tudo daqui para baixo sai das contagens reais gravadas na biblioteca.
  const top = topPlays();
  shelf('Mais tocadas', top.slice(0, 10).map((p) =>
    trackCard(p.track, `${p.track.artist} · ${p.count} ${p.count === 1 ? 'reprodução' : 'reproduções'}`)));

  const artists = topArtists(top);
  shelf('Seus artistas mais ouvidos', artists.slice(0, 6).map((a) =>
    h('button', {
      class: 'card round',
      title: a.name,
      onclick: () => (a.id ? go({ name: 'artist', id: a.id }) : runSearch(a.name, true)),
    },
      h('img', { src: a.cover, alt: '', loading: 'lazy' }),
      h('div', { class: 'card-title' }, a.name),
      h('div', { class: 'card-sub' }, `${a.count} ${a.count === 1 ? 'reprodução' : 'reproduções'}`))));

  // Um mix por artista: a faixa mais ouvida dele puxa as parecidas.
  shelf('Mixes para você', artists.slice(0, 3).map((a) =>
    h('button', { class: 'card', title: `Tocar o mix de ${a.seed.title}`, onclick: () => playMix(a.seed), ...hoverWarm(a.seed) },
      h('img', { src: cover(a.seed), alt: '', loading: 'lazy' }),
      h('span', { class: 'card-play', icon: 'play' }),
      h('div', { class: 'card-title' }, `Mix de ${a.seed.title}`),
      h('div', { class: 'card-sub' }, `Baseado em ${a.name}`))));

  shelf('Seus álbuns', state.lib.albums.slice(0, 10).map((a) => releaseCard(a)));
  shelf('Artistas que você segue', state.lib.artists.slice(0, 10).map((a) => releaseCard(a, 'artist')));

  page.append(h('h2', null, 'Explorar gêneros'),
    h('div', { class: 'chips' },
      GENRES.map((g) => h('button', { class: 'chip', onclick: () => runSearch(g, true) }, g))));
  return page;
}

function viewSearch() {
  const s = state.search;
  const page = h('div', { class: 'page' });
  if (s.status === 'loading') {
    page.append(h('h1', null, `Buscando “${s.query}”…`), h('div', { class: 'spinner', role: 'progressbar' }));
  } else if (s.status === 'error') {
    page.append(h('h1', null, 'A busca falhou'),
      h('div', { class: 'error-box' }, h('strong', null, 'O yt-dlp respondeu com erro'), s.error),
      h('button', { class: 'pill', onclick: () => runSearch(s.query) }, 'Tentar de novo'));
  } else if (!s.results.length && !s.albums.length && !s.artists.length) {
    page.append(h('div', { class: 'empty' },
      h('strong', null, `Nenhum resultado para “${s.query}”`),
      'Confira a grafia ou tente outras palavras.'));
  } else {
    const tabs = [['all', 'Tudo'], ['tracks', 'Músicas'], ['albums', 'Álbuns'], ['artists', 'Artistas']];
    page.append(h('h1', null, `Resultados para “${s.query}”`),
      h('div', { class: 'chips tabs' }, tabs.map(([id, label]) =>
        h('button', {
          class: `chip${s.tab === id ? ' on' : ''}`,
          onclick: () => { state.search.tab = id; renderView(); },
        }, label))));
    const all = s.tab === 'all';
    const none = (what) => h('div', { class: 'empty' }, h('strong', null, `Nenhum ${what} para “${s.query}”`));
    if ((all && s.artists.length) || s.tab === 'artists') {
      page.append(h('h2', null, 'Artistas'), s.artists.length
        ? h('div', { class: 'cards' }, (all ? s.artists.slice(0, 6) : s.artists).map((a) => releaseCard(a, 'artist')))
        : none('artista'));
    }
    if ((all && s.albums.length) || s.tab === 'albums') {
      page.append(h('h2', null, 'Álbuns'), s.albums.length
        ? h('div', { class: 'cards' }, (all ? s.albums.slice(0, 6) : s.albums).map((a) => releaseCard(a)))
        : none('álbum'));
    }
    if (all || s.tab === 'tracks') {
      page.append(h('h2', null, 'Músicas'), s.results.length
        ? trackList(s.results, { single: true })
        : none('música'));
    }
  }
  return page;
}

/* ---------- albuns salvos e artistas seguidos ---------- */
const isSaved = (kind, id) => (state.lib[kind] || []).some((it) => it.id === id);

/** Botao de salvar album (`kind` = 'albums') ou seguir artista ('artists'). */
function saveButton(kind, item) {
  const on = isSaved(kind, item.id);
  const album = kind === 'albums';
  const label = album ? (on ? 'Salvo' : 'Salvar') : (on ? 'Seguindo' : 'Seguir');
  return h('button', {
    class: `follow-btn${on ? ' on' : ''}`,
    'aria-pressed': String(on),
    onclick: () => (album
      ? mutate('toggle_album', { album: item }, on ? 'Álbum removido da biblioteca' : 'Álbum salvo na biblioteca')
      : mutate('toggle_artist', { artist: item }, on ? 'Você deixou de seguir' : `Seguindo ${item.title}`)),
  }, label);
}

function playButton(tracks) {
  return h('button', {
    class: 'big-play', icon: 'play', title: 'Tocar', 'aria-label': 'Tocar',
    disabled: !tracks.length, onclick: () => playFrom(tracks, state.shuffle ? Math.floor(Math.random() * tracks.length) : 0),
  });
}

function hero({ art, title, meta, hue, kind = 'Playlist' }) {
  const el = h('div', { class: 'hero' }, art, h('div', { class: 'hero-info' },
    h('div', { class: 'hero-kind' }, kind), title, h('div', { class: 'hero-meta' }, meta)));
  el.style.setProperty('--hero', hue);
  return el;
}

function listMeta(tracks) {
  return tracks.length ? `${countLabel(tracks.length)} • ${fmtTotal(tracks)}` : 'Nenhuma música ainda';
}

function viewLiked() {
  const tracks = state.lib.liked;
  const frag = h('div', null,
    hero({
      art: h('div', { class: 'hero-art liked', icon: 'heartOn' }),
      title: h('div', { class: 'hero-title' }, 'Músicas Curtidas'),
      meta: listMeta(tracks),
      hue: 24,
    }),
    h('div', { class: 'actions' }, playButton(tracks)));
  frag.append(tracks.length
    ? trackList(tracks)
    : h('div', { class: 'empty' }, h('strong', null, 'As músicas que você curtir aparecem aqui'),
        'Toque no coração ao lado de qualquer faixa.'));
  return frag;
}

function viewPlaylist(id) {
  const pl = findPlaylist(id);
  if (!pl) {
    return h('div', { class: 'page' }, h('div', { class: 'empty' },
      h('strong', null, 'Playlist não encontrada'), 'Ela pode ter sido excluída.'));
  }
  const title = h('div', { class: 'hero-title editable', title: 'Clique para renomear', onclick: () => rename() }, pl.name);

  function rename() {
    const input = h('input', { class: 'hero-title-input', value: pl.name, maxlength: 100, 'aria-label': 'Nome da playlist' });
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== pl.name) mutate('rename_playlist', { playlistId: pl.id, name });
      else input.replaceWith(title);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
    title.replaceWith(input);
    input.focus();
    input.select();
  }

  const more = h('button', {
    class: 'icon-btn', icon: 'more', 'data-menu': true, title: 'Mais opções', 'aria-label': 'Mais opções da playlist',
    onclick: (e) => openMenu(e.currentTarget, [
      { label: 'Renomear', run: rename },
      { label: 'Adicionar à fila', run: () => { pl.tracks.forEach((t) => enqueueOrStart(t)); renderQueue(); toast('Playlist adicionada à fila'); } },
      'sep',
      {
        label: 'Excluir playlist',
        run: async () => {
          if (!window.confirm(`Excluir a playlist "${pl.name}"? Isso não pode ser desfeito.`)) return;
          state.route = { name: 'home' };
          await mutate('delete_playlist', { playlistId: pl.id }, 'Playlist excluída');
        },
      },
    ]),
  });

  const frag = h('div', null,
    hero({
      art: (() => { const a = h('div', { class: 'hero-art', icon: 'note' }); return a; })(),
      title,
      meta: listMeta(pl.tracks),
      hue: hueOf(pl.id),
    }),
    h('div', { class: 'actions' }, playButton(pl.tracks), more));
  frag.append(pl.tracks.length
    ? trackList(pl.tracks, { playlistId: pl.id })
    : h('div', { class: 'empty' }, h('strong', null, 'Esta playlist está vazia'),
        'Busque uma música e use o menu ⋯ para adicioná-la aqui.'));
  return frag;
}

function enqueueOrStart(track) {
  if (!state.current) playFrom([track], 0);
  else enqueue(track, false);
}

/* ---------- paginas do catalogo (album e artista) ---------- */
// "album:ID" / "artist:ID" -> { status, data, error }. Guardar a resposta deixa o
// "voltar" instantaneo e evita buscar de novo a cada redesenho da tela.
const pages = new Map();

function loadPage(kind, id) {
  const key = `${kind}:${id}`;
  let page = pages.get(key);
  if (!page) {
    page = { status: 'loading', data: null, error: '' };
    pages.set(key, page);
    invoke(kind, { id })
      .then((data) => { page.status = 'done'; page.data = data; })
      .catch((e) => { page.status = 'error'; page.error = String(e); })
      .then(() => { if (routeKey(state.route) === key) renderView(); });
  }
  return page;
}

/** Tela de espera ou de erro enquanto a pagina do catalogo nao chegou. */
function pagePending(page, kind, id, what) {
  if (page.status === 'loading') {
    return h('div', { class: 'page' }, h('div', { class: 'spinner', role: 'progressbar' }));
  }
  const retry = () => { pages.delete(`${kind}:${id}`); renderView(); };
  return h('div', { class: 'page' },
    h('h1', null, `Não foi possível abrir ${what}`),
    h('div', { class: 'error-box' }, h('strong', null, 'O catálogo respondeu com erro'), page.error),
    h('button', { class: 'pill', onclick: retry }, 'Tentar de novo'));
}

/** Capa grande do topo; sem imagem, cai no bloco colorido com icone. */
function heroArt(url, round = false) {
  const cls = `hero-art${round ? ' round' : ''}`;
  return url ? h('img', { class: cls, src: url, alt: '' }) : h('div', { class: cls, icon: 'note' });
}

function viewAlbum(id) {
  const page = loadPage('album', id);
  if (page.status !== 'done') return pagePending(page, 'album', id, 'o álbum');
  const album = page.data;
  const meta = [linkTo(album.artist, album.artist_id && { name: 'artist', id: album.artist_id })];
  if (album.year) meta.push(` • ${album.year}`);
  meta.push(` • ${listMeta(album.tracks)}`);
  const frag = h('div', null,
    hero({
      kind: 'Álbum',
      art: heroArt(album.cover),
      title: h('div', { class: 'hero-title', title: album.title }, album.title),
      meta,
      hue: hueOf(album.id),
    }),
    h('div', { class: 'actions' }, playButton(album.tracks),
      saveButton('albums', { id: album.id, title: album.title, subtitle: album.artist || '', cover: album.cover || '' })));
  frag.append(album.tracks.length
    ? trackList(album.tracks, { album: true })
    : h('div', { class: 'empty' }, h('strong', null, 'Este álbum veio sem faixas'),
        'O catálogo não listou as músicas dele.'));
  return frag;
}

function releaseCard(item, kind = 'album') {
  const artist = kind === 'artist';
  return h('button', {
    class: `card${artist ? ' round' : ''}`,
    title: item.title,
    onclick: () => go({ name: artist ? 'artist' : 'album', id: item.id }),
  },
    item.cover ? h('img', { src: item.cover, alt: '', loading: 'lazy' }) : h('div', { class: 'card-blank', icon: 'note' }),
    h('div', { class: 'card-title' }, item.title),
    h('div', { class: 'card-sub' }, item.subtitle));
}

function viewArtist(id) {
  const page = loadPage('artist', id);
  if (page.status !== 'done') return pagePending(page, 'artist', id, 'o artista');
  const artist = page.data;
  const frag = h('div', null,
    hero({
      kind: 'Artista',
      art: heroArt(artist.cover, true),
      title: h('div', { class: 'hero-title', title: artist.name }, artist.name),
      meta: artist.top.length ? `${countLabel(artist.top.length)} em destaque` : '',
      hue: hueOf(artist.id),
    }),
    h('div', { class: 'actions' }, playButton(artist.top),
      saveButton('artists', { id: artist.id, title: artist.name, subtitle: 'Artista', cover: artist.cover || '' })));
  const body = h('div', { class: 'page' });
  if (artist.top.length) body.append(h('h2', null, 'Populares'), trackList(artist.top));
  artist.shelves.forEach((shelf) => {
    body.append(h('h2', null, shelf.title), h('div', { class: 'cards' }, shelf.items.map((it) => releaseCard(it))));
  });
  if (!artist.top.length && !artist.shelves.length) {
    body.append(h('div', { class: 'empty' }, h('strong', null, 'Nada para mostrar'),
      'O catálogo não trouxe músicas nem lançamentos deste artista.'));
  }
  frag.append(body);
  return frag;
}

function routeKey(r) {
  return r.id ? `${r.name}:${r.id}` : r.name === 'search' ? `search:${state.search.query}` : r.name;
}

function renderView() {
  const view = $('view');
  const key = routeKey(state.route);
  const keep = view.dataset.key === key ? view.scrollTop : 0;
  view.dataset.key = key;
  const r = state.route;
  const node = r.name === 'search' ? viewSearch()
    : r.name === 'liked' ? viewLiked()
    : r.name === 'playlist' ? viewPlaylist(r.id)
    : r.name === 'album' ? viewAlbum(r.id)
    : r.name === 'artist' ? viewArtist(r.id)
    : viewHome();
  view.replaceChildren(node);
  view.scrollTop = keep;
  markCurrent();
}

function go(route) {
  state.route = route;
  closeMenu();
  renderSidebar();
  renderView();
}

$('btn-home').addEventListener('click', () => go({ name: 'home' }));

/* ---------- fila ---------- */
function queueItem(track, onclick) {
  return h('button', { class: 'q-item', 'data-id': track.id, title: `Tocar ${track.title}`, onclick, ...hoverWarm(track) },
    h('img', { src: cover(track), alt: '', loading: 'lazy' }),
    h('div', { class: 't-text' },
      h('div', { class: 't-title' }, track.title),
      h('div', { class: 't-artist' }, track.artist)));
}

function renderQueue() {
  if (!state.queueOpen) return;
  const panel = $('queue-panel');
  const kids = [h('h3', null, 'Fila')];
  if (!state.current) {
    kids.push(h('div', { class: 'q-empty' }, 'Nada tocando. Escolha uma música para começar.'));
  } else {
    kids.push(h('h4', null, 'Tocando agora'),
      queueItem(state.current, () => { audio.currentTime = 0; audio.play().catch(() => {}); }));

    // 1) O que o usuario colocou na fila: toca primeiro e some ao tocar.
    kids.push(h('h4', null, 'Próximas na fila',
      state.userQueue.length ? h('button', {
        class: 'link',
        onclick: () => { state.userQueue = []; renderQueue(); },
      }, 'Limpar fila') : null));
    if (state.userQueue.length) {
      kids.push(...state.userQueue.map((t, k) => queueItem(t, () => {
        state.userQueue.splice(0, k + 1);
        state.fromUserQueue = true;
        start(t);
      })));
    } else {
      kids.push(h('div', { class: 'q-empty' }, 'Sua fila está vazia. Use ⋯ → Adicionar à fila.'));
    }

    // 2) O resto do contexto (playlist, busca...) continua depois da fila.
    const upcoming = state.queue.map((t, i) => [t, i]).slice(state.index + 1);
    const item = ([t, i]) => queueItem(t, () => { state.back.push(state.index); playAt(i); });
    const fromList = upcoming.filter(([t]) => !state.radioIds.has(t.id));
    if (fromList.length) {
      kids.push(h('h4', null, state.shuffle ? 'Depois (ordem aleatória ativa)' : 'Depois, da lista atual'),
        ...fromList.map(item));
    }

    // 3) Radio automatico: musicas parecidas, sem repetir o que ja tocou.
    const radio = upcoming.filter(([t]) => state.radioIds.has(t.id));
    if (radio.length || state.radioLoading) {
      kids.push(h('h4', null, 'Recomendadas, no mesmo estilo'));
      if (radio.length) kids.push(...radio.map(item));
      else kids.push(h('div', { class: 'q-empty' }, 'Buscando músicas parecidas…'));
    }
  }
  panel.replaceChildren(...kids);
  markCurrent();
}

/* ---------- busca ---------- */
let searchToken = 0;
let searchExtras = Promise.resolve(); // o autoteste espera albuns/artistas por aqui

async function runSearch(query, fillInput = false) {
  query = String(query).trim();
  if (!query) return;
  if (fillInput) $('search-input').value = query;
  const token = ++searchToken;
  state.search = { query, status: 'loading', results: [], albums: [], artists: [], tab: 'all', error: '' };
  go({ name: 'search' });
  // Albuns e artistas chegam por fora: a lista de musicas nao espera por eles.
  const extra = (cmd, key) => invoke(cmd, { query })
    .then((items) => {
      if (token !== searchToken) return;
      state.search[key] = items;
      if (state.route.name === 'search' && state.search.status === 'done') renderView();
    })
    .catch((e) => console.error(e));
  searchExtras = Promise.all([extra('search_albums', 'albums'), extra('search_artists', 'artists')]);
  try {
    const results = await invoke('search', { query });
    if (token !== searchToken) return;
    state.search = { ...state.search, status: 'done', results };
    // Os primeiros resultados sao os mais clicados: ja ficam prontos para tocar.
    results.slice(0, 6).forEach((t) => prewarm(t));
  } catch (e) {
    if (token !== searchToken) return;
    state.search = { ...state.search, status: 'error', results: [], error: typeof e === 'string' ? e : String(e) };
  }
  if (state.route.name === 'search') renderView();
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeSuggest();
  runSearch($('search-input').value);
});

/* ---------- sugestoes enquanto digita ---------- */
const searchInput = $('search-input');
const suggestBox = $('suggest');
const suggest = { items: [], active: -1, typed: '', token: 0, timer: 0 };

function closeSuggest() {
  suggest.token++; // descarta respostas que ainda estao a caminho
  clearTimeout(suggest.timer);
  suggest.items = [];
  suggest.active = -1;
  suggestBox.hidden = true;
  suggestBox.replaceChildren();
  searchInput.setAttribute('aria-expanded', 'false');
}

function pickSuggest(text) {
  closeSuggest();
  runSearch(text, true);
}

function renderSuggest() {
  const typed = suggest.typed.toLowerCase();
  suggestBox.replaceChildren(...suggest.items.map((text, i) => {
    // Destaca o que a sugestao acrescenta ao que ja foi digitado.
    const label = text.toLowerCase().startsWith(typed)
      ? [h('span', { class: 'suggest-typed' }, text.slice(0, typed.length)), h('b', null, text.slice(typed.length))]
      : [h('b', null, text)];
    return h('li', {
      class: i === suggest.active ? 'suggest-item active' : 'suggest-item',
      role: 'option',
      'aria-selected': String(i === suggest.active),
      // mousedown (e nao click) para agir antes de o campo perder o foco.
      onmousedown: (e) => { e.preventDefault(); pickSuggest(text); },
    }, h('span', { class: 'suggest-icon', icon: 'search' }), h('span', { class: 'suggest-text' }, label));
  }));
  suggestBox.hidden = !suggest.items.length;
  searchInput.setAttribute('aria-expanded', String(!!suggest.items.length));
}

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();
  closeSuggest();
  if (query.length < 2) return;
  const token = suggest.token;
  suggest.timer = setTimeout(async () => {
    let items = [];
    try {
      items = await invoke('suggest', { query });
    } catch (e) {
      console.error(e); // sem sugestoes a busca normal continua funcionando
    }
    if (token !== suggest.token) return;
    suggest.typed = query;
    suggest.items = items.filter((text) => text.toLowerCase() !== query.toLowerCase());
    suggest.active = -1;
    renderSuggest();
  }, 120);
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestBox.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggest.items.length;
    // -1 e "nenhuma": volta ao texto que o usuario digitou.
    suggest.active = ((suggest.active + 1 + (e.key === 'ArrowDown' ? 1 : n)) % (n + 1)) - 1;
    searchInput.value = suggest.active < 0 ? suggest.typed : suggest.items[suggest.active];
    renderSuggest();
  } else if (e.key === 'Enter' && suggest.active >= 0) {
    e.preventDefault();
    pickSuggest(suggest.items[suggest.active]);
  } else if (e.key === 'Escape') {
    closeSuggest();
  }
});

searchInput.addEventListener('blur', closeSuggest);

/* ---------- janela: botoes da barra integrada ---------- */
const appWindow = window.__TAURI__.window.getCurrentWindow();

async function syncMaximized() {
  let maximized = false;
  try {
    maximized = await appWindow.isMaximized();
  } catch (e) {
    console.error(e);
  }
  const btn = $('win-max');
  const label = maximized ? 'Restaurar' : 'Maximizar';
  btn.innerHTML = icon(maximized ? 'winRestore' : 'winMax');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

$('win-min').addEventListener('click', () => appWindow.minimize().catch(fail));
$('win-max').addEventListener('click', () => appWindow.toggleMaximize().catch(fail));
$('win-close').addEventListener('click', () => appWindow.close().catch(fail));
window.addEventListener('resize', syncMaximized);

/* ---------- atualizacao automatica ---------- */
// O Rust baixa a release nova em segundo plano e avisa por 'update-state'.
// Sem nada tocando, instala na hora; com musica, espera o clique para nao cortar a faixa.
const updatePill = $('update-pill');
let updateAuto = true; // o autoteste desliga para o app nao reiniciar no meio

function installUpdate() {
  updatePill.disabled = true;
  updatePill.textContent = 'Atualizando…';
  invoke('update_install').catch((e) => {
    updatePill.disabled = false;
    updatePill.textContent = 'Tentar atualizar de novo';
    fail(e);
  });
}

function onUpdateState(info) {
  if (!info || info.status !== 'ready') { updatePill.hidden = true; return; }
  updatePill.hidden = false;
  updatePill.disabled = false;
  updatePill.textContent = `Reiniciar para atualizar (v${info.version})`;
  updatePill.title = `Openfy ${info.version} já foi baixado. Você está na ${info.current}.`;
  if (updateAuto && !state.current) installUpdate();
}

updatePill.addEventListener('click', installUpdate);
window.__TAURI__.event.listen('update-state', (e) => onUpdateState(e.payload)).catch((e) => console.error(e));

/* ---------- motor de audio (yt-dlp gerenciado pelo app) ---------- */
const enginePill = $('engine-pill');

function onEngineState(info) {
  if (!info) return;
  state.engine = info;
  const downloading = info.status === 'downloading';
  const broken = info.status === 'error';
  enginePill.hidden = !downloading && !broken;
  enginePill.disabled = downloading;
  enginePill.classList.toggle('error', broken);
  enginePill.textContent = downloading ? 'Baixando o motor de áudio…' : 'Motor de áudio indisponível — tentar de novo';
  enginePill.title = broken ? info.error || '' : '';
  // Pronto, mas com aviso (ex.: nao deu para conferir se ha versao nova): so registra.
  if (info.status === 'ready' && info.error) console.warn(`yt-dlp: ${info.error}`);
}
enginePill.addEventListener('click', () => {
  invoke('ytdlp_install').then(onEngineState).catch(fail);
});
window.__TAURI__.event.listen('ytdlp-state', (e) => onEngineState(e.payload)).catch((e) => console.error(e));

/* ---------- autoteste ponta a ponta (so roda com OPENFY_SELFTEST definido) ---------- */
async function selftest() {
  const query = await invoke('selftest_query');
  if (!query) return;
  updateAuto = false;
  const report = (line) => invoke('selftest_report', { line });
  const t0 = Date.now();
  try {
    await runSearch(query, true);
    const s = state.search;
    if (s.status !== 'done' || !s.results.length) {
      await report(`FAIL search status=${s.status} n=${s.results.length} error=${s.error}`);
      return;
    }
    await report(`SEARCH n=${s.results.length} first=${s.results[0].title} | ${s.results[0].artist}`);
    await searchExtras;
    await report(`SEARCH-EXTRA albums=${s.albums.length} artists=${s.artists.length} firstAlbum=${(s.albums[0] || {}).title} firstArtist=${(s.artists[0] || {}).title} cards=${document.querySelectorAll('#view .card').length} roundCards=${document.querySelectorAll('#view .card.round').length} tabs=${document.querySelectorAll('#view .tabs .chip').length}`);
    await selftestCatalog(report, s.results).catch((e) => report(`CATALOG exception ${e}`));
    playFrom(s.results, 0);
    const timer = setInterval(() => {
      const ms = Date.now() - t0;
      if (audio.currentTime >= 3) {
        clearInterval(timer);
        let host = '';
        try { host = new URL(audio.src).hostname.split('.').slice(-2).join('.'); } catch (_) { host = '?'; }
        const done = `DONE currentTime=${audio.currentTime.toFixed(2)} duration=${fmt(audio.duration)} paused=${audio.paused} host=${host} history=${state.lib.history.length} rows=${document.querySelectorAll('.track').length} ms=${ms}`;
        selftestQueue(report, s.results)
          .catch((e) => report(`QUEUE exception ${e}`))
          .then(() => selftestExtras(report, s.results))
          .catch((e) => report(`EXTRAS exception ${e}`))
          .then(() => selftestNew(report))
          .catch((e) => report(`NEW exception ${e}`))
          .then(() => report(done));
      } else if (ms > 60000) {
        clearInterval(timer);
        const code = audio.error ? audio.error.code : 0;
        report(`FAIL timeout currentTime=${audio.currentTime} readyState=${audio.readyState} networkState=${audio.networkState} mediaError=${code} lastError=${state.lastError}`);
      }
    }, 500);
  } catch (e) {
    await report(`FAIL exception ${e}`);
  }
}

/** Confere os metadados do catalogo e abre de verdade as paginas de album e artista. */
async function selftestCatalog(report, results) {
  const count = (f) => results.filter(f).length;
  const first = results[0];
  await report(`CATALOG n=${results.length} cover=${count((t) => t.cover)} album=${count((t) => t.album_id)} artistId=${count((t) => t.artist_id)} dur=${count((t) => t.duration)} first=${first.title} | ${first.artist} | ${first.album} | ${first.cover ? new URL(first.cover).hostname : 'sem-capa'}`);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async (key) => {
    for (let i = 0; i < 150 && (pages.get(key) || {}).status === 'loading'; i += 1) await new Promise((r) => setTimeout(r, 100));
    return pages.get(key) || { status: 'ausente' };
  };
  const rowLinks = document.querySelectorAll('.track .t-artist .ref').length;
  const withAlbum = results.find((t) => t.album_id);
  if (withAlbum) {
    document.querySelector(`.track[data-id="${withAlbum.id}"] .t-artist .ref:last-child`).click();
    const p = await settle(`album:${withAlbum.album_id}`);
    const a = p.data || {};
    await report(`ALBUM route=${state.route.name} status=${p.status} error=${p.error} title=${a.title} artist=${a.artist} year=${a.year} tracks=${(a.tracks || []).length} rows=${document.querySelectorAll('.track').length} heroImg=${!!document.querySelector('img.hero-art')} kind=${(document.querySelector('.hero-kind') || {}).textContent} rowLinks=${rowLinks}`);
    await pause(2500); // tempo para a captura de tela pegar a pagina
    // Uma faixa vinda da pagina do album toca? E o artista no player leva a pagina dele?
    const heard = new Promise((resolve) => {
      const limit = setTimeout(() => resolve(false), 40000);
      audio.addEventListener('playing', () => { clearTimeout(limit); resolve(true); }, { once: true });
    });
    document.querySelector('#view .track .t-num').click();
    const played = await heard;
    const nowRefs = document.querySelectorAll('#now-artist .ref');
    if (nowRefs[0]) nowRefs[0].click();
    const nowAlbum = nowRefs[1] ? Math.round(nowRefs[1].getBoundingClientRect().width) : 0;
    await report(`ALBUM-PLAY nowAlbumPx=${nowAlbum} played=${played} now=${state.current && state.current.title} nowCover=${new URL($('now-thumb').src).hostname} nowRefs=${nowRefs.length} routeAfterPlayerArtist=${state.route.name}:${state.route.id}`);
  } else {
    await report(`ALBUM skipped rowLinks=${rowLinks}`);
  }
  const withArtist = results.find((t) => t.artist_id);
  if (withArtist) {
    go({ name: 'artist', id: withArtist.artist_id });
    const p = await settle(`artist:${withArtist.artist_id}`);
    const a = p.data || {};
    await report(`ARTIST status=${p.status} error=${p.error} name=${a.name} top=${(a.top || []).length} shelves=${(a.shelves || []).map((s) => `${s.title}:${s.items.length}`).join(',')} rows=${document.querySelectorAll('.track').length} cards=${document.querySelectorAll('.card').length} heroImg=${!!document.querySelector('img.hero-art')}`);
    await pause(2500);
  } else {
    await report('ARTIST skipped');
  }
  // Id que o catalogo recusa: a tela de erro aparece e "Tentar de novo" busca outra vez?
  go({ name: 'album', id: 'invalido' });
  const bad = await settle('album:invalido');
  const box = document.querySelector('#view .error-box');
  const retry = document.querySelector('#view .pill');
  if (retry) retry.click();
  await report(`PAGE-ERROR status=${bad.status} box=${!!box} text=${box ? box.textContent : ''} retried=${pages.get('album:invalido') !== bad}`);
  await settle('album:invalido');
  audio.pause();
  go({ name: 'search' });
}

/** Mede clique -> som (faixa fria x pre-carregada) e exercita as sugestoes e a barra da janela. */
async function selftestExtras(report, results) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Tempo entre o "clique" e o evento 'playing' da faixa pedida.
  const clickToSound = (track) => new Promise((resolve) => {
    const t0 = performance.now();
    const finish = (value) => { clearTimeout(limit); audio.removeEventListener('playing', onPlaying); resolve(value); };
    const onPlaying = () => { if (state.current && state.current.id === track.id) finish(Math.round(performance.now() - t0)); };
    const limit = setTimeout(() => finish(-1), 40000);
    audio.addEventListener('playing', onPlaying);
    playFrom([track], 0);
  });
  try {
    const u = await invoke('update_state');
    await report(`UPDATE current=${u.current} status=${u.status} version=${u.version} error=${u.error} pillHidden=${updatePill.hidden}`);
  } catch (e) {
    await report(`UPDATE exception ${e}`);
  }
  const untouched = results.filter((t) => !warmed.has(t.id) && !state.heard.has(t.id));
  if (untouched.length < 2) {
    await report(`INSTANT skipped untouched=${untouched.length}`);
  } else {
    const [cold, warm] = untouched;
    const coldMs = await clickToSound(cold);
    const tWarm = performance.now();
    await prewarm(warm, true);
    const prewarmMs = Math.round(performance.now() - tWarm);
    const warmMs = await clickToSound(warm);
    await report(`INSTANT coldMs=${coldMs} warmMs=${warmMs} prewarmMs=${prewarmMs} warmedTotal=${warmed.size}`);
  }

  // Sugestoes: digita com acento, espera a lista e escolhe a primeira com o mouse.
  const typed = 'legião urb';
  const tRaw = performance.now();
  const raw = await invoke('suggest', { query: typed }).catch((e) => `ERRO ${e}`);
  await report(`SUGGEST-RAW ms=${Math.round(performance.now() - tRaw)} ${Array.isArray(raw) ? `n=${raw.length} ${raw.slice(0, 3).join(' | ')}` : raw}`);
  searchInput.focus();
  searchInput.value = typed;
  const tSug = performance.now();
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  while (suggestBox.hidden && performance.now() - tSug < 6000) await sleep(50);
  const sugMs = Math.round(performance.now() - tSug);
  const items = [...suggestBox.querySelectorAll('.suggest-item')];
  const shown = items.map((li) => li.textContent);
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const arrowValue = searchInput.value;
  let picked = '';
  if (items.length) {
    suggestBox.querySelector('.suggest-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    picked = state.search.query;
  }
  await report(`SUGGEST typed=${typed} n=${shown.length} ms=${sugMs} first=${shown[0]} arrow=${arrowValue} picked=${picked} closed=${suggestBox.hidden} route=${state.route.name}`);

  // Janela sem moldura do sistema: os botoes proprios precisam responder.
  const before = await appWindow.isMaximized();
  $('win-max').click();
  await sleep(700);
  const during = await appWindow.isMaximized();
  const titleDuring = $('win-max').title;
  $('win-max').click();
  await sleep(700);
  const after = await appWindow.isMaximized();
  await report(`WINDOW decorated=${await appWindow.isDecorated().catch(() => '?')} max=${before}>${during}>${after} label=${titleDuring}>${$('win-max').title} logo=${$('brand-logo').naturalWidth}x${$('brand-logo').naturalHeight} font=${getComputedStyle(document.querySelector('.brand-name')).fontFamily.split(',')[0]}`);
}

/** Exercita o que entrou nos itens 1 a 5: biblioteca, versao da faixa, letra, motor, atalhos, sessao e inicio. */
async function selftestNew(report) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms) => {
    const t0 = performance.now();
    while (!test() && performance.now() - t0 < ms) await sleep(100);
    return test();
  };
  const step = async (name, fn) => {
    try { await report(`${name} ${await fn()}`); } catch (e) { await report(`${name} exception ${e}`); }
  };
  const key = (k, extra = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

  // Versao do album: a faixa tem de ser a gravacao do album, nao o clipe (radio edit).
  let albumData = null;
  await step('ALBUM-ATV', async () => {
    albumData = await invoke('album', { id: 'MPREb_7ltM34kr0mH' });
    const t = albumData.tracks[0];
    return `album=${albumData.title} tracks=${albumData.tracks.length} first=${t.title} id=${t.id} duration=${t.duration} isClip=${t.id === 'FGBhQbmPwH8'}`;
  });

  // Salvar album e seguir artista: liga, confere, desliga — a biblioteca termina como estava.
  await step('SAVE', async () => {
    const rel = { id: albumData.id, title: albumData.title, subtitle: albumData.artist || '', cover: albumData.cover || null };
    const before = isSaved('albums', rel.id);
    await mutate('toggle_album', { album: rel });
    const mid = isSaved('albums', rel.id);
    const tiles = document.querySelectorAll('.lib-tile').length;
    await mutate('toggle_album', { album: rel });
    return `album=${before}>${mid}>${isSaved('albums', rel.id)} tilesMid=${tiles} tilesAfter=${document.querySelectorAll('.lib-tile').length}`;
  });
  await step('FOLLOW', async () => {
    const found = await invoke('search_artists', { query: 'daft punk' });
    const rel = found[0];
    const before = isSaved('artists', rel.id);
    await mutate('toggle_artist', { artist: rel });
    const mid = isSaved('artists', rel.id);
    await mutate('toggle_artist', { artist: rel });
    return `artist=${rel.title} ${before}>${mid}>${isSaved('artists', rel.id)}`;
  });

  // Toca a faixa do album para os testes de letra, atalhos e retomada.
  const track = albumData.tracks[0];
  playFrom(albumData.tracks, 0);
  await until(() => state.current && state.current.id === track.id && !state.loading && audio.currentTime > 1, 40000);
  await report(`ALBUM-PLAY title=${state.current.title} audioDuration=${Math.round(audio.duration)} listed=${track.duration} t=${audio.currentTime.toFixed(1)}`);

  // Letra: so contagens, nunca o texto.
  await step('LYRICS', async () => {
    const l = await invoke('lyrics', { title: track.title, artist: track.artist, album: track.album || null, duration: track.duration || null });
    return l ? `synced=${l.synced.length} plainChars=${l.plain.length} instrumental=${l.instrumental} firstAt=${l.synced.length ? l.synced[0].time : '-'}` : 'none';
  });
  await step('LYRICS-UI', async () => {
    $('btn-lyrics').click();
    await until(() => (lyricsCache.get(track.id) || {}).status !== 'loading' && lyricsCache.has(track.id), 12000);
    await sleep(300);
    const panel = $('lyrics-panel');
    const lines = panel.querySelectorAll('.lyric');
    const last = lyricsCache.get(track.id).data;
    const at = last && last.synced.length ? last.synced[Math.min(3, last.synced.length - 1)].time : 0;
    if (lines.length) { lines[Math.min(3, lines.length - 1)].click(); await sleep(900); }
    const out = `open=${!panel.hidden} status=${lyricsCache.get(track.id).status} lines=${lines.length} on=${panel.querySelectorAll('.lyric.on').length} clickSeek=${at.toFixed(1)}>${audio.currentTime.toFixed(1)} width=${panel.clientWidth} btnOn=${$('btn-lyrics').classList.contains('on')}`;
    $('btn-lyrics').click();
    return `${out} closed=${panel.hidden}`;
  });

  await step('ENGINE', async () => {
    const e = await invoke('ytdlp_state');
    return `status=${e.status} source=${e.source} version=${e.version} error=${e.error} pillHidden=${enginePill.hidden}`;
  });

  await step('KEYS', async () => {
    const t0 = audio.currentTime;
    key('ArrowRight');
    await sleep(700);
    const fwd = audio.currentTime - t0;
    const v0 = audio.volume;
    key('ArrowDown', { ctrlKey: true });
    const v1 = audio.volume;
    key('ArrowUp', { ctrlKey: true });
    key('m');
    const muted = audio.volume === 0 || audio.muted;
    key('m');
    key('l');
    const lyr = state.lyricsOpen;
    key('q');
    const que = state.queueOpen;
    key('q');
    const liked0 = isLiked(track.id);
    key('f');
    await sleep(500);
    const liked1 = isLiked(track.id);
    key('f');
    await sleep(500);
    return `right=+${fwd.toFixed(1)}s volume=${v0.toFixed(2)}>${v1.toFixed(2)}>${audio.volume.toFixed(2)} mute=${muted} l=${lyr} q=${que} panelsClosed=${!state.queueOpen && !state.lyricsOpen} like=${liked0}>${liked1}>${isLiked(track.id)}`;
  });
  await step('MEDIA', async () => {
    const ms = navigator.mediaSession;
    const meta = ms.metadata;
    return `state=${ms.playbackState} title=${meta && meta.title} artist=${meta && meta.artist} album=${meta && meta.album} art=${meta ? meta.artwork.length : 0}`;
  });

  // Sessao: grava uma de teste, le de volta e devolve o arquivo ao que era.
  await step('SESSION', async () => {
    const original = await invoke('load_session');
    const mine = { ...snapshotSession(), position: 42 };
    await invoke('save_session', { session: mine });
    const back = await invoke('load_session');
    await invoke('save_session', { session: original || { queue: [], index: -1, current: null, position: 0, user_queue: [] } });
    const restored = await invoke('load_session');
    return `hadOriginal=${!!original} saved=${back && back.current && back.current.id === track.id} position=${back && back.position} queue=${back && back.queue.length} restoredSame=${JSON.stringify(restored && restored.current && restored.current.id) === JSON.stringify(original && original.current && original.current.id)}`;
  });

  // Retomada: simula o app reabrindo (sem audio carregado) e da play.
  await step('RESUME', async () => {
    const snap = { ...snapshotSession(), position: 42 };
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    const ok = applySession(snap);
    const label = $('time-cur').textContent;
    const paused = audio.paused;
    togglePlay();
    await until(() => !state.loading && !audio.paused && audio.currentTime > 40, 40000);
    return `applied=${ok} label=${label} pausedBefore=${paused} resumedAt=${audio.currentTime.toFixed(1)} title=${state.current.title}`;
  });

  await step('HOME', async () => {
    audio.pause();
    go({ name: 'home' });
    await sleep(400);
    const titles = [...document.querySelectorAll('#view h2')].map((x) => x.textContent).join(' | ');
    const plays = state.lib.plays;
    const top = topPlays()[0];
    return `shelves=${titles} cards=${document.querySelectorAll('#view .card').length} round=${document.querySelectorAll('#view .card.round').length} plays=${plays.length} topCount=${top ? top.count : 0} history=${state.lib.history.length}`;
  });
}

/** Monta uma fila sobre os resultados da busca e relata o painel e a ordem realmente tocada. */
async function selftestQueue(report, results) {
  if (results.length < 6) {
    await report(`QUEUE skipped n=${results.length}`);
    return;
  }
  const pos = (id) => results.findIndex((t) => t.id === id);
  addToQueue(results[3]);
  addToQueue(results[5]);
  playNext(results[4]);
  if (!state.queueOpen) document.getElementById('btn-queue').click();
  renderQueue();

  const sections = [];
  document.querySelectorAll('#queue-panel h4, #queue-panel .q-item').forEach((el) => {
    if (el.tagName === 'H4') sections.push({ name: el.firstChild.textContent, ids: [] });
    else if (sections.length) sections[sections.length - 1].ids.push(pos(el.dataset.id));
  });
  await report(`QUEUE panel ${sections.map((s) => `${s.name}=[${s.ids.join(',')}]`).join(' ')}`);

  // Espera a faixa atual realmente tocar (audio andando), nao so o estado mudar.
  const playing = () => new Promise((resolve) => {
    const id = state.current.id;
    const t0 = Date.now();
    const timer = setInterval(() => {
      const ok = state.current.id === id && !state.loading && audio.currentTime >= 1;
      if (ok || Date.now() - t0 > 40000) { clearInterval(timer); resolve(ok); }
    }, 250);
  });
  const order = [];
  for (let k = 0; k < 4; k += 1) {
    next();
    const ok = await playing();
    order.push(`${pos(state.current.id)}${ok ? '' : '(nao tocou)'}`);
  }
  await report(`QUEUE order=${order.join(',')} expected=4,3,5,1 userQueueLeft=${state.userQueue.length} index=${state.index}`);

  // Radio: uma faixa sozinha deve puxar recomendadas ineditas e emendar nelas quando acabar.
  const until = (cond, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond() || Date.now() - t0 > ms) { clearInterval(timer); resolve(cond()); }
    }, 250);
  });
  const heardBefore = new Set(state.heard);
  const seed = results[2];
  playFrom([seed], 0);
  await playing();
  await until(() => !state.radioLoading && state.radioIds.size > 0, 40000);
  const radio = state.queue.filter((t) => state.radioIds.has(t.id));
  const repeated = radio.filter((t) => heardBefore.has(t.id) || t.id === seed.id).length;
  const labels = [...document.querySelectorAll('#queue-panel h4')].map((el) => el.firstChild.textContent).join(' / ');
  await report(`RADIO seed=${seed.title} n=${radio.length} repeated=${repeated} panel=${labels} first3=${radio.slice(0, 3).map((t) => `${t.title} (${t.artist})`).join(' ; ')}`);
  // Pula para o fim da faixa: quem avanca e o evento 'ended' de verdade, nao o teste.
  if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration - 2;
  const advanced = await until(() => state.current.id !== seed.id, 30000);
  const ok = advanced && await playing();
  await report(`RADIO autoadvance=${advanced} played=${ok} nowIsRadio=${state.radioIds.has(state.current.id)} now=${state.current.title} (${state.current.artist})`);

  if (results.length < 10) {
    await report(`CLICK skipped n=${results.length}`);
    return;
  }
  // Cliques: eventos de DOM nos elementos reais da tela (mesmos handlers do mouse).
  go({ name: 'search' });
  const row = (t) => document.querySelector(`#view .track[data-id="${t.id}"]`);
  const [a, b, c] = [results[6], results[7], results[8]];

  row(a).querySelector('.t-num').click();
  const aOk = await playing();
  const emptyText = (document.querySelector('#queue-panel .q-empty') || {}).textContent || '';
  await report(`CLICK row current=${state.current.id === a.id} played=${aOk} contextLen=${state.queue.filter((t) => !state.radioIds.has(t.id)).length} emptyQueueText=${emptyText}`);

  row(b).querySelector('.t-more').click();
  const menuItem = [...document.querySelectorAll('#menu button')].find((el) => el.textContent === 'Adicionar à fila');
  if (menuItem) menuItem.click();
  const inPanel = !!document.querySelector(`#queue-panel .q-item[data-id="${b.id}"]`);
  await report(`CLICK menu found=${!!menuItem} userQueue=${state.userQueue.map((t) => pos(t.id)).join(',')} expected=7 inPanel=${inPanel} menuClosed=${document.getElementById('menu').hidden}`);

  document.getElementById('btn-next').click();
  const bOk = await playing();
  await report(`CLICK next current=${state.current.id === b.id} played=${bOk} userQueueLeft=${state.userQueue.length}`);

  row(c).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const cOk = await playing();
  await report(`CLICK dblclick current=${state.current.id === c.id} played=${cOk}`);

  await until(() => !state.radioLoading && state.radioIds.size > 0, 40000);
  const heads = [...document.querySelectorAll('#queue-panel h4')];
  const recHead = heads.find((el) => el.firstChild.textContent.startsWith('Recomendadas'));
  const recItem = recHead && recHead.nextElementSibling;
  if (recItem && recItem.classList.contains('q-item')) {
    const wanted = recItem.dataset.id;
    recItem.click();
    const rOk = await playing();
    await report(`CLICK recommended current=${state.current.id === wanted} played=${rOk} isRadio=${state.radioIds.has(wanted)} now=${state.current.title}`);
  } else {
    await report('CLICK recommended item-not-found');
  }

  // Radio sem nada inedito: marca o Mix inteiro da faixa como ja ouvido e deixa ela acabar.
  const lone = results[9];
  // O Mix varia a cada chamada: repete ate duas buscas seguidas nao trazerem nada novo.
  const mix = new Set();
  for (let round = 0, dry = 0; round < 10 && dry < 2; round += 1) {
    const before = mix.size;
    (await invoke('related', { id: lone.id })).forEach((t) => mix.add(t.id));
    dry = mix.size === before ? dry + 1 : 0;
  }
  mix.forEach((id) => state.heard.add(id));
  // Mesmo assim o app pode achar ineditas: marca essas tambem e toca de novo ate vir vazio.
  let loneOk = false;
  let freshAfter = -1;
  let rounds = 0;
  const toastEl = document.getElementById('toast');
  const warnedNow = () => !toastEl.hidden && toastEl.textContent.includes('parecidas');
  let warned = false;
  while (!warned && rounds < 25) {
    rounds += 1;
    state.radioIds.forEach((id) => state.heard.add(id));
    playFrom([lone], 0);
    await until(() => state.radioLoading, 5000);
    await until(() => !state.radioLoading, 40000);
    loneOk = await playing();
    freshAfter = state.radioIds.size;
    if (freshAfter !== 0) continue;
    // Fim da faixa: o app busca de novo; so avisa se essa busca tambem vier vazia.
    if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration - 2;
    await until(() => warnedNow() || state.current.id !== lone.id, 40000);
    warned = warnedNow();
  }
  await report(`RADIO-EMPTY mix=${mix.size} rounds=${rounds} heard=${state.heard.size} played=${loneOk} fresh=${freshAfter} warned=${warned} toast=${toastEl.textContent} stillOnTrack=${state.current.id === lone.id} paused=${audio.paused} waiting=${state.radioWaiting}`);
}

/* ---------- inicio ---------- */
async function init() {
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  let saved = 80;
  try {
    const raw = Number(localStorage.getItem('openfy.volume'));
    if (localStorage.getItem('openfy.volume') !== null && raw >= 0 && raw <= 100) saved = raw;
  } catch (_) { /* usa o padrao */ }
  applyVolume(saved, false);
  syncMaximized();
  try {
    state.lib = await invoke('get_library');
  } catch (e) {
    fail(e);
  }
  renderSidebar();
  renderView();
  renderPlayer();
  // O evento pode ter saido antes de a pagina escutar: pega o estado atual tambem.
  invoke('update_state').then(onUpdateState).catch((e) => console.error(e));
  invoke('ytdlp_state').then(onEngineState).catch((e) => console.error(e));
  // No autoteste a sessao do usuario fica intocada: nem e lida, nem e regravada.
  const testing = await invoke('selftest_query').catch(() => null);
  if (!testing) await restoreSession().catch((e) => console.error(e));
  sessionReady = !testing;
  selftest().catch((e) => console.error(e));
}

init();
