'use strict';

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const state = {
  lib: { liked: [], playlists: [], history: [] },
  route: { name: 'home' },
  search: { query: '', status: 'idle', results: [], error: '' },
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
  state.current = track;
  // Uma faixa que comeca a tocar nao deve continuar esperando na fila.
  state.userQueue = state.userQueue.filter((t) => t.id !== track.id);
  state.loading = true;
  state.retried = isRetry;
  if (!isRetry) state.historyLogged = false;
  state.played.add(track.id);
  state.heard.add(track.id);
  state.radioWaiting = false;
  audio.pause();
  renderPlayer();
  markCurrent();
  renderQueue();
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
  const cur = seeking ? (seek.value / 1000) * d : audio.currentTime;
  $('time-cur').textContent = fmt(cur);
  $('time-dur').textContent = fmt(d);
  if (!seeking) seek.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
  setFill(seek, seek.value / 10);
}

audio.addEventListener('timeupdate', renderProgress);
audio.addEventListener('durationchange', renderProgress);
seek.addEventListener('input', () => { seeking = true; renderProgress(); });
seek.addEventListener('change', () => {
  const d = duration();
  if (d) audio.currentTime = (seek.value / 1000) * d;
  seeking = false;
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
$('btn-queue').addEventListener('click', () => {
  state.queueOpen = !state.queueOpen;
  $('app').classList.toggle('queue-open', state.queueOpen);
  $('queue-panel').hidden = !state.queueOpen;
  renderQueue();
  renderPlayer();
});

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
  if (navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === t.title) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    artwork: [{ src: cover(t) }],
  });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

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
  $('library-list').replaceChildren(...items);
  $('btn-home').classList.toggle('active', r.name === 'home');
}

$('btn-new-playlist').addEventListener('click', () => createPlaylist());

/* ---------- telas ---------- */
const GENRES = ['Pop', 'Rock', 'Sertanejo', 'Funk', 'MPB', 'Hip hop', 'Eletrônica', 'Jazz', 'Lo-fi', 'Pagode', 'Indie', 'Clássica'];

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

  const hist = state.lib.history;
  page.append(h('h2', null, 'Tocadas recentemente'));
  if (hist.length) {
    page.append(h('div', { class: 'cards' },
      hist.slice(0, 12).map((t, i) =>
        h('button', { class: 'card', title: `Tocar ${t.title}`, onclick: () => playFrom([t], 0), ...hoverWarm(t) },
          h('img', { src: cover(t), alt: '', loading: 'lazy' }),
          h('span', { class: 'card-play', icon: 'play' }),
          h('div', { class: 'card-title' }, t.title),
          h('div', { class: 'card-sub' }, t.artist)))));
  } else {
    page.append(h('div', { class: 'empty' },
      h('strong', null, 'Nada tocado ainda'),
      'Busque uma música acima e o que você ouvir aparece aqui.'));
  }

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
  } else if (!s.results.length) {
    page.append(h('div', { class: 'empty' },
      h('strong', null, `Nenhum resultado para “${s.query}”`),
      'Confira a grafia ou tente outras palavras.'));
  } else {
    page.append(h('h1', null, `Resultados para “${s.query}”`), trackList(s.results, { single: true }));
  }
  return page;
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
    h('div', { class: 'actions' }, playButton(album.tracks)));
  frag.append(album.tracks.length
    ? trackList(album.tracks, { album: true })
    : h('div', { class: 'empty' }, h('strong', null, 'Este álbum veio sem faixas'),
        'O catálogo não listou as músicas dele.'));
  return frag;
}

function releaseCard(item) {
  return h('button', { class: 'card', title: item.title, onclick: () => go({ name: 'album', id: item.id }) },
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
    h('div', { class: 'actions' }, playButton(artist.top)));
  const body = h('div', { class: 'page' });
  if (artist.top.length) body.append(h('h2', null, 'Populares'), trackList(artist.top));
  artist.shelves.forEach((shelf) => {
    body.append(h('h2', null, shelf.title), h('div', { class: 'cards' }, shelf.items.map(releaseCard)));
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

async function runSearch(query, fillInput = false) {
  query = String(query).trim();
  if (!query) return;
  if (fillInput) $('search-input').value = query;
  const token = ++searchToken;
  state.search = { query, status: 'loading', results: [], error: '' };
  go({ name: 'search' });
  try {
    const results = await invoke('search', { query });
    if (token !== searchToken) return;
    state.search = { query, status: 'done', results, error: '' };
    // Os primeiros resultados sao os mais clicados: ja ficam prontos para tocar.
    results.slice(0, 6).forEach((t) => prewarm(t));
  } catch (e) {
    if (token !== searchToken) return;
    state.search = { query, status: 'error', results: [], error: typeof e === 'string' ? e : String(e) };
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
  selftest().catch((e) => console.error(e));
}

init();
