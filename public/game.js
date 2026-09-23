/* ══════════════════════════════════════════════
   MR. SCHADENFREUDE — GAME CLIENT
   game.js
══════════════════════════════════════════════ */
/* global io */

// eslint-disable-next-line no-undef
const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 30,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 25000,
});

let pendingActionAfterConnect = null;

function showServerConnectingBanner(text) {
  const banner = document.getElementById('server-status-banner');
  const textEl = document.getElementById('server-status-text');
  if (textEl && text) textEl.textContent = text;
  else if (textEl) textEl.textContent = t('server_waking_up');
  if (banner) banner.classList.remove('hidden');
}

function hideServerConnectingBanner() {
  const banner = document.getElementById('server-status-banner');
  if (banner) banner.classList.add('hidden');
}

socket.on('connect', () => {
  hideServerConnectingBanner();
  if (pendingActionAfterConnect) {
    const fn = pendingActionAfterConnect;
    pendingActionAfterConnect = null;
    fn();
  }
});

socket.on('connect_error', () => {
  showServerConnectingBanner(t('server_waking_up'));
});

socket.on('reconnect_attempt', () => {
  showServerConnectingBanner(t('server_reconnecting'));
});

socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    socket.connect();
  }
});

// ─── STATE ───
let state = {
  lang: 'en',
  roomCode: null,
  myName: null,
  myRole: null,
  isHost: false,
  gameState: null,
  privateState: null,
  timerInterval: null,
  timerDuration: 0,
  voteSelected: null,
  sfTargetSelected: null,
  sfFrameSelected: null,
  sfKuklaSelected: null,
  sfActionConfirmed: false,
  sovalyeMode: 'protect',        // 'protect' | 'challenge'
  sovalyeTargetSelected: null,
  sovalyeActionConfirmed: false, // locks panel after confirm
  mortisyenMode: 'forensics',    // 'forensics' | 'surveillance'
  mortisyenTargetSelected: null,
  mortisyenActionConfirmed: false,
  clueHistory: [],               // all received clues for Venn intersection analysis
  chatMessages: [],              // all received chat messages for dynamic re-rendering
  shadowChatMessages: [],        // all received shadow chat messages
  lastRenderedPhase: null,       // tracks phase changes for resets
  pendingKillTarget: null,       // kukla kill order
  lastWinner: null,              // cached winner for endgame screen
  lastEndReason: null,           // cached reason for endgame screen
  endedPlayers: null,            // cached revealed cast for endgame screen
};

// ─── TRANSLATIONS & ROLES ───
function t(key, params) { return typeof I18N !== 'undefined' ? I18N.t(key, params) : key; }
function roleLabel(role) { return typeof I18N !== 'undefined' ? I18N.roleLabel(role) : role; }

const ROLE_DATA = {
  sf: { symbol: '🎩', color: '#b71c1c' },
  kukla: { symbol: '🪆', color: '#ff7043' },
  mortisyen: { symbol: '⚰️', color: '#546e7a' },
  rahibe: { symbol: '🕯️', color: '#a94fd8' },
  sovalye: { symbol: '⚔️', color: '#c9a227' },
  madman: { symbol: '🌀', color: '#ce93d8' },
  koylu: { symbol: '🌾', color: '#8a6e1a' },
};

function changeLanguage(lang) {
  state.lang = lang;
  if (typeof I18N !== 'undefined') {
    I18N.setLanguage(lang);
    I18N.applyDOM();
  }
  syncReadyUI();
  document.querySelectorAll('.lang-select').forEach(sel => {
    if (sel.value !== lang) sel.value = lang;
  });
  
  // Update sound toggle button label
  const soundLabel = document.getElementById('sound-label');
  if (soundLabel && typeof Sound !== 'undefined') {
    const isMuted = Sound.isMuted();
    soundLabel.textContent = isMuted ? (lang === 'tr' ? 'Ses Kapalı' : lang === 'ru' ? 'Без звука' : 'Muted') : (lang === 'tr' ? 'Ses Açık' : lang === 'ru' ? 'Звук вкл' : 'Sound On');
  }

  // 1. Re-render Announcements
  if (state.gameState?.announcements) {
    renderAnnouncements(state.gameState.announcements);
  }

  // 2. Re-render Mortisyen Dossier / Clues & Rahibe Tarot Ledger
  renderMorticianLedger();
  renderRahibeTarotLedger();

  // 3. Re-render Private Info & Role Details
  if (state.privateState) {
    renderPrivateInfo(state.privateState);
  }

  // 4. Re-render Chat & Shadow Chat Messages in New Language
  renderChatMessages();
  renderShadowChatMessages();

  // 5. Re-render Active Phase Panel & Main Game State
  if (state.gameState) {
    renderState(state.gameState);
    renderChaosIndicator(state.gameState);
    if (state.gameState.phase && state.gameState.phase !== 'lobby') {
      showPhasePanel(state.gameState.phase, state.gameState);
    }
  }
}

// ─── GRIMOIRE / REHBER MODAL ───
function openGrimoire(tab = 'lore') {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const modal = document.getElementById('grimoire-modal');
  if (modal) {
    if (typeof I18N !== 'undefined' && I18N.applyDOM) {
      I18N.applyDOM(modal);
    }
    modal.classList.remove('hidden');
  }
  switchGrimoireTab(tab);
}

function closeGrimoire() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const modal = document.getElementById('grimoire-modal');
  if (modal) modal.classList.add('hidden');
}

function switchGrimoireTab(tab) {
  if (typeof Sound !== 'undefined') Sound.playClick();
  ['lore', 'roles', 'rules'].forEach(tId => {
    document.getElementById('gtab-' + tId)?.classList.toggle('active', tId === tab);
    document.getElementById('gcontent-' + tId)?.classList.toggle('active', tId === tab);
  });
  // Reset scroll position so content never appears empty / hidden below previous scroll offset
  const bodyEl = document.querySelector('.grimoire-body');
  if (bodyEl) bodyEl.scrollTop = 0;
}

// ─── ROLE DETAIL DOSSIER POPUP ───
function openRoleDetail(roleKey) {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const dossier = (typeof I18N !== 'undefined' && I18N.getRoleDossier) 
    ? I18N.getRoleDossier(roleKey, state.lang) 
    : null;
  if (!dossier) return;

  const modal = document.getElementById('role-detail-modal');
  if (!modal) return;

  const iconEl = document.getElementById('rd-icon');
  if (iconEl) iconEl.textContent = dossier.icon || '🎭';

  const titleEl = document.getElementById('rd-title');
  if (titleEl) titleEl.textContent = dossier.title || roleKey;

  const badgeEl = document.getElementById('rd-badge');
  if (badgeEl) {
    badgeEl.textContent = dossier.badge || '';
    badgeEl.className = 'g-badge ' + (dossier.badgeClass || 'town');
  }

  const ovEl = document.getElementById('rd-overview');
  if (ovEl) ovEl.innerHTML = dossier.overview || '';

  const abilitiesUl = document.getElementById('rd-abilities');
  if (abilitiesUl) {
    abilitiesUl.innerHTML = (dossier.abilities || []).map(a => `<li>${a}</li>`).join('');
  }

  const rulesUl = document.getElementById('rd-rules');
  if (rulesUl) {
    rulesUl.innerHTML = (dossier.rules || []).map(r => `<li>${r}</li>`).join('');
  }

  const tipsEl = document.getElementById('rd-tips');
  if (tipsEl) tipsEl.innerHTML = dossier.tips || '';

  // Reset scroll of the role detail body
  const rdBody = modal.querySelector('.role-detail-body');
  if (rdBody) rdBody.scrollTop = 0;

  if (typeof I18N !== 'undefined' && I18N.applyDOM) {
    I18N.applyDOM(modal);
  }

  modal.classList.remove('hidden');
}

function closeRoleDetail() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const modal = document.getElementById('role-detail-modal');
  if (modal) modal.classList.add('hidden');
}

// Legacy backward compatibility
function setLang(lang) { changeLanguage(lang); }

// ─── SCREENS & NAVIGATION (History API) ───
function showScreen(id, pushHistory = true) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');

  // Hide global floating buttons during active gameplay so they never overlap in-game topbar buttons
  const globalBar = document.querySelector('.global-floating-bar');
  if (globalBar) {
    if (id === 'game') {
      globalBar.classList.add('hidden');
    } else {
      globalBar.classList.remove('hidden');
    }
  }

  if (pushHistory) {
    const targetHash = '#' + id;
    if (window.location.hash !== targetHash) {
      history.pushState({ screen: id }, '', targetHash);
    }
  }
}

// ─── LEAVE & NAVIGATION HELPERS ───
let pendingLeaveAction = null;

function leaveToLanding() {
  if (state.roomCode) {
    socket.emit('room:leave');
  }
  state.roomCode = null;
  state.myName = null;
  state.isHost = false;
  state.gameState = null;
  state.privateState = null;
  state.roleShown = false;
  state.lastWinner = null;
  state.lastEndReason = null;
  state.endedPlayers = null;
  
  // Close any open modals
  document.getElementById('leave-modal')?.classList.add('hidden');
  document.getElementById('role-modal')?.classList.add('hidden');
  document.getElementById('kill-modal')?.classList.add('hidden');
  const landingErr = document.getElementById('landing-error');
  if (landingErr) landingErr.textContent = '';
  
  showScreen('landing', false);
  if (window.location.hash !== '#landing' && window.location.hash !== '') {
    history.replaceState({ screen: 'landing' }, '', '#landing');
  }
}

function playAgain() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  if (state.roomCode) {
    socket.emit('game:playAgain');
  } else {
    showScreen('landing', false);
  }
}

function openLeaveModal(type = 'game') {
  pendingLeaveAction = type;
  const modal = document.getElementById('leave-modal');
  const title = document.getElementById('leave-modal-title');
  const desc = document.getElementById('leave-modal-desc');
  if (type === 'lobby') {
    if (title) title.textContent = t('leave_lobby_title') || t('leave_title');
    if (desc) desc.textContent = t('leave_lobby_desc');
  } else {
    if (title) title.textContent = t('leave_title');
    if (desc) desc.textContent = t('leave_desc');
  }
  if (modal) modal.classList.remove('hidden');
}

function cancelLeave() {
  const modal = document.getElementById('leave-modal');
  if (modal) modal.classList.add('hidden');
  const currentScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'landing';
  history.pushState({ screen: currentScreen }, '', '#' + currentScreen);
  pendingLeaveAction = null;
}

function confirmLeave() {
  const modal = document.getElementById('leave-modal');
  if (modal) modal.classList.add('hidden');
  pendingLeaveAction = null;
  leaveToLanding();
  window.location.hash = '#landing';
  window.location.reload();
}

// Intercept browser back button
window.addEventListener('popstate', (e) => {
  const hash = window.location.hash.replace('#', '') || 'landing';
  const currentScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'landing';
  
  if (currentScreen === 'game' && state.gameState?.phase && state.gameState.phase !== 'ended') {
    // If in active match, intercept and prompt with modal
    openLeaveModal('game');
  } else if (currentScreen === 'lobby' || hash === 'landing') {
    // If returning from lobby to landing, switch screen immediately
    leaveToLanding();
  } else if (hash === 'lobby' && state.roomCode) {
    showScreen('lobby', false);
  } else if (hash === 'game' && state.gameState) {
    showScreen('game', false);
  } else {
    leaveToLanding();
  }
});

// Protect against accidental tab close during active match
window.addEventListener('beforeunload', (e) => {
  if (state.roomCode && state.gameState?.phase && state.gameState.phase !== 'ended' && state.gameState.phase !== 'lobby') {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// ─── TABS ───
function switchTab(tab) {
  if (typeof Sound !== 'undefined') Sound.playClick();
  ['create','join'].forEach(tabId => {
    document.getElementById('tab-' + tabId)?.classList.toggle('active', tabId === tab);
    document.getElementById('tab-' + tabId + '-content')?.classList.toggle('active', tabId === tab);
  });
}

// ─── COPY ───
function copyCode() {
  if (state.roomCode) {
    if (typeof Sound !== 'undefined') Sound.playClick();
    navigator.clipboard.writeText(state.roomCode).catch(() => {});
    showToast(t('copied'), 'success');
  }
}

// ─── TOASTS ───
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const div = document.createElement('div');
  div.className = 'toast ' + type;
  div.textContent = msg;
  c.appendChild(div);
  setTimeout(() => {
    div.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => div.remove(), 300);
  }, 3000);
}

// ─── CREATE ROOM ───
function createRoom() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const name = document.getElementById('create-name').value.trim();
  if (!name) return showError('landing-error', t('error_name_required'));
  state.myName = name;

  const btn = document.getElementById('btn-create');
  if (btn) {
    btn.classList.add('btn-loading');
    setTimeout(() => btn.classList.remove('btn-loading'), 4000);
  }

  if (!socket.connected) {
    showServerConnectingBanner(t('server_waking_up'));
    showToast(t('server_waking_up'), 'info');
    pendingActionAfterConnect = () => {
      socket.emit('room:create', { name, language: state.lang });
    };
    socket.connect();
    return;
  }

  socket.emit('room:create', { name, language: state.lang });
}

// ─── JOIN ROOM ───
function joinRoom() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  const name = document.getElementById('join-name').value.trim();
  let code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code && !code.startsWith('SCH-') && code.length <= 5) {
    code = 'SCH-' + code;
  }
  if (!name) return showError('landing-error', t('error_name_required'));
  if (!code) return showError('landing-error', t('error_code_required'));
  state.myName = name;

  const btn = document.getElementById('btn-join');
  if (btn) {
    btn.classList.add('btn-loading');
    setTimeout(() => btn.classList.remove('btn-loading'), 4000);
  }

  const savedToken = localStorage.getItem('msf_token_' + code) || null;
  if (!socket.connected) {
    showServerConnectingBanner(t('server_waking_up'));
    showToast(t('server_waking_up'), 'info');
    pendingActionAfterConnect = () => {
      socket.emit('room:join', { name, code, token: savedToken });
    };
    socket.connect();
    return;
  }

  socket.emit('room:join', { name, code, token: savedToken });
}

function showError(id, msg) {
  document.getElementById('btn-create')?.classList.remove('btn-loading');
  document.getElementById('btn-join')?.classList.remove('btn-loading');
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; setTimeout(() => { el.textContent = ''; }, 3000); }
}

// ─── START GAME ───
function startGame() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  socket.emit('game:start');
}

// ─── ADD TEST BOTS ───
function addTestBots() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  socket.emit('room:addBots', { count: 1 });
}

// ─── ROOM SETTINGS ───
function updateGameModeUI(gameMode, playerCount) {
  const currentMode = gameMode || document.getElementById('setting-game-mode')?.value || 'puppetMaster';
  const descEl = document.getElementById('mode-desc-text');
  if (descEl) {
    descEl.textContent = t('mode_' + (currentMode === 'secretKiller' ? 'secret_killer_desc' : 'puppet_master_desc'));
  }
  const recBadge = document.getElementById('mode-recommend-badge');
  if (recBadge) {
    recBadge.classList.remove('hidden');
    if (currentMode === 'secretKiller') {
      recBadge.textContent = t('mode_recommend_small');
    } else {
      recBadge.textContent = t('mode_recommend_classic');
    }
  }
  const minNoteEl = document.getElementById('lobby-min-note');
  if (minNoteEl) {
    minNoteEl.textContent = currentMode === 'secretKiller'
      ? t('min_players_note_secret')
      : t('min_players_note_normal');
  }
}

function updateRoomSettings() {
  if (!state.isHost) return;
  const gameModeEl = document.getElementById('setting-game-mode');
  const gameMode = gameModeEl?.value || 'puppetMaster';
  updateGameModeUI(gameMode, state.gameState?.players?.length || 0);

  const settings = {
    gameMode,
    showVotes: document.getElementById('setting-show-votes')?.checked ?? true,
    puppetCanSkip: document.getElementById('setting-puppet-refuse')?.checked ?? true,
    nightDuration: Number(document.getElementById('setting-night')?.value || 30),
    dayDuration: Number(document.getElementById('setting-day')?.value || 90),
    voteDuration: Number(document.getElementById('setting-vote')?.value || 30),
  };
  socket.emit('room:updateSettings', { settings });
}

// ─── MOBILE VIEW TABS ───
state.mobileActiveView = 'main';

function switchMobileView(viewName) {
  if (typeof Sound !== 'undefined') Sound.playClick();
  state.mobileActiveView = viewName;

  document.querySelectorAll('.mob-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`mob-tab-${viewName}`)?.classList.add('active');

  const left = document.getElementById('game-sidebar-left');
  const main = document.getElementById('game-main-area');
  const right = document.getElementById('game-sidebar-right');

  if (left && main && right) {
    left.classList.toggle('mob-panel-active', viewName === 'players');
    main.classList.toggle('mob-panel-active', viewName === 'main');
    right.classList.toggle('mob-panel-active', viewName === 'secret');
  }

  // Clear unread dot when viewing secret info
  if (viewName === 'secret') {
    document.getElementById('mob-secret-dot')?.classList.add('hidden');
  }
}

// ─── SOCKET EVENTS ───
socket.on('room:created', ({ code, playerToken }) => {
  if (playerToken) {
    try { localStorage.setItem('msf_token_' + code, playerToken); } catch (e) {}
  }
  document.getElementById('btn-create')?.classList.remove('btn-loading');
  document.getElementById('btn-join')?.classList.remove('btn-loading');
  state.roomCode = code;
  state.isHost = true;
  document.getElementById('lobby-code').textContent = code;
  document.getElementById('host-settings')?.style.removeProperty('display');
  document.getElementById('lobby-host-actions')?.style.removeProperty('display');
  showScreen('lobby');
});

socket.on('room:joined', ({ code, playerToken }) => {
  if (playerToken) {
    try { localStorage.setItem('msf_token_' + code, playerToken); } catch (e) {}
  }
  document.getElementById('btn-create')?.classList.remove('btn-loading');
  document.getElementById('btn-join')?.classList.remove('btn-loading');
  state.roomCode = code;
  state.isHost = false;
  document.getElementById('lobby-code').textContent = code;
  const hostSettings = document.getElementById('host-settings');
  if (hostSettings) hostSettings.style.display = 'none';
  const hostActions = document.getElementById('lobby-host-actions');
  if (hostActions) hostActions.style.display = 'none';
  showScreen('lobby');
  // Reconnect check: if joining an active game, immediately request private state
  socket.emit('game:requestPrivate');
});

socket.on('error', ({ message, key }) => {
  document.getElementById('btn-create')?.classList.remove('btn-loading');
  document.getElementById('btn-join')?.classList.remove('btn-loading');
  const localizedMsg = (key && typeof I18N !== 'undefined' && t(key) !== key) ? t(key) : (message || t('unknown_error'));
  showError('landing-error', localizedMsg);
  showToast(localizedMsg, 'error');
});

socket.on('game:state', (gs) => {
  // If player explicitly left the room, completely ignore room state broadcasts
  if (!state.roomCode) {
    showScreen('landing', false);
    return;
  }

  // If player is no longer in this room's roster during lobby, return to landing
  const inRoom = gs.players && gs.players.some(p => p.id === socket.id || p.name === state.myName);
  if (!inRoom && gs.phase === 'lobby') {
    leaveToLanding();
    return;
  }

  state.gameState = gs;
  // Automatically sync isHost based on current server state
  state.isHost = (gs.host === socket.id);
  const hostSettings = document.getElementById('host-settings');
  if (hostSettings) hostSettings.style.display = state.isHost ? '' : 'none';
  const hostActions = document.getElementById('lobby-host-actions');
  if (hostActions) hostActions.style.display = state.isHost ? '' : 'none';
  
  renderState(gs);
});

socket.on('room:kicked', ({ message }) => {
  showToast(message || t('kicked_toast'), 'error');
  leaveToLanding();
});

socket.on('room:banned', ({ message }) => {
  showToast(message || t('banned_toast'), 'error');
  leaveToLanding();
});

socket.on('game:role', (priv) => {
  state.privateState = priv;
  if (priv.myRole && !state.roleShown) {
    state.roleShown = true;
    showRoleModal(priv.myRole);
  }
  renderPrivateInfo(priv);

  // Sync role badge & immediately re-render active phase panel if gameState exists
  if (state.gameState && state.gameState.phase && state.gameState.phase !== 'lobby') {
    const myRole = priv.myRole;
    const badgeEl = document.getElementById('my-role-badge');
    if (badgeEl) badgeEl.textContent = myRole ? roleLabel(myRole) : '';
    showPhasePanel(state.gameState.phase, state.gameState);
  }
});

socket.on('game:becomeKukla', ({ message, baseRole }) => {
  showToast(message, 'confirm');
  if (state.privateState) {
    state.privateState.isKukla = true;
  }
  showRoleModal(state.privateState?.myRole || baseRole || 'koylu', true);
  renderPrivateInfo(state.privateState);
  if (state.gameState) renderState(state.gameState);
});

socket.on('game:killOrder', ({ targetId, targetName, message }) => {
  const isNoOrder = !targetId || targetId === 'none';
  state.pendingKillTarget = isNoOrder ? null : targetId;
  
  if (typeof Sound !== 'undefined') {
    if (isNoOrder) Sound.playClick();
    else Sound.playKill();
  }

  const symbolEl = document.getElementById('kill-modal-symbol');
  if (symbolEl) symbolEl.textContent = isNoOrder ? '🌙' : '💀';

  document.getElementById('kill-modal-msg').textContent = message;
  
  const confirmBtn = document.getElementById('btn-confirm-kill');
  const refuseBtn = document.getElementById('btn-refuse-kill');
  const minimizeBtn = document.getElementById('btn-minimize-kill');
  const ackBtn = document.getElementById('btn-ack-no-order');

  if (isNoOrder) {
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (refuseBtn) refuseBtn.style.display = 'none';
    if (minimizeBtn) minimizeBtn.style.display = 'none';
    if (ackBtn) ackBtn.style.display = 'block';
    document.getElementById('pending-order-badge')?.classList.add('hidden');
  } else {
    if (confirmBtn) confirmBtn.style.display = 'block';
    const canSkip = state.privateState?.puppetCanSkip ?? state.gameState?.settings?.puppetCanSkip ?? true;
    if (refuseBtn) refuseBtn.style.display = canSkip ? 'block' : 'none';
    if (minimizeBtn) minimizeBtn.style.display = 'block';
    if (ackBtn) ackBtn.style.display = 'none';
  }

  document.getElementById('kill-modal').classList.remove('hidden');
});

socket.on('private:message', ({ type, message }) => {
  showToast(message, type === 'success' ? 'success' : type === 'confirm' ? 'confirm' : 'info');
});

socket.on('private:clue', (clueData) => {
  addMortisenClue(clueData);
  if (typeof Sound !== 'undefined') Sound.playClue();
  const name = typeof clueData === 'object' ? clueData.name : 'ceset';
  showToast(t('clue_from') + ' ' + name, 'confirm');

  if (state.mobileActiveView !== 'secret') {
    document.getElementById('mob-secret-dot')?.classList.remove('hidden');
  }
});

socket.on('private:tarot', (tarotData) => {
  if (!state.rahibeTarots) state.rahibeTarots = [];
  state.rahibeTarots.push(tarotData);
  if (typeof Sound !== 'undefined') Sound.playTarot();
  renderRahibeTarotLedger();
  if (state.gameState?.phase === 'dawn') {
    renderDawn(state.gameState);
  }
  if (state.mobileActiveView !== 'secret') {
    document.getElementById('mob-secret-dot')?.classList.remove('hidden');
  }
});

socket.on('game:chatMessage', (msg) => {
  if (!state.chatMessages) state.chatMessages = [];
  state.chatMessages.push(msg);
  if (state.chatMessages.length > 100) state.chatMessages.shift();
  appendChatMsg(msg);
});

socket.on('game:shadowChatMessage', (msg) => {
  if (typeof Sound !== 'undefined') Sound.playWhisper();
  if (!state.shadowChatMessages) state.shadowChatMessages = [];
  state.shadowChatMessages.push(msg);
  if (state.shadowChatMessages.length > 50) state.shadowChatMessages.shift();
  appendShadowChatMsg(msg);

  if (state.mobileActiveView !== 'secret') {
    document.getElementById('mob-secret-dot')?.classList.remove('hidden');
  }
});

socket.on('game:voteUpdate', ({ count, total }) => {
  const el = document.getElementById('vote-progress');
  const votedLabel = state.lang === 'tr' ? 'oy kullandı' : state.lang === 'ru' ? 'проголосовали' : 'voted';
  if (el) el.textContent = `${count} / ${total} ${votedLabel}`;
});

socket.on('game:ended', ({ winner, reason, players }) => {
  state.lastWinner = winner;
  state.lastEndReason = reason;
  state.endedPlayers = players;
  if (typeof Sound !== 'undefined') {
    if (winner === 'sf') Sound.playSFWin();
    else Sound.playVillagersWin();
  }
  renderEnded(winner, reason, players);
});

socket.on('room:readyUpdate', ({ readyCount, totalRequired, readyPlayers }) => {
  state.lastReadyCount = readyCount;
  state.lastTotalRequired = totalRequired;
  const isMeReady = !!(readyPlayers && socket.id && readyPlayers[socket.id]);
  state.isReady = isMeReady;
  syncReadyUI();
});

function syncReadyUI() {
  const isMeReady = !!state.isReady;
  const readyCount = state.lastReadyCount || 0;
  const totalRequired = state.lastTotalRequired || 0;

  // Topbar Ready Button
  const counterEl = document.getElementById('ready-counter');
  if (counterEl) counterEl.textContent = `${readyCount}/${totalRequired}`;
  const btnEl = document.getElementById('btn-phase-ready');
  const txtEl = document.getElementById('ready-btn-text');
  const iconEl = document.getElementById('ready-status-icon');
  if (btnEl) {
    btnEl.classList.toggle('is-ready', isMeReady);
    btnEl.title = isMeReady ? t('btn_ready_active') : t('btn_ready_title');
  }
  if (txtEl) txtEl.textContent = isMeReady ? t('btn_ready_active') : t('btn_ready');
  if (iconEl) iconEl.textContent = isMeReady ? '✅' : '⚡';

  // Prominent Ready Triggers inside all Active Phase Cards
  document.querySelectorAll('.phase-ready-trigger').forEach(btn => {
    btn.classList.toggle('is-ready', isMeReady);
    btn.title = isMeReady ? t('btn_ready_active') : t('btn_ready_title');
    const txt = btn.querySelector('.main-ready-text');
    const icon = btn.querySelector('.main-ready-icon');
    const count = btn.querySelector('.main-ready-counter');
    if (txt) txt.textContent = isMeReady ? t('btn_ready_active') : t('btn_ready');
    if (icon) icon.textContent = isMeReady ? '✅' : '⚡';
    if (count) count.textContent = `${readyCount}/${totalRequired}`;
  });
}

function setReady(val) {
  state.isReady = val !== undefined ? !!val : !state.isReady;
  if (typeof Sound !== 'undefined') Sound.playClick();
  syncReadyUI();
  socket.emit('action:setReady', { ready: state.isReady });
  if (state.isReady) {
    showToast(t('ready_toast_on'), 'confirm');
  } else {
    showToast(t('ready_toast_off'), 'info');
  }
}

function toggleReady() {
  setReady(!state.isReady);
}

socket.on('room:botsAdded', ({ count }) => {
  showToast(count === 1 ? (state.lang === 'tr' ? '🤖 1 bot eklendi' : state.lang === 'ru' ? '🤖 1 бот добавлен' : '🤖 1 bot added') : (state.lang === 'tr' ? `🤖 ${count} bot eklendi` : state.lang === 'ru' ? `🤖 Добавлено ботов: ${count}` : `🤖 ${count} bots added`), 'success');
});

// ─── STATE RENDERER ───
function renderState(gs) {
  // Lobby
  if (gs.phase === 'lobby') {
    state.myRole = null;
    state.privateState = null;
    state.roleShown = false;
    state.lastWinner = null;
    state.lastEndReason = null;
    state.endedPlayers = null;
    state.clueHistory = [];
    state.chatMessages = [];
    state.shadowChatMessages = [];
    state.isReady = false;
    state.lastRenderedPhase = null;

    const cm = document.getElementById('chat-messages');
    if (cm) cm.innerHTML = '';
    const scm = document.getElementById('shadow-chat-messages');
    if (scm) scm.innerHTML = '';

    // Close any open in-game modals
    document.getElementById('leave-modal')?.classList.add('hidden');
    document.getElementById('role-modal')?.classList.add('hidden');
    document.getElementById('kill-modal')?.classList.add('hidden');
    document.getElementById('pending-order-badge')?.classList.add('hidden');

    if (state.roomCode) {
      const codeEl = document.getElementById('lobby-code');
      if (codeEl) codeEl.textContent = state.roomCode;
    }

    showScreen('lobby');
    document.body.className = 'phase-lobby';
    renderLobbyPlayers(gs.players);
    return;
  }

  // Switch to game screen
  showScreen('game');
  document.body.className = 'phase-' + gs.phase;

  // Sync chat messages if provided and local is empty
  if (gs.chat && Array.isArray(gs.chat)) {
    if (!state.chatMessages || state.chatMessages.length === 0) {
      state.chatMessages = [...gs.chat];
      renderChatMessages();
    }
  }

  // Top bar
  document.getElementById('phase-label').textContent = t('phase_' + gs.phase) || gs.phase;
  document.getElementById('round-label').textContent = gs.round > 0 ? `${t('round')} ${gs.round}` : '';

  // Role badge
  const myRole = state.privateState?.myRole;
  document.getElementById('my-role-badge').textContent = myRole ? roleLabel(myRole) : '';

  // Player list
  renderGamePlayers(gs.players);
  renderChaosIndicator(gs);

  // Timer
  if (gs.timerEndsAt) startClientTimer(gs.timerEndsAt);

  // Announcements
  renderAnnouncements(gs.announcements);

  // Prominent Ready Bar visibility
  const readyBar = document.getElementById('phase-ready-bar');
  if (readyBar) {
    readyBar.classList.toggle('hidden', gs.phase === 'ended');
  }

  // Reset per-night UI state when entering a new night phase
  if (gs.phase === 'night' && state.lastRenderedPhase !== 'night') {
    state.sovalyeActionConfirmed = false;
    state.sovalyeTargetSelected = null;
    state.sovalyeMode = 'protect';
    state.mortisyenActionConfirmed = false;
    state.mortisyenTargetSelected = null;
    state.mortisyenMode = 'forensics';
    state.rahibeActionConfirmed = false;
    state.rahibePassed = false;
    state.rahibeTargetSelected = null;
    state.sfActionConfirmed = false;
    state.sfTargetSelected = null;
    state.sfFrameSelected = null;
    state.sfKuklaSelected = null;
  }

  // Reset vote state when entering vote phase
  if (gs.phase === 'vote' && state.lastRenderedPhase !== 'vote') {
    state.voteSelected = null;
  }

  // Clear pending puppet orders and execution modals outside night phases
  if (gs.phase !== 'night') {
    state.pendingKillTarget = null;
    document.getElementById('pending-order-badge')?.classList.add('hidden');
    document.getElementById('kill-modal')?.classList.add('hidden');
  }

  // Phase transition sound effects and ambient soundscape update
  if (state.lastRenderedPhase !== gs.phase && typeof Sound !== 'undefined') {
    Sound.setAmbience(gs.phase);
    if (gs.phase === 'night0' || gs.phase === 'night') Sound.playNightBell();
    else if (gs.phase === 'dawn' || gs.phase === 'day') Sound.playDawn();
    else if (gs.phase === 'vote') Sound.playGavel();
    else if (gs.phase === 'ended') Sound.stopAmbience();
  }

  state.lastRenderedPhase = gs.phase;

  // Phase panels
  showPhasePanel(gs.phase, gs);
  syncReadyUI();
}

// ─── LOBBY PLAYERS ───
function renderLobbyPlayers(players) {
  const ul = document.getElementById('lobby-players');
  if (!ul) return;
  const hostId = state.gameState?.host;
  const settings = state.gameState?.settings || {};

  const countBadge = document.getElementById('lobby-player-count');
  if (countBadge) countBadge.textContent = `${players.length}/15`;

  // Update Game Mode Selector UI
  const modeSelect = document.getElementById('setting-game-mode');
  const currentMode = settings.gameMode || 'puppetMaster';
  if (modeSelect && modeSelect.value !== currentMode) {
    modeSelect.value = currentMode;
  }
  updateGameModeUI(currentMode, players.length);

  ul.innerHTML = players.map((p, idx) => {
    const isHost = p.id === hostId || (!hostId && idx === 0);
    const isMe = p.name === state.myName;
    const isBot = !!p.isBot;

    const hostBadge = isHost
      ? `<span class="lobby-badge-host">👑 Host</span>`
      : '';
    const youBadge = isMe
      ? `<span class="lobby-badge-you">${t('you')}</span>`
      : '';
    const botBadge = isBot
      ? `<span class="lobby-badge-bot">🤖 Bot</span>`
      : '';

    const initial = (p.name || '?').charAt(0).toUpperCase();

    let hostActionsHtml = '';
    if (state.isHost && !isHost && !isMe) {
      hostActionsHtml = `
        <div class="lobby-host-btn-cluster">
          ${!isBot ? `<button class="lobby-mgmt-btn btn-transfer" onclick="transferHost('${p.id}', this.dataset.name)" data-name="${escHtml(p.name)}" title="${t('transfer_host_btn')}">👑</button>` : ''}
          <button class="lobby-mgmt-btn btn-kick" onclick="kickPlayer('${p.id}', this.dataset.name)" data-name="${escHtml(p.name)}" title="${t('kick_btn')}">👢</button>
          <button class="lobby-mgmt-btn btn-ban" onclick="banPlayer('${p.id}', this.dataset.name)" data-name="${escHtml(p.name)}" title="${t('ban_btn')}">🚫</button>
        </div>
      `;
    }

    return `
      <li class="lobby-player-card ${isHost ? 'is-host' : ''}${isMe ? ' is-me' : ''}${isBot ? ' is-bot' : ''}">
        <div class="player-avatar-mini">${initial}</div>
        <div class="player-info-mini">
          <span class="player-name">${escHtml(p.name)}</span>
          <span class="player-role-hint">${isHost ? t('lobby_role_host') : (isBot ? t('lobby_role_bot') : t('lobby_role_actor'))}</span>
        </div>
        ${hostActionsHtml}
        <div class="lobby-player-badges">
          ${hostBadge}
          ${botBadge}
          ${youBadge}
        </div>
      </li>
    `;
  }).join('');

  if (state.isHost && state.gameState?.settings) {
    const s = state.gameState.settings;
    const showVotesCb = document.getElementById('setting-show-votes');
    if (showVotesCb && document.activeElement !== showVotesCb) showVotesCb.checked = !!s.showVotes;
    const puppetRefuseCb = document.getElementById('setting-puppet-refuse');
    if (puppetRefuseCb && document.activeElement !== puppetRefuseCb) puppetRefuseCb.checked = !!s.puppetCanSkip;
  }
}

function transferHost(targetId, targetName) {
  if (confirm(t('transfer_host_confirm', { name: targetName }))) {
    if (typeof Sound !== 'undefined') Sound.playClick();
    socket.emit('room:transferHost', { targetId });
  }
}

function kickPlayer(targetId, targetName) {
  if (confirm(t('kick_confirm', { name: targetName }))) {
    if (typeof Sound !== 'undefined') Sound.playClick();
    socket.emit('room:kickPlayer', { targetId });
  }
}

function banPlayer(targetId, targetName) {
  if (confirm(t('ban_confirm', { name: targetName }))) {
    if (typeof Sound !== 'undefined') Sound.playClick();
    socket.emit('room:banPlayer', { targetId });
  }
}

// ─── GAME PLAYERS ───
function renderGamePlayers(players) {
  const ul = document.getElementById('game-players');
  if (!ul) return;

  const sfId = state.gameState?.sfId;
  const sfPlayer = players.find(p => p.id === sfId);
  const others = players.filter(p => p.id !== sfId);

  let html = '';

  // Mr. Schadenfreude pinned at top with identity always revealed
  if (sfPlayer) {
    const dead = !sfPlayer.alive;
    const isMe = sfPlayer.name === state.myName;
    const isDisc = !!sfPlayer.disconnected;
    const youLabel = isMe ? ` <em style="font-size:0.72rem;color:var(--gold-dim)">${t('you')}</em>` : '';
    const discBadge = isDisc ? `<span class="player-disconnected-badge" title="${t('disconnected')}">⚡ ${t('disconnected')}</span>` : '';
    html += `
      <li class="sf-list-item ${dead ? 'dead' : ''}${isMe ? ' is-me' : ''}${isDisc ? ' is-disconnected' : ''}">
        <div class="player-main-row">
          <span class="player-status-dot ${dead ? 'dead' : 'sf-dot'}"></span>
          <span class="player-name">${escHtml(sfPlayer.name)}${youLabel}</span>
          ${discBadge}
        </div>
        <div class="sf-list-badge">🎩 Mr. Schadenfreude</div>
      </li>
      <li class="sf-list-divider" aria-hidden="true"></li>`;
  }

  html += others.map(p => {
    const isMe = p.name === state.myName;
    const dead = !p.alive;
    const isDisc = !!p.disconnected;
    const youLabel = isMe ? ` <em style="font-size:0.72rem;color:var(--gold-dim)">${t('you')}</em>` : '';
    const discBadge = isDisc ? `<span class="player-disconnected-badge" title="${t('disconnected')}">⚡ ${t('disconnected')}</span>` : '';
    let roleTag = '';
    if (dead && (p.role || p.isKukla)) {
      if (p.isKukla) {
        const baseRoleStr = p.role ? ` (${roleLabel(p.role)})` : '';
        roleTag = `<div class="dead-role-badge kukla">🪆 ${roleLabel('kukla')}${baseRoleStr}</div>`;
      } else {
        roleTag = `<div class="dead-role-badge">${roleLabel(p.role)}</div>`;
      }
    }
    return `<li class="player-item-row ${dead ? 'dead' : 'alive'}${isMe ? ' is-me' : ''}${isDisc ? ' is-disconnected' : ''}">
      <div class="player-main-row">
        <span class="player-status-dot ${dead ? 'dead' : ''}"></span>
        <span class="player-name">${escHtml(p.name)}${youLabel}</span>
        ${discBadge}
      </div>
      ${roleTag}
    </li>`;
  }).join('');

  ul.innerHTML = html;
}

// ─── ANNOUNCEMENTS ───
function renderAnnouncements(list) {
  const el = document.getElementById('announcements');
  if (!el || !list?.length) return;
  const currentL = state.lang || 'tr';
  el.innerHTML = list.map(a => {
    let text = '';
    if (typeof a === 'string') {
      text = a;
    } else if (a.translations && a.translations[currentL]) {
      text = a.translations[currentL];
    } else {
      text = a.text || '';
    }
    const type = typeof a === 'object' ? (a.type || 'info') : 'info';
    return `<div class="announcement ${type}">${escHtml(text)}</div>`;
  }).join('');
}

// ─── PHASE PANELS ───
const PANEL_IDS = ['night0','night','dawn','day','vote','result','ended'];

function showPhasePanel(phase, gs) {
  PANEL_IDS.forEach(id => {
    document.getElementById('panel-' + id)?.classList.add('hidden');
  });

  if (phase !== 'night') {
    state.pendingKillTarget = null;
    document.getElementById('pending-order-badge')?.classList.add('hidden');
    document.getElementById('kill-modal')?.classList.add('hidden');
  }

  const priv = state.privateState;
  const myRole = priv?.myRole;

  switch (phase) {
    case 'night0': renderNight0(gs, myRole, priv); break;
    case 'night':  renderNight(gs, myRole, priv); break;
    case 'dawn':   renderDawn(gs); break;
    case 'day':    renderDay(gs, myRole); break;
    case 'vote':   renderVote(gs, myRole); break;
    case 'result': renderResult(gs); break;
    case 'ended':  renderEnded(gs.winner || state.lastWinner || 'villagers', gs.endReason || state.lastEndReason || '', gs.players); break;
  }
}

// Night 0
function renderNight0(gs, myRole, priv) {
  show('panel-night0');
  const sfArea = document.getElementById('sf-pick-area');
  const waitArea = document.getElementById('waiting-night0');
  const desc = document.getElementById('night0-desc');
  state.sfKuklaSelected = null;

  if (myRole === 'sf') {
    desc.textContent = t('night0_sf_desc');
    sfArea.classList.remove('hidden');
    waitArea.classList.add('hidden');
    const confirmBtn = document.getElementById('btn-confirm-pick-kukla');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.5';
    }
    const ul = document.getElementById('sf-pick-list');
    ul.className = 'target-selection-grid';
    ul.innerHTML = gs.players
      .filter(p => p.alive && p.name !== state.myName)
      .map(p => {
        const initial = (p.name || '?').charAt(0).toUpperCase();
        return `
          <li class="target-card" onclick="sfSelectKukla('${p.id}', this)">
            <div class="target-avatar">${initial}</div>
            <div class="target-name">${escHtml(p.name)}</div>
            <div class="target-pill">${t('pill_pick_kukla')}</div>
          </li>
        `;
      })
      .join('');
  } else {
    sfArea.classList.add('hidden');
    waitArea.classList.remove('hidden');
    desc.textContent = '';
    const waitP = document.querySelector('#waiting-night0 p');
    if (waitP) waitP.textContent = t('night0_wait');
  }
}

function sfSelectKukla(targetId, el) {
  if (typeof Sound !== 'undefined') Sound.playClick();
  document.querySelectorAll('#sf-pick-list .target-card').forEach(li => li.classList.remove('selected'));
  el.classList.add('selected');
  state.sfKuklaSelected = targetId;
  const confirmBtn = document.getElementById('btn-confirm-pick-kukla');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '1';
  }
}

function confirmSfPickKukla() {
  if (!state.sfKuklaSelected) {
    showToast(t('pick_kukla_first'), 'error');
    return;
  }
  if (typeof Sound !== 'undefined') Sound.playClick();
  const confirmBtn = document.getElementById('btn-confirm-pick-kukla');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.5';
  }
  socket.emit('action:pickKukla', { targetId: state.sfKuklaSelected });
  showToast(t('kukla_selected_toast'), 'success');
}

// Night
function renderNight(gs, myRole, priv) {
  show('panel-night');
  const area = document.getElementById('night-action-area');
  area.innerHTML = '';

  const myPlayer = gs.players.find(p => p.id === socket.id || p.name === state.myName);
  const isAlive = (myPlayer?.alive ?? priv?.alive) ?? true;

  if (!isAlive) {
    area.innerHTML = `
      <div class="waiting-msg dead-waiting-msg" style="padding:2.2rem 1.2rem;text-align:center">
        <div style="font-size:2.8rem;margin-bottom:0.6rem">👻 ⚰️</div>
        <p style="color:var(--gold-light);font-size:1.1rem;font-family:var(--font-title);margin-bottom:0.4rem">
          ${state.lang === 'tr' ? 'Ölüler Gece Eylem Yapamaz' : state.lang === 'ru' ? 'Мертвые не могут действовать ночью' : 'The Dead Cannot Act'}
        </p>
        <p style="color:var(--text-muted);font-size:0.9rem;font-style:italic;max-width:380px;margin:0 auto">
          ${state.lang === 'tr' ? 'Ruhun sessizliğe büründü. Köyün kaderini gölgelerden izliyorsun...' : state.lang === 'ru' ? 'Твой дух погрузился в тишину. Ты наблюдаешь за судьбой деревни из теней...' : 'Your spirit rests in peace. You watch the village fate from the shadows...'}
        </p>
      </div>
    `;
    return;
  }

  if (myRole === 'sf') {
    renderSFNightPanel(gs, priv, area);
  } else if (myRole === 'sovalye') {
    renderSovalyeNightPanel(gs, area);
  } else if (myRole === 'mortisyen') {
    renderMortisyenNightPanel(gs, area);
  } else if (myRole === 'rahibe') {
    renderRahibeNightPanel(gs, area);
  } else {
    const descs = { madman: t('night_madman'), koylu: t('night_koylu') };
    area.innerHTML = `<div class="waiting-msg"><div class="gothic-spinner"></div><p>${descs[myRole] || t('night_koylu')}</p></div>`;
  }

  // If player is Kukla, show overlay banner inside night panel
  if (priv?.isKukla) {
    const kuklaBanner = document.createElement('div');
    kuklaBanner.className = 'kukla-night-overlay-banner';
    kuklaBanner.innerHTML = `
      <div class="kukla-overlay-icon">🪆</div>
      <div class="kukla-overlay-content">
        <div class="kukla-overlay-title">${state.lang === 'tr' ? 'Mr. Schadenfreude Kuklasısın' : state.lang === 'ru' ? 'Ты кукла Mr. Schadenfreude' : 'You are Mr. Schadenfreude\'s Puppet'}</div>
        <div class="kukla-overlay-desc">${state.lang === 'tr' ? `Kendi ${roleLabel(myRole)} yeteneğini kullanabilirsin. Efendin infaz emrini verdiğinde ekranda belirecektir.` : state.lang === 'ru' ? `Ты можешь использовать способность роли ${roleLabel(myRole)}. Когда хозяин отдаст приказ об убийстве, он появится на экране.` : `You can use your ${roleLabel(myRole)} ability. When your master issues an execution order, it will pop up.`}</div>
      </div>
    `;
    area.prepend(kuklaBanner);
  }
}

function renderSFNightPanel(gs, priv, area) {
  const kuklaName = priv?.kuklaName;
  const canPick = priv?.canPickKukla;
  const cond = priv?.sfCanPickCondition;
  const isSecretSF = !!gs.isSecretSF || !!priv?.isSecretKiller;

  // In Classic Puppet Master mode, if no kukla is active:
  if (!isSecretSF && canPick) {
    area.innerHTML = `
      <div class="night-action-box">
        <div class="sf-info-banner">
          <span class="sf-status-pill">🎩 ${t('sf_no_kukla')}</span>
          <p class="sf-sub-text">${cond === 'can_pick_condition2' ? t('sf_can_pick') : `${t('sf_wait_2')} (${gs.consecutiveInnocentLynches || 0}/2)`}</p>
        </div>
      </div>`;
    if (cond === 'can_pick_condition2') {
      const ul = document.createElement('ul');
      ul.className = 'target-selection-grid';
      state.sfKuklaSelected = null;

      const confirmWrap = document.createElement('div');
      confirmWrap.style.display = 'flex';
      confirmWrap.style.justifyContent = 'center';
      confirmWrap.style.marginTop = '1.2rem';

      const btnConfirm = document.createElement('button');
      btnConfirm.className = 'btn btn-danger btn-send-order';
      btnConfirm.style.opacity = '0.5';
      btnConfirm.style.minWidth = '210px';
      btnConfirm.disabled = true;
      btnConfirm.innerHTML = `<span class="btn-shine"></span><span>${t('confirm_pick_kukla')}</span>`;
      btnConfirm.onclick = () => {
        if (!state.sfKuklaSelected) {
          showToast(t('pick_kukla_first'), 'error');
          return;
        }
        if (typeof Sound !== 'undefined') Sound.playClick();
        btnConfirm.disabled = true;
        btnConfirm.style.opacity = '0.5';
        socket.emit('action:pickKukla', { targetId: state.sfKuklaSelected });
        showToast(t('kukla_selected_toast'), 'success');
      };
      confirmWrap.appendChild(btnConfirm);

      gs.players.filter(p => p.alive && p.name !== state.myName).forEach(p => {
        const initial = (p.name || '?').charAt(0).toUpperCase();
        const li = document.createElement('li');
        li.className = 'target-card';
        li.innerHTML = `
          <div class="target-avatar">${initial}</div>
          <div class="target-name">${escHtml(p.name)}</div>
          <div class="target-pill">${t('pill_new_kukla')}</div>
        `;
        li.onclick = () => {
          if (typeof Sound !== 'undefined') Sound.playClick();
          document.querySelectorAll('#night-action-area .target-card').forEach(x => x.classList.remove('selected'));
          li.classList.add('selected');
          state.sfKuklaSelected = p.id;
          btnConfirm.disabled = false;
          btnConfirm.style.opacity = '1';
        };
        ul.appendChild(li);
      });
      const boxEl = area.querySelector('.night-action-box');
      boxEl.appendChild(ul);
      boxEl.appendChild(confirmWrap);
    }
    return;
  }

  // Check if SF already performed action this night (closes the order panel)
  const isActionDone = state.sfActionConfirmed || priv?.sfActionDone;
  if (isActionDone) {
    const isPass = (state.sfTargetSelected === 'none' || priv?.sfTarget === 'none');
    const targetPlayer = !isPass && (state.sfTargetSelected || priv?.sfTarget)
      ? gs.players.find(p => p.id === (state.sfTargetSelected || priv?.sfTarget))
      : null;
    const framedPlayer = (state.sfFrameSelected || priv?.sfFrame)
      ? gs.players.find(p => p.id === (state.sfFrameSelected || priv?.sfFrame))
      : null;

    let targetInfo = '';
    if (isPass) {
      targetInfo = isSecretSF ? t('sf_pass_done') : t('sf_no_order_done');
    } else if (targetPlayer) {
      targetInfo = isSecretSF
        ? `${t('sf_target_locked')}: <strong>${escHtml(targetPlayer.name)}</strong>`
        : `${t('sf_order_sent_to_kukla')}: <strong>${escHtml(targetPlayer.name)}</strong>`;
      if (framedPlayer) {
        targetInfo += `<br/><span style="color:var(--text-muted);font-size:0.8rem">🎭 ${t('sf_frame_locked')}: <strong>${escHtml(framedPlayer.name)}</strong></span>`;
      }
    }

    area.innerHTML = `
      <div class="night-action-box sf-done-waiting-box" style="text-align:center;padding:2.2rem 1.2rem;background:radial-gradient(ellipse at center, rgba(183,28,28,0.12) 0%, rgba(10,8,16,0.6) 80%);border:1px solid rgba(183,28,28,0.3);border-radius:8px">
        <div style="font-size:2.8rem;margin-bottom:0.6rem">${isSecretSF ? '🗡️ 🕯️' : '🎭 🪆'}</div>
        <p style="color:var(--gold-light);font-size:1.15rem;font-family:var(--font-title);margin-bottom:0.4rem">
          ${isSecretSF ? t('sf_secret_done_title') : t('sf_order_done_title')}
        </p>
        <p style="color:var(--text-muted);font-size:0.88rem;max-width:420px;margin:0 auto;line-height:1.4">
          ${isSecretSF ? t('sf_secret_done_desc') : t('sf_order_done_desc')}
        </p>
        ${targetInfo ? `<div style="margin-top:1rem;padding:0.6rem 1.1rem;background:rgba(183,28,28,0.18);border:1px solid rgba(183,28,28,0.35);border-radius:6px;display:inline-block;font-size:0.88rem;color:var(--text-light)">${targetInfo}</div>` : ''}
      </div>
    `;
    return;
  }

  // SF night action box
  const box = document.createElement('div');
  box.className = 'night-action-box sf-night-multiaction-box';

  if (isSecretSF) {
    box.innerHTML = `
      <div class="sf-info-banner" style="border-color:#ef5350">
        <div class="sf-puppet-row">
          <span class="sf-puppet-icon">🗡️</span>
          <span class="sf-puppet-label">${t('sf_direct_kill_title')}</span>
        </div>
        <p class="sf-sub-text">${t('sf_direct_kill_desc')}</p>
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="sf-info-banner">
        <div class="sf-puppet-row">
          <span class="sf-puppet-icon">🪆</span>
          <span class="sf-puppet-label">${t('sf_kukla_info')}</span>
          <span class="sf-puppet-name">${escHtml(kuklaName || '?')}</span>
        </div>
        <p class="sf-sub-text">${t('night_sf_desc')}</p>
      </div>
    `;
  }

  const validTargets = isSecretSF
    ? gs.players.filter(p => p.alive && p.name !== state.myName)
    : gs.players.filter(p => p.alive && p.id !== gs.sfId && p.id !== priv?.kuklaId);

  // Section 1: Execution Target
  const sec1 = document.createElement('div');
  sec1.className = 'sf-action-section';
  sec1.innerHTML = `<h4 class="sf-section-title">💀 1. ${isSecretSF ? t('sf_direct_kill_title') : t('send_order')} (${t('pick_target')})</h4>`;
  
  const ulKill = document.createElement('ul');
  ulKill.className = 'target-selection-grid';
  ulKill.id = 'sf-target-list';

  validTargets.forEach(p => {
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const isSelected = state.sfTargetSelected === p.id;
    const li = document.createElement('li');
    li.className = 'target-card' + (isSelected ? ' selected' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="target-avatar">${initial}</div>
      <div class="target-name">${escHtml(p.name)}</div>
      <div class="target-pill">${t('pill_kill')}</div>
    `;
    li.onclick = () => {
      if (typeof Sound !== 'undefined') Sound.playClick();
      document.querySelectorAll('#sf-target-list .target-card').forEach(x => x.classList.remove('selected'));
      li.classList.add('selected');
      state.sfTargetSelected = p.id;
      // If kill target was selected as frame target, reset framing selection
      if (state.sfFrameSelected === p.id) {
        state.sfFrameSelected = null;
        document.querySelectorAll('#sf-frame-list .target-card').forEach(x => x.classList.remove('selected'));
        const liNone = document.querySelector('#sf-frame-list .frame-card');
        if (liNone) liNone.classList.add('selected');
      }
    };
    ulKill.appendChild(li);
  });
  sec1.appendChild(ulKill);
  box.appendChild(sec1);

  // Section 2: False Evidence / Necklace Framing
  const framesLeft = priv?.sfFramesLeft !== undefined ? priv.sfFramesLeft : 0;
  const framesMax = priv?.sfFramesMax !== undefined ? priv.sfFramesMax : 0;
  if (framesLeft <= 0) {
    state.sfFrameSelected = null;
  }

  const sec2 = document.createElement('div');
  sec2.className = 'sf-action-section sf-framing-section';
  sec2.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <h4 class="sf-section-title" style="margin:0;">${t('sf_frame_title')}</h4>
      <span class="sf-frame-badge" style="font-size:0.8rem; font-weight:700; padding:3px 9px; border-radius:12px; background:${framesLeft > 0 ? '#ff8a6522' : '#ffffff11'}; color:${framesLeft > 0 ? '#ff8a65' : '#888'}; border:1px solid ${framesLeft > 0 ? '#ff8a6566' : '#444'}">
        ${t('sf_frame_uses_left')}: ${framesLeft}/${framesMax}
      </span>
    </div>
    <p class="sf-section-subtitle">${framesLeft > 0 ? t('sf_frame_desc') : t('sf_frame_exhausted')}</p>
  `;

  const ulFrame = document.createElement('ul');
  ulFrame.className = 'target-selection-grid sf-frame-grid';
  ulFrame.id = 'sf-frame-list';

  // Option 0: No framing
  const liNone = document.createElement('li');
  liNone.className = 'target-card frame-card' + (!state.sfFrameSelected ? ' selected' : '');
  liNone.innerHTML = `
    <div class="target-avatar">🚫</div>
    <div class="target-name">${t('sf_no_frame')}</div>
    <div class="target-pill">${t('pill_natural')}</div>
  `;
  liNone.onclick = () => {
    if (typeof Sound !== 'undefined') Sound.playClick();
    document.querySelectorAll('#sf-frame-list .target-card').forEach(x => x.classList.remove('selected'));
    liNone.classList.add('selected');
    state.sfFrameSelected = null;
  };
  ulFrame.appendChild(liNone);

  // Options: Living innocents to frame
  validTargets.forEach(p => {
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const isSelected = state.sfFrameSelected === p.id;
    const li = document.createElement('li');
    li.className = 'target-card frame-card' + (isSelected ? ' selected' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="target-avatar" style="border-color:#ff8a65">${initial}</div>
      <div class="target-name">${escHtml(p.name)}</div>
      <div class="target-pill" style="background:#ff8a6522;color:#ff8a65;border-color:#ff8a6566">${t('pill_frame')}</div>
    `;
    if (framesLeft <= 0) {
      li.style.opacity = '0.35';
      li.style.cursor = 'not-allowed';
      li.onclick = () => {
        if (typeof Sound !== 'undefined') Sound.playClick();
        showToast(t('sf_frame_exhausted'), 'warning');
      };
    } else {
      li.onclick = () => {
        if (typeof Sound !== 'undefined') Sound.playClick();
        if (state.sfTargetSelected && state.sfTargetSelected === p.id) {
          showToast(state.lang === 'tr' ? 'Kurbanın kendisine iftira atamazsınız, başka bir masum seçin.' : state.lang === 'ru' ? 'Нельзя оклеветать саму жертву, выберите другого невиновного.' : 'Cannot frame the victim, pick another innocent.', 'warning');
          return;
        }
        document.querySelectorAll('#sf-frame-list .target-card').forEach(x => x.classList.remove('selected'));
        li.classList.add('selected');
        state.sfFrameSelected = p.id;
      };
    }
    ulFrame.appendChild(li);
  });
  sec2.appendChild(ulFrame);
  box.appendChild(sec2);

  // Action Buttons Row (Send Order / Execute + No Order / Pass)
  const btnRow = document.createElement('div');
  btnRow.className = 'sf-action-btn-row';

  const btn = document.createElement('button');
  btn.className = 'btn btn-danger btn-send-order';
  btn.innerHTML = `<span class="btn-shine"></span><span>${isSecretSF ? '🗡️ ' + t('confirm_kill') : '🎭 ' + t('send_order')}</span>`;
  btn.onclick = () => {
    if (!state.sfTargetSelected) return showToast(t('pick_target'), 'error');
    if (typeof Sound !== 'undefined') Sound.playKill();
    socket.emit('action:sfTarget', { targetId: state.sfTargetSelected, frameId: state.sfFrameSelected });
    state.sfActionConfirmed = true;
    showToast(isSecretSF ? (state.lang === 'tr' ? '🗡️ Hedef seçildi.' : state.lang === 'ru' ? '🗡️ Цель выбрана.' : '🗡️ Target selected.') : t('order_executed_toast'), 'confirm');
    renderSFNightPanel(gs, priv, area);
  };
  btnRow.appendChild(btn);

  const btnNoOrder = document.createElement('button');
  btnNoOrder.className = 'btn btn-ghost btn-no-order';
  btnNoOrder.innerHTML = `<span>${isSecretSF ? t('sf_btn_pass_secret') : t('sf_btn_no_order')}</span>`;
  btnNoOrder.onclick = () => {
    if (typeof Sound !== 'undefined') Sound.playClick();
    socket.emit('action:sfTarget', { targetId: 'none', frameId: null });
    state.sfActionConfirmed = true;
    state.sfTargetSelected = 'none';
    state.sfFrameSelected = null;
    showToast(isSecretSF ? t('sf_btn_pass_secret_toast') : t('sf_no_order_toast'), 'info');
    renderSFNightPanel(gs, priv, area);
  };
  btnRow.appendChild(btnNoOrder);

  box.appendChild(btnRow);

  area.appendChild(box);
}

function renderSovalyeNightPanel(gs, area) {
  area.innerHTML = ''; // Clear before rebuild — prevents infinite stacking on mode toggle
  const priv = state.privateState;
  const challengesLeft = priv?.sovalyeChallengesLeft ?? 2;
  const serverConfirmed = priv?.sovalyeActionDone ?? false;


  if (state.sovalyeActionConfirmed || serverConfirmed) {
    area.innerHTML = `
      <div class="waiting-msg">
        <p style="color:var(--gold);font-size:1rem">${t('sovalye_done')}</p>
        <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.4rem">🛡️ ${t('sovalye_challenges_left', { count: challengesLeft })}</p>
      </div>`;
    return;
  }

  const box = document.createElement('div');
  box.className = 'night-action-box';

  const btnRow = document.createElement('div');
  btnRow.className = 'night-action-btns';

  const btnProtect = document.createElement('button');
  btnProtect.className = 'btn btn-sm ' + (state.sovalyeMode === 'protect' ? 'btn-primary' : 'btn-ghost');
  btnProtect.textContent = t('sovalye_protect');
  btnProtect.onclick = () => { state.sovalyeMode = 'protect'; renderSovalyeNightPanel(gs, area); };

  const btnChallenge = document.createElement('button');
  btnChallenge.className = 'btn btn-sm ' + (state.sovalyeMode === 'challenge' ? 'btn-primary' : 'btn-ghost');
  btnChallenge.textContent = `${t('sovalye_challenge')} (${challengesLeft}/2)`;
  const noCharges = challengesLeft <= 0;
  btnChallenge.disabled = noCharges;
  if (noCharges) btnChallenge.style.opacity = '0.4';
  btnChallenge.onclick = () => { if (!noCharges) { state.sovalyeMode = 'challenge'; renderSovalyeNightPanel(gs, area); } };

  btnRow.appendChild(btnProtect);
  btnRow.appendChild(btnChallenge);
  box.appendChild(btnRow);

  if (state.sovalyeMode === 'challenge') {
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'color:var(--text-dim);font-size:0.95rem;margin:1rem 0 0.5rem;text-align:center;line-height:1.5';
    infoDiv.innerHTML = t('sovalye_challenge_info');
    box.appendChild(infoDiv);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.marginTop = '0.8rem';
    btn.innerHTML = `<span class="btn-shine"></span><span>${t('sovalye_challenge')}</span>`;
    btn.onclick = () => {
      if (typeof Sound !== 'undefined') Sound.playSword();
      socket.emit('action:sovalye', { type: 'challenge' });
      state.sovalyeActionConfirmed = true;
      renderSovalyeNightPanel(gs, area);
    };
    box.appendChild(btn);

  } else {
    const ul = document.createElement('ul');
    ul.className = 'target-selection-grid';
    ul.id = 'sovalye-target-list';

    gs.players.filter(p => p.alive && p.id !== gs.sfId && p.name !== state.myName && p.id !== socket.id).forEach(p => {
      const initial = (p.name || '?').charAt(0).toUpperCase();
      const isSelected = state.sovalyeTargetSelected === p.id;
      const li = document.createElement('li');
      li.className = 'target-card' + (isSelected ? ' selected' : '');
      li.dataset.id = p.id;
      li.innerHTML = `
        <div class="target-avatar">${initial}</div>
        <div class="target-name">${escHtml(p.name)}</div>
        <div class="target-pill">${t('pill_protect')}</div>
      `;
      li.onclick = () => {
        if (typeof Sound !== 'undefined') Sound.playClick();
        document.querySelectorAll('#sovalye-target-list .target-card').forEach(x => x.classList.remove('selected'));
        li.classList.add('selected');
        state.sovalyeTargetSelected = p.id;
      };
      ul.appendChild(li);
    });
    box.appendChild(ul);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.marginTop = '0.8rem';
    btn.innerHTML = `<span class="btn-shine"></span><span>${t('sovalye_protect')}</span>`;
    btn.onclick = () => {
      if (!state.sovalyeTargetSelected) return showToast(t('pick_target'), 'error');
      if (typeof Sound !== 'undefined') Sound.playShield();
      socket.emit('action:sovalye', { type: 'protect', targetId: state.sovalyeTargetSelected });
      state.sovalyeActionConfirmed = true;
      renderSovalyeNightPanel(gs, area);
    };
    box.appendChild(btn);
  }

  area.appendChild(box);
}

function renderMortisyenNightPanel(gs, area) {
  area.innerHTML = '';
  const priv = state.privateState;
  const serverConfirmed = priv?.mortisyenActionDone ?? false;

  if (state.mortisyenActionConfirmed || serverConfirmed) {
    const isSurv = (state.mortisyenMode === 'surveillance' || priv?.mortisyenMode === 'surveillance');
    const targetPlayer = gs.players.find(p => p.id === (state.mortisyenTargetSelected || priv?.mortisyenTarget));
    area.innerHTML = `
      <div class="waiting-msg">
        <p style="color:var(--gold);font-size:1rem">${t('mortisyen_action_confirmed')}</p>
        <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.4rem">
          ${isSurv ? `🕯️ ${t('mortisyen_mode_surveillance')}: <strong>${escHtml(targetPlayer?.name || '?')}</strong>` : `🔍 ${t('mortisyen_mode_forensics')}`}
        </p>
      </div>`;
    return;
  }

  const box = document.createElement('div');
  box.className = 'night-action-box';

  box.innerHTML = `
    <div class="sf-info-banner">
      <div class="sf-puppet-row">
        <span class="sf-puppet-icon">⚰️</span>
        <span class="sf-puppet-label">${t('mortisyen_night_title')}</span>
      </div>
      <p class="sf-sub-text">${t('mortisyen_night_desc')}</p>
    </div>
  `;

  const btnRow = document.createElement('div');
  btnRow.className = 'night-action-btns';

  const btnForensics = document.createElement('button');
  btnForensics.className = 'btn btn-sm ' + (state.mortisyenMode === 'forensics' ? 'btn-primary' : 'btn-ghost');
  btnForensics.textContent = t('mortisyen_mode_forensics');
  btnForensics.onclick = () => { state.mortisyenMode = 'forensics'; renderMortisyenNightPanel(gs, area); };

  const btnSurveillance = document.createElement('button');
  btnSurveillance.className = 'btn btn-sm ' + (state.mortisyenMode === 'surveillance' ? 'btn-primary' : 'btn-ghost');
  btnSurveillance.textContent = t('mortisyen_mode_surveillance');
  btnSurveillance.onclick = () => { state.mortisyenMode = 'surveillance'; renderMortisyenNightPanel(gs, area); };

  btnRow.appendChild(btnForensics);
  btnRow.appendChild(btnSurveillance);
  box.appendChild(btnRow);

  if (state.mortisyenMode === 'forensics') {
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'color:var(--text-dim);font-size:0.92rem;margin:1rem 0 0.5rem;text-align:center;line-height:1.5';
    infoDiv.innerHTML = `<p>${t('mortisyen_forensics_desc')}</p>`;
    box.appendChild(infoDiv);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.marginTop = '0.8rem';
    btn.innerHTML = `<span class="btn-shine"></span><span>🔍 ${t('mortisyen_mode_forensics')}</span>`;
    btn.onclick = () => {
      if (typeof Sound !== 'undefined') Sound.playClue();
      socket.emit('action:mortisyen', { mode: 'forensics' });
      state.mortisyenActionConfirmed = true;
      renderMortisyenNightPanel(gs, area);
    };
    box.appendChild(btn);

  } else {
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'color:var(--text-dim);font-size:0.92rem;margin:0.8rem 0 0.4rem;text-align:center';
    infoDiv.innerHTML = `<p>${t('mortisyen_surveillance_desc')}</p><p style="font-size:0.8rem;color:var(--gold);margin-top:0.3rem">${t('mortisyen_surveillance_target')}</p>`;
    box.appendChild(infoDiv);

    const ul = document.createElement('ul');
    ul.className = 'target-selection-grid';
    ul.id = 'mortisyen-target-list';

    gs.players.filter(p => p.alive && p.name !== state.myName && p.id !== gs.sfId).forEach(p => {
      const initial = (p.name || '?').charAt(0).toUpperCase();
      const isSelected = state.mortisyenTargetSelected === p.id;
      const li = document.createElement('li');
      li.className = 'target-card' + (isSelected ? ' selected' : '');
      li.dataset.id = p.id;
      li.innerHTML = `
        <div class="target-avatar">${initial}</div>
        <div class="target-name">${escHtml(p.name)}</div>
        <div class="target-pill">${t('pill_surveil')}</div>
      `;
      li.onclick = () => {
        if (typeof Sound !== 'undefined') Sound.playClick();
        document.querySelectorAll('#mortisyen-target-list .target-card').forEach(x => x.classList.remove('selected'));
        li.classList.add('selected');
        state.mortisyenTargetSelected = p.id;
      };
      ul.appendChild(li);
    });
    box.appendChild(ul);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.marginTop = '0.8rem';
    btn.innerHTML = `<span class="btn-shine"></span><span>🕯️ ${t('mortisyen_mode_surveillance')}</span>`;
    btn.onclick = () => {
      if (!state.mortisyenTargetSelected) return showToast(t('pick_target'), 'error');
      if (typeof Sound !== 'undefined') Sound.playWhisper();
      socket.emit('action:mortisyen', { mode: 'surveillance', targetId: state.mortisyenTargetSelected });
      state.mortisyenActionConfirmed = true;
      renderMortisyenNightPanel(gs, area);
    };
    box.appendChild(btn);
  }

  area.appendChild(box);
}

function renderRahibeNightPanel(gs, area) {
  area.innerHTML = '';
  const isAvailable = state.privateState?.rahibeTarotAvailable !== false;
  const isPassed = !!state.rahibePassed || !!state.privateState?.rahibePassed;
  const isDone = state.rahibeActionConfirmed || state.privateState?.rahibeActionDone;

  if (!isAvailable) {
    area.innerHTML = `
      <div class="night-action-box" style="text-align:center;padding:1.5rem 1rem">
        <div style="font-size:2.4rem;margin-bottom:0.6rem">⏳ 🃏</div>
        <div class="sf-section-title" style="margin-bottom:0.4rem;color:#ce93d8">🃏 ${t('rahibe_cooldown_title')}</div>
        <p class="sf-section-subtitle" style="color:var(--text-muted);font-size:0.9rem;line-height:1.5;max-width:380px;margin:0 auto">${t('rahibe_cooldown_desc')}</p>
      </div>`;
    return;
  }

  if (isDone) {
    if (isPassed) {
      area.innerHTML = `
        <div class="waiting-msg">
          <p style="color:#ce93d8;font-size:1rem;font-weight:600">${t('rahibe_passed_title')}</p>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.4rem">${t('rahibe_passed_desc')}</p>
        </div>`;
    } else {
      area.innerHTML = `
        <div class="waiting-msg">
          <p style="color:var(--gold);font-size:1rem">${t('rahibe_done')}</p>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.4rem">🃏 ${t('rahibe_waiting_dawn')}</p>
        </div>`;
    }
    return;
  }

  const box = document.createElement('div');
  box.className = 'night-action-box';

  const title = document.createElement('div');
  title.className = 'sf-section-title';
  title.style.textAlign = 'center';
  title.style.marginBottom = '0.4rem';
  title.innerHTML = `🃏 ${t('rahibe_panel_title')}`;
  box.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'sf-section-subtitle';
  desc.style.textAlign = 'center';
  desc.textContent = t('rahibe_panel_desc');
  box.appendChild(desc);

  const validTargets = gs.players.filter(p => p.alive && p.name !== state.myName && p.id !== gs.sfId);
  const ul = document.createElement('ul');
  ul.className = 'target-selection-grid';
  ul.id = 'rahibe-target-list';

  validTargets.forEach(p => {
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const isSelected = state.rahibeTargetSelected === p.id;
    const li = document.createElement('li');
    li.className = 'target-card' + (isSelected ? ' selected' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="target-avatar" style="border-color:#ba68c8;background:#4a148c33;color:#e1bee7">${initial}</div>
      <div class="target-name">${escHtml(p.name)}</div>
      <div class="target-pill" style="border-color:#ba68c8;color:#f3e5f5">${t('pill_tarot')}</div>
    `;
    li.onclick = () => {
      if (typeof Sound !== 'undefined') Sound.playClick();
      document.querySelectorAll('#rahibe-target-list .target-card').forEach(x => x.classList.remove('selected'));
      li.classList.add('selected');
      state.rahibeTargetSelected = p.id;
    };
    ul.appendChild(li);
  });

  box.appendChild(ul);

  const btnSend = document.createElement('button');
  btnSend.className = 'btn btn-tarot-inspect';
  btnSend.style.marginTop = '1rem';
  btnSend.style.width = '100%';
  btnSend.innerHTML = `<span class="btn-shine"></span><span>${t('rahibe_btn_inspect')}</span>`;
  btnSend.onclick = () => {
    if (!state.rahibeTargetSelected) {
      showToast(t('pick_target'), 'error');
      return;
    }
    if (typeof Sound !== 'undefined') Sound.playTarot();
    socket.emit('action:rahibe', { targetId: state.rahibeTargetSelected });
    state.rahibeActionConfirmed = true;
    state.rahibePassed = false;
    renderRahibeNightPanel(gs, area);
  };
  box.appendChild(btnSend);

  const btnPass = document.createElement('button');
  btnPass.className = 'btn btn-tarot-pass';
  btnPass.style.marginTop = '0.6rem';
  btnPass.style.width = '100%';
  btnPass.innerHTML = `<span>${t('rahibe_btn_pass')}</span>`;
  btnPass.onclick = () => {
    if (typeof Sound !== 'undefined') Sound.playClick();
    socket.emit('action:rahibePass');
    state.rahibeActionConfirmed = true;
    state.rahibePassed = true;
    renderRahibeNightPanel(gs, area);
  };
  box.appendChild(btnPass);

  area.appendChild(box);
}

// Dawn
function renderDawn(gs) {
  show('panel-dawn');
  const el = document.getElementById('dawn-events');
  const list = gs.announcements || [];
  let html = '';
  if (!list.length) {
    html = `<div class="event-item">${t('dawn_nothing')}</div>`;
  } else {
    html = list.map(a => {
      const text = typeof a === 'string' ? a : (a.translations && a.translations[state.lang || 'tr']) || a.text || '';
      const type = typeof a === 'object' ? (a.type || 'info') : 'info';
      return `<div class="event-item ${type}">${escHtml(text)}</div>`;
    }).join('');
    // Trigger kill / death audio if someone was slain overnight
    if (typeof Sound !== 'undefined' && list.some(a => (typeof a === 'object' && (a.type === 'death' || a.type === 'danger')))) {
      setTimeout(() => { if (typeof Sound !== 'undefined') Sound.playKill(); }, 450);
    }
  }

  // If player is Rahibe and has a Tarot reading specifically for this round
  if (state.privateState?.myRole === 'rahibe') {
    const tarots = state.rahibeTarots || state.privateState?.rahibeTarots || [];
    const currentRoundTarot = tarots.find(t => Number(t.round) === Number(gs.round));
    if (currentRoundTarot) {
      const lang = state.lang || 'tr';
      const msg = (currentRoundTarot.translations && currentRoundTarot.translations[lang]) || currentRoundTarot.message || '';
      html += `
        <div class="event-item warning" style="border:1px solid #ba68c8;background:#4a148c33;color:#f3e5f5;font-weight:600;display:flex;align-items:center;gap:0.75rem;margin-top:0.75rem;padding:0.75rem 1rem;border-radius:8px">
          <span style="font-size:1.6rem">🃏</span>
          <div>
            <div style="font-size:0.75rem;color:#ba68c8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.15rem">${t('rahibe_tarot_revelation')} (${t('round')} ${currentRoundTarot.round || gs.round})</div>
            <div style="font-size:0.95rem;color:#fff">${escHtml(msg)}</div>
          </div>
        </div>
      `;
    }
  }

  el.innerHTML = html;
}

// Day
function renderDay(gs, myRole) {
  show('panel-day');
  const inputRow = document.getElementById('chat-input-row');
  const myPlayer = gs.players.find(p => p.name === state.myName);

  // SF cannot use public village chat
  if (myRole === 'sf') {
    inputRow.innerHTML = `<p style="color:var(--text-muted);font-style:italic;font-size:0.88rem">&#127917; ${t('village_chat_locked_sf')}</p>`;
    return;
  }

  if (myPlayer && !myPlayer.alive) {
    inputRow.innerHTML = `<p style="color:var(--text-muted);font-style:italic;font-size:0.88rem">${t('dead_cannot_vote')}</p>`;
  } else {
    if (!inputRow.querySelector('input')) {
      inputRow.innerHTML = `<input id="chat-input" type="text" maxlength="200" placeholder="${t('type_message')}" />
        <button class="btn btn-sm" onclick="sendChat()">➤</button>`;
      document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
    }
  }
}

function sendChat() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const msg = inp.value.trim();
  if (!msg) return;
  socket.emit('game:chat', { message: msg });
  inp.value = '';
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  const currentL = state.lang || 'tr';
  const msgs = state.chatMessages || [];
  el.innerHTML = msgs.map(msg => {
    const senderName = typeof BotTranslator !== 'undefined' ? BotTranslator.translateSender(msg, currentL) : (msg.nameTranslations?.[currentL] || msg.name);
    const text = typeof BotTranslator !== 'undefined' ? BotTranslator.translateMessage(msg, currentL) : (msg.translations?.[currentL] || msg.message);
    const isSys = msg.isSystem ? ' is-system' : '';
    const isRahibe = msg.isRahibe ? ' is-rahibe' : '';
    return `<div class="chat-msg${isSys}${isRahibe}"><span class="chat-name">${escHtml(senderName)}:</span><span class="chat-text">${escHtml(text)}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function appendChatMsg(msg) {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  const currentL = state.lang || 'tr';
  const senderName = typeof BotTranslator !== 'undefined' ? BotTranslator.translateSender(msg, currentL) : (msg.nameTranslations?.[currentL] || msg.name);
  const text = typeof BotTranslator !== 'undefined' ? BotTranslator.translateMessage(msg, currentL) : (msg.translations?.[currentL] || msg.message);
  const isSys = msg.isSystem ? ' is-system' : '';
  const isRahibe = msg.isRahibe ? ' is-rahibe' : '';
  const div = document.createElement('div');
  div.className = `chat-msg${isSys}${isRahibe}`;
  div.innerHTML = `<span class="chat-name">${escHtml(senderName)}:</span><span class="chat-text">${escHtml(text)}</span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// Vote
function renderVote(gs, myRole) {
  show('panel-vote');
  const ul = document.getElementById('vote-list');
  const skipArea = document.getElementById('vote-skip-area');

  // Mr. Schadenfreude is fully excluded from voting
  if (myRole === 'sf') {
    if (skipArea) skipArea.classList.add('hidden');
    ul.innerHTML = `<div class="vote-locked-msg"><span style="font-size:1.6rem">🎩</span><p>${t('sf_voting_locked')}</p></div>`;
    return;
  }

  const myPlayer = gs.players.find(p => p.name === state.myName);
  if (!myPlayer?.alive) {
    if (skipArea) skipArea.classList.add('hidden');
    ul.innerHTML = `<div class="vote-locked-msg"><span style="font-size:1.6rem">💀</span><p>${t('dead_cannot_vote')}</p></div>`;
    return;
  }

  if (skipArea) skipArea.classList.remove('hidden');

  // Count votes per target and identify voters
  const votes = gs.votes || {};
  const votersForTarget = {};
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (!votersForTarget[targetId]) votersForTarget[targetId] = [];
    const voter = gs.players.find(p => p.id === voterId);
    if (voter) votersForTarget[targetId].push(voter.name);
  }

  ul.innerHTML = '';
  const isSecretSF = !!gs.isSecretSF;
  // In puppetMaster mode, Mr. Schadenfreude is excluded from voteable targets; in secretKiller mode, everyone is voteable
  const sfId = gs.sfId;
  const voteablePlayers = isSecretSF
    ? gs.players.filter(p => p.alive)
    : gs.players.filter(p => p.alive && p.id !== sfId);

  voteablePlayers.forEach(p => {
    const isSelected = state.voteSelected === p.id;
    const isMe = p.name === state.myName;
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const voteCount = votersForTarget[p.id]?.length || 0;

    const li = document.createElement('li');
    li.className = 'vote-candidate-card' + (isSelected ? ' selected' : '');
    li.dataset.id = p.id;

    const voteBadgeHtml = gs.settings?.showVotes
      ? `<div class="vote-badge ${voteCount > 0 ? 'has-votes' : ''}">
           <span class="vote-badge-count">${voteCount}</span>
           <span class="vote-badge-label">${t('votes_label')}</span>
         </div>`
      : '';

    let votersHtml = '';
    if (gs.settings?.showVotes && voteCount > 0) {
      votersHtml = `
        <div class="voted-by-row">
          <span class="voted-by-tag-label">${t('voters_label')}</span>
          <div class="voted-by-chips">
            ${votersForTarget[p.id].map(name => `<span class="voted-by-badge">🗳️ ${escHtml(name)}</span>`).join('')}
          </div>
        </div>`;
    }

    li.innerHTML = `
      <div class="candidate-main-row">
        <div class="candidate-info-left">
          <div class="candidate-avatar">${initial}</div>
          <div class="candidate-name-box">
            <span class="candidate-name">${escHtml(p.name)}</span>
            ${isMe ? `<span class="candidate-you-tag">${t('you')}</span>` : ''}
          </div>
        </div>
        <div class="candidate-action-right">
          ${voteBadgeHtml}
          <div class="candidate-select-indicator">${isSelected ? t('vote_selected') : t('btn_vote')}</div>
        </div>
      </div>
      ${votersHtml}
    `;

    li.onclick = () => {
      if (state.voteSelected === p.id) {
        skipVote();
        return;
      }
      document.querySelectorAll('#vote-list .vote-candidate-card').forEach(x => x.classList.remove('selected'));
      document.getElementById('btn-skip-vote')?.classList.remove('active-skip');
      li.classList.add('selected');
      state.voteSelected = p.id;
      if (typeof Sound !== 'undefined') Sound.playVote();
      socket.emit('game:vote', { targetId: p.id });
    };

    ul.appendChild(li);
  });

  const skipBtn = document.getElementById('btn-skip-vote');
  if (skipBtn) {
    skipBtn.classList.toggle('active-skip', state.voteSelected === 'skip');
  }
}

// Result / Skip Vote
function skipVote() {
  const myRole = state.privateState?.myRole;
  if (myRole === 'sf' && !state.gameState?.isSecretSF) return; // SF cannot vote only in puppetMaster mode

  if (typeof Sound !== 'undefined') Sound.playClick();
  state.voteSelected = 'skip';
  document.querySelectorAll('#vote-list li').forEach(x => x.classList.remove('voted'));
  document.getElementById('btn-skip-vote')?.classList.add('active-skip');
  socket.emit('game:vote', { targetId: null });
  showToast(t('skipped_vote_toast'), 'info');
}

// Result
function renderResult(gs) {
  show('panel-result');
  const el = document.getElementById('result-content');
  const anns = gs.announcements || [];
  if (!anns.length) { el.innerHTML = ''; return; }
  el.innerHTML = anns.map(a => {
    const text = typeof a === 'string' ? a : (a.translations && a.translations[state.lang || 'tr']) || a.text || '';
    const type = typeof a === 'object' ? (a.type || 'info') : 'info';
    return `<div class="event-item ${type}" style="text-align:center">${escHtml(text)}</div>`;
  }).join('');

  // Trigger kill audio if an execution took place
  if (typeof Sound !== 'undefined' && anns.some(a => (typeof a === 'object' && (a.type === 'death' || a.type === 'danger' || a.id === 'lynch_executed')))) {
    setTimeout(() => { if (typeof Sound !== 'undefined') Sound.playKill(); }, 350);
  }
}

// Ended
function renderEnded(winner, reason, players) {
  const finalWinner = winner || state.lastWinner || state.gameState?.winner || 'villagers';
  const finalReason = reason || state.lastEndReason || state.gameState?.endReason || '';
  const finalPlayers = (players && players.length) ? players : (state.endedPlayers || state.gameState?.players || []);

  showScreen('game');
  show('panel-ended');
  if (typeof switchMobileView === 'function') {
    switchMobileView('main');
  }

  const el = document.getElementById('ended-content');
  if (!el) return;

  const isSF = finalWinner === 'sf';
  el.className = 'ended-content ' + (isSF ? 'winner-sf' : 'winner-villagers');

  const winnerTitle = t(isSF ? 'winner_sf' : 'winner_villagers');
  const winnerIcon = isSF ? '🎩' : '🌾';
  const winnerSubtitle = isSF 
    ? (state.lang === 'tr' ? 'Köy tamamen gölgeye teslim oldu. Efendi kazandı.' : state.lang === 'ru' ? 'Деревня пала перед тьмой. Хозяин победил.' : 'The village surrendered to darkness. The master wins.')
    : (state.lang === 'tr' ? 'Kukla ipleri koptu! Köylüler karanlığı defetti.' : state.lang === 'ru' ? 'Нити марионетки разорваны! Жители рассеяли тьму.' : 'The puppet strings were severed! The villagers prevailed.');

  const roundCount = state.gameState?.round || 1;
  const chaosCount = Math.max(0, Math.min(2, state.gameState?.consecutiveInnocentLynches || 0));

  const teamLabels = {
    evil: { tr: 'Gölge / Kötü', en: 'Shadow / Evil', de: 'Schatten / Böse', es: 'Sombra / Mal', fr: 'Ombre / Mal', ru: 'Тень / Зло', color: '#ff5252' },
    town: { tr: 'Köy / Masum', en: 'Town / Innocent', de: 'Dorf / Unschuldig', es: 'Pueblo / Inocente', fr: 'Village / Innocent', ru: 'Город / Невиновный', color: '#66bb6a' },
    neutral: { tr: 'Nötr / Kaos', en: 'Neutral / Chaos', de: 'Neutral / Chaos', es: 'Neutral / Caos', fr: 'Neutre / Chaos', ru: 'Нейтрал / Хаос', color: '#ab47bc' }
  };

  const castCardsHtml = finalPlayers.map(p => {
    const roleKey = p.role || 'koylu';
    const rData = ROLE_DATA[roleKey] || { symbol: '❓', color: 'var(--gold)' };
    const isMe = p.name === state.myName;
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const dead = !p.alive;
    
    let statusText = '';
    if (dead) {
      if (p.deathCause === 'night') statusText = state.lang === 'tr' ? '💀 Gece Katledildi' : state.lang === 'ru' ? '💀 Убит(а) ночью' : '💀 Slain at Night';
      else if (p.deathCause === 'lynch') statusText = state.lang === 'tr' ? '⚖️ İdam Edildi' : state.lang === 'ru' ? '⚖️ Казнен(а)' : '⚖️ Executed';
      else if (p.deathCause === 'madman_curse') statusText = state.lang === 'tr' ? '🌀 Lanetlendi' : state.lang === 'ru' ? '🌀 Проклят(а)' : '🌀 Cursed';
      else statusText = state.lang === 'tr' ? '💀 Elendi' : state.lang === 'ru' ? '💀 Выбыл(а)' : '💀 Eliminated';
    } else {
      statusText = state.lang === 'tr' ? '✨ Hayatta Kaldı' : state.lang === 'ru' ? '✨ Выжил(а)' : '✨ Survived';
    }

    const isKukla = !!p.isKukla || roleKey === 'kukla';
    const team = (roleKey === 'sf' || isKukla) ? 'evil' : (roleKey === 'madman' ? 'neutral' : 'town');
    const tInfo = teamLabels[team] || teamLabels.town;
    const tLabel = tInfo[state.lang] || tInfo.en;
    const roleText = isKukla 
      ? (roleKey === 'kukla' ? roleLabel('kukla') : `${roleLabel(roleKey)} + 🪆 ${roleLabel('kukla')}`) 
      : roleLabel(roleKey);

    return `
      <div class="endgame-player-card ${dead ? 'is-dead' : 'is-alive'} ${isMe ? 'is-me' : ''}" style="--role-accent:${isKukla ? '#ff7043' : rData.color}">
        <div class="endgame-card-top">
          <div class="endgame-avatar" style="border-color:${isKukla ? '#ff7043' : rData.color}">
            <span>${initial}</span>
            <span class="endgame-role-icon">${isKukla ? '🪆' : rData.symbol}</span>
          </div>
          <div class="endgame-player-details">
            <div class="endgame-player-name-row">
              <span class="endgame-player-name">${escHtml(p.name)}</span>
              ${isMe ? `<span class="endgame-you-tag">${t('you')}</span>` : ''}
            </div>
            <div class="endgame-status-tag ${dead ? 'dead' : 'alive'}">${statusText}</div>
          </div>
        </div>
        <div class="endgame-card-bottom">
          <div class="endgame-role-pill" style="background:${rData.color}22;border-color:${rData.color}66;color:${rData.color}">
            <span>${rData.symbol}</span>
            <strong>${roleText}</strong>
          </div>
          <span class="endgame-team-tag" style="color:${tInfo.color}">${tLabel}</span>
        </div>
      </div>
    `;
  }).join('');

  const reasonText = typeof finalReason === 'object' ? (finalReason[state.lang] || finalReason.tr || finalReason.en || '') : finalReason;

  el.innerHTML = `
    <div class="endgame-hero-banner">
      <div class="endgame-seal-pulse"></div>
      <div class="endgame-hero-icon">${winnerIcon}</div>
      <h2 class="endgame-hero-title">${winnerTitle}</h2>
      <p class="endgame-hero-subtitle">"${winnerSubtitle}"</p>
      <div class="endgame-reason-box">
        <span class="reason-icon">📜</span>
        <span class="reason-text">${escHtml(reasonText)}</span>
      </div>
    </div>

    <div class="endgame-stats-row">
      <div class="endgame-stat-card">
        <span class="stat-icon">🌙</span>
        <span class="stat-label">${state.lang === 'tr' ? 'Toplam Tur' : state.lang === 'ru' ? 'Всего раундов' : 'Rounds'}</span>
        <strong class="stat-value">${roundCount}</strong>
      </div>
      <div class="endgame-stat-card">
        <span class="stat-icon">🩸</span>
        <span class="stat-label">${t('chaos_score') || (state.lang === 'tr' ? 'Kaos Skoru' : state.lang === 'ru' ? 'Очки хаоса' : 'Chaos Score')}</span>
        <strong class="stat-value">${chaosCount}/2</strong>
      </div>
      <div class="endgame-stat-card">
        <span class="stat-icon">👥</span>
        <span class="stat-label">${state.lang === 'tr' ? 'Oyuncular' : state.lang === 'ru' ? 'Игроки' : 'Cast'}</span>
        <strong class="stat-value">${finalPlayers.length}</strong>
      </div>
    </div>

    <div class="endgame-cast-section">
      <div class="endgame-section-header">
        <span class="section-flourish">── ❦ ──</span>
        <h3 class="endgame-section-title">${state.lang === 'tr' ? 'Sahne Kapanışı — Tüm Roller' : state.lang === 'ru' ? 'Занавес — Все роли' : 'Curtain Call — All Roles'}</h3>
        <span class="section-flourish">── ❦ ──</span>
      </div>
      <div class="endgame-cast-grid">
        ${castCardsHtml}
      </div>
    </div>
  `;
}

// ─── PRIVATE INFO ───
function renderPrivateInfo(priv) {
  const el = document.getElementById('private-info');
  if (!el || !priv) return;
  const role = priv.myRole || 'koylu';
  const isKukla = !!priv.isKukla;
  const data = ROLE_DATA[role] || { symbol: '🌾', color: '#d4af37' };
  const lang = state.lang;

  let html = `<strong>${roleLabel(role)}</strong>`;
  if (data) html += `<span style="color:${data.color};font-size:1.5rem">${data.symbol}</span>`;

  if (isKukla) {
    html += `<div class="private-kukla-badge">🪆 + ${t('role_kukla')}</div>`;
    html += `<span style="color:var(--red-light);font-size:0.78rem;display:block;margin-top:0.3rem">${lang === 'tr' ? 'Mr. Schadenfreude\'nin emrini bekle.' : lang === 'ru' ? 'Жди приказа Mr. Schadenfreude.' : 'Await SF\'s command.'}</span>`;
  }

  if (role === 'sf') {
    html += `<br/><span style="margin-top:0.5rem;display:block">${t('sf_kukla_info')} <strong>${priv.kuklaName ? escHtml(priv.kuklaName) : (lang === 'tr' ? 'Henüz yok' : lang === 'ru' ? 'Пока нет' : 'None yet')}</strong></span>`;
  }
  el.innerHTML = html;

  // Mortisyen clue log
  if (role === 'mortisyen') {
    if (priv.mortisyenClues && Array.isArray(priv.mortisyenClues)) {
      state.clueHistory = priv.mortisyenClues;
    }
    renderMorticianLedger();
  }

  // Rahibe Tarot log
  if (role === 'rahibe') {
    if (priv.rahibeTarots && Array.isArray(priv.rahibeTarots)) {
      state.rahibeTarots = priv.rahibeTarots;
    }
    renderRahibeTarotLedger();
  }

  // Shadow Chat container for SF & Kukla
  const shadowBox = document.getElementById('shadow-chat-container');
  if (shadowBox) {
    if (role === 'sf' || isKukla) {
      shadowBox.classList.remove('hidden');
      if (priv.shadowChat && Array.isArray(priv.shadowChat)) {
        state.shadowChatMessages = [...priv.shadowChat];
        renderShadowChatMessages();
      }
    } else {
      shadowBox.classList.add('hidden');
    }
  }
}

// ─── SHADOW CHAT ───
function sendShadowChat() {
  const inp = document.getElementById('shadow-chat-input');
  if (!inp) return;
  const msg = inp.value.trim();
  if (!msg) return;
  socket.emit('game:shadowChat', { message: msg });
  inp.value = '';
}

function renderShadowChatMessages() {
  const el = document.getElementById('shadow-chat-messages');
  if (!el) return;
  const currentL = state.lang || 'tr';
  const msgs = state.shadowChatMessages || [];
  el.innerHTML = msgs.map(msg => {
    const roleClass = msg.role === 'sf' ? 'sf' : 'kukla';
    const senderTitle = typeof BotTranslator !== 'undefined' ? BotTranslator.translateShadowSenderTitle(msg, currentL) : (msg.senderTitleTranslations?.[currentL] || msg.senderTitle);
    const text = typeof BotTranslator !== 'undefined' ? BotTranslator.translateMessage(msg, currentL) : (msg.translations?.[currentL] || msg.message);
    return `<div class="shadow-msg ${roleClass}"><span class="shadow-msg-sender">[${escHtml(senderTitle)}]:</span><span>${escHtml(text)}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function appendShadowChatMsg(msg) {
  const el = document.getElementById('shadow-chat-messages');
  if (!el) return;
  const currentL = state.lang || 'tr';
  const roleClass = msg.role === 'sf' ? 'sf' : 'kukla';
  const senderTitle = typeof BotTranslator !== 'undefined' ? BotTranslator.translateShadowSenderTitle(msg, currentL) : (msg.senderTitleTranslations?.[currentL] || msg.senderTitle);
  const text = typeof BotTranslator !== 'undefined' ? BotTranslator.translateMessage(msg, currentL) : (msg.translations?.[currentL] || msg.message);
  const div = document.createElement('div');
  div.className = `shadow-msg ${roleClass}`;
  div.innerHTML = `<span class="shadow-msg-sender">[${escHtml(senderTitle)}]:</span><span>${escHtml(text)}</span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ─── MORTISYEN CLUE & DOSSIER ───
function addMortisenClue(clueData) {
  if (!clueData) return;
  state.clueHistory.push(clueData);
  renderMorticianLedger();
}

function renderMorticianLedger() {
  const ul = document.getElementById('clue-list');
  if (!ul) return;

  const clues = state.clueHistory || [];
  if (!clues.length) {
    document.getElementById('clue-log')?.classList.add('hidden');
    ul.innerHTML = '';
    return;
  }

  // Show the clue log panel
  document.getElementById('clue-log')?.classList.remove('hidden');
  ul.innerHTML = '';

  const currentL = state.lang || 'tr';

  // Calculate suspect frequency / Venn intersection
  const suspectCounts = {};
  clues.forEach(c => {
    if (Array.isArray(c.suspects)) {
      c.suspects.forEach(s => {
        suspectCounts[s] = (suspectCounts[s] || 0) + 1;
      });
    }
  });

  // Find common suspects who appeared in 2 or more reports
  const commonSuspects = Object.entries(suspectCounts)
    .filter(([_, count]) => count >= 2)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Calculate publish permissions in outer scope
  const isDay = state.gameState?.phase === 'day';
  const myPlayer = state.gameState?.players?.find(p => p.id === socket.id || p.name === state.myName);
  const isAlive = (myPlayer?.alive ?? state.privateState?.alive) ?? true;
  const canPublish = isDay && isAlive;
  const publishBtnTitle = !isAlive
    ? (state.lang === 'tr' ? 'Ölüyken rapor paylaşamazsın' : state.lang === 'ru' ? 'Нельзя публиковать отчет будучи мертвым' : 'Cannot publish while dead')
    : (!isDay ? t('publish_clue_day_only') : '');

  // If we have 2+ clues, render a Consolidated Dossier Summary Card at top!
  if (clues.length >= 2) {
    const summaryLi = document.createElement('li');
    summaryLi.className = 'clue-dossier-summary-card';

    let commonHtml = '';
    if (commonSuspects.length > 0) {
      const vakaLabel = currentL === 'tr' ? 'vaka' : currentL === 'ru' ? 'дел' : currentL === 'ja' ? '件' : currentL === 'de' ? 'Fälle' : currentL === 'es' ? 'casos' : currentL === 'fr' ? 'cas' : 'cases';
      commonHtml = `
        <div class="dossier-common-row">
          <span class="dossier-common-label">${t('mortisyen_common_suspect')}</span>
          <div class="dossier-common-chips">
            ${commonSuspects.map(cs => `<span class="dossier-suspect-chip">🎯 <strong>${escHtml(cs.name)}</strong> (${cs.count} ${vakaLabel})</span>`).join('')}
          </div>
        </div>
      `;
    }

    const corpseWord = currentL === 'tr' ? 'Ceset' : currentL === 'ru' ? 'Тело' : 'Corpse';
    const fullDossierText = clues.map(c => {
      const cText = c.translations?.[currentL] || c.clue;
      return `[${c.name || corpseWord}]: ${cText}`;
    }).join(' | ');

    summaryLi.innerHTML = `
      <div class="dossier-header">
        <span class="dossier-icon">📜</span>
        <span class="dossier-title">${t('mortisyen_dossier_title')} (${clues.length} ${t('mortisyen_reports_count') || 'Rapor'})</span>
      </div>
      ${commonHtml}
      <button class="clue-publish-all-btn ${canPublish ? '' : 'disabled'}" ${canPublish ? '' : 'title="' + publishBtnTitle + '"'}>
        <span class="clue-publish-icon">📢</span>
        <span>${t('mortisyen_dossier_btn')}</span>
      </button>
    `;
    summaryLi.querySelector('.clue-publish-all-btn').onclick = () => publishClue(fullDossierText);
    ul.appendChild(summaryLi);
  }

  // Render individual clue cards (latest first)
  const eTypeIcon = { suspects: '🔍', confirm: '✅', warning: '⚠️', info: '📋' };
  const eTypeLabel = {
    suspects: t('clue_type_suspects'),
    confirm: t('clue_type_confirm'),
    warning: t('clue_type_warning'),
    info: t('clue_type_info'),
  };

  clues.slice().reverse().forEach(c => {
    const name  = typeof c === 'object' ? c.name : c;
    const role  = typeof c === 'object' ? (c.roleTranslations?.[currentL] || (c.victimRoleKey ? roleLabel(c.victimRoleKey) : c.role)) : '';
    const text  = typeof c === 'object' ? (c.translations?.[currentL] || c.clue) : c;
    const eType = typeof c === 'object' ? (c.evidenceType || 'info') : 'info';
    const fabric = typeof c === 'object' ? (c.fabricTranslations?.[currentL] || c.fabricTrace) : '';
    const behavior = typeof c === 'object' ? (c.behaviorTranslations?.[currentL] || c.behaviorTrace) : '';

    const li = document.createElement('li');
    li.className = `clue-card clue-${eType}`;

    const safeText = escHtml(text);

    let extraTracesHtml = '';
    if (fabric || behavior) {
      extraTracesHtml = `
        <div class="clue-traces-box">
          ${fabric ? `<div class="clue-trace-item"><span class="trace-tag">🪶 ${t('clue_trace_fabric')}:</span> <em>${escHtml(fabric)}</em></div>` : ''}
          ${behavior ? `<div class="clue-trace-item"><span class="trace-tag">👁️ ${t('clue_trace_behavior')}:</span> <em>${escHtml(behavior)}</em></div>` : ''}
        </div>
      `;
    }

    li.innerHTML = `
      <div class="clue-type-strip">
        <span class="clue-type-icon">${eTypeIcon[eType] || '📋'}</span>
        <span class="clue-type-label">${eTypeLabel[eType] || eType}</span>
      </div>
      <div class="clue-card-header">
        <div class="clue-victim-avatar">${(name || '?').charAt(0).toUpperCase()}</div>
        <div class="clue-victim-info">
          <span class="clue-victim-name">${escHtml(name)}</span>
          ${role ? `<span class="clue-victim-role">${escHtml(role)}</span>` : ''}
        </div>
      </div>
      ${extraTracesHtml}
      <div class="clue-card-body">${safeText}</div>
      <button class="clue-publish-btn ${canPublish ? '' : 'disabled'}" ${canPublish ? '' : 'title="' + publishBtnTitle + '"'}>
        <span class="clue-publish-icon">📢</span>
        <span>${t('publish_clue')}</span>
      </button>
    `;
    li.querySelector('.clue-publish-btn').onclick = () => publishClue(text);
    ul.appendChild(li);
  });
}

function publishClue(text) {
  const myPlayer = state.gameState?.players?.find(p => p.id === socket.id || p.name === state.myName);
  const isAlive = (myPlayer?.alive ?? state.privateState?.alive) ?? true;
  if (!isAlive) {
    showToast(state.lang === 'tr' ? 'Ölüyken rapor paylaşamazsın.' : state.lang === 'ru' ? 'Нельзя публиковать отчет будучи мертвым.' : 'Cannot publish reports while dead.', 'error');
    return;
  }
  if (state.gameState?.phase !== 'day') {
    showToast(t('publish_clue_day_only'), 'error');
    return;
  }
  socket.emit('action:mortisyenPublishClue', { text });
}

// ─── RAHIBE TAROT LEDGER ───
function renderRahibeTarotLedger() {
  const box = document.getElementById('rahibe-tarot-log');
  const ul = document.getElementById('rahibe-tarot-list');
  if (!box || !ul) return;

  const tarots = state.rahibeTarots || [];
  if (!tarots.length) {
    box.classList.add('hidden');
    ul.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  const lang = state.lang || 'tr';

  ul.innerHTML = tarots.map(t => {
    const text = (t.translations && t.translations[lang]) || t.message || '';
    const statusIcon = t.targetActed ? '🃏' : '🕯️';
    const borderCol = t.targetActed ? '#ba68c8' : '#81c784';
    const statusTxt = t.targetActed
      ? (lang === 'tr' ? 'Hareketliydi' : lang === 'ru' ? 'Действовал(а)' : 'Active')
      : (lang === 'tr' ? 'Sessizce Uyudu' : lang === 'ru' ? 'Спал(а) мирно' : 'Slept Peacefully');
    const roundLabel = lang === 'tr' ? 'Tur' : lang === 'ru' ? 'Раунд' : 'Round';

    return `
      <li class="clue-card" style="border-left:3px solid ${borderCol};background:rgba(26,16,40,0.7);margin-bottom:0.5rem;padding:0.6rem;border-radius:4px">
        <div style="font-size:0.75rem;color:var(--text-muted);display:flex;justify-content:space-between;margin-bottom:0.3rem">
          <span style="font-weight:600;color:#f3e5f5">${statusIcon} ${roundLabel} ${t.round || 1} — ${escHtml(t.targetName || '')}</span>
          <span style="color:${borderCol};font-weight:600">${statusTxt}</span>
        </div>
        <div style="font-size:0.85rem;color:#f3e5f5;line-height:1.4">${escHtml(text)}</div>
      </li>
    `;
  }).join('');
}

// ─── CHAOS INDICATOR ───
function renderChaosIndicator(gs) {
  const el = document.getElementById('chaos-indicator');
  if (!el) return;

  const phase = gs.phase;
  if (phase === 'lobby' || phase === 'ended' || !gs.sfId) {
    el.innerHTML = '';
    return;
  }

  const chaos       = Math.max(0, Math.min(2, gs.consecutiveInnocentLynches || 0));
  const kuklaEmpty  = gs.kuklaSlotEmpty;

  let statusText = '';
  let statusClass = 'warning';

  if (chaos >= 2) {
    statusClass = 'danger';
    statusText = kuklaEmpty ? t('chaos_2_can_pick') : t('chaos_2_active');
  } else if (chaos === 1) {
    statusClass = 'warning';
    statusText = kuklaEmpty ? t('chaos_1_empty') : t('chaos_1');
  } else {
    statusClass = 'safe';
    statusText = kuklaEmpty ? t('chaos_empty_safe') : t('chaos_safe');
  }

  const headerTitle = t('chaos_score') || 'Chaos Score';

  el.innerHTML = `
    <div class="chaos-header">${headerTitle} (${chaos}/2)</div>
    <div class="chaos-dots">
      <span class="chaos-dot ${chaos >= 1 ? 'on' : 'off'} ${chaos === 2 ? 'pulse' : ''}"></span>
      <span class="chaos-dot ${chaos >= 2 ? 'on pulse' : 'off'}"></span>
    </div>
    <div class="chaos-status ${statusClass}">${statusText}</div>`;
}

// ─── ROLE MODAL ───
function showRoleModal(role, isKukla) {
  const data = ROLE_DATA[role] || { symbol: '🎭' };
  const kuklaActive = isKukla || state.privateState?.isKukla;
  const isSecretSF = (role === 'sf') && (state.gameState?.settings?.gameMode === 'secretKiller' || state.privateState?.gameMode === 'secretKiller' || !!state.privateState?.isSecretKiller || !!state.gameState?.isSecretSF);
  const symEl = document.getElementById('role-modal-symbol');
  const titleEl = document.getElementById('role-modal-title');
  const descEl = document.getElementById('role-modal-desc');

  if (symEl) symEl.textContent = kuklaActive ? `${data.symbol} 🪆` : (isSecretSF ? '🗡️' : data.symbol);
  const secretKillerLabel = state.lang === 'tr' ? 'Gizli Katil' : state.lang === 'ru' ? 'Тайный убийца' : 'Secret Killer';
  if (titleEl) titleEl.textContent = kuklaActive ? `${roleLabel(role)} + ${t('role_kukla')}` : (isSecretSF ? `${roleLabel(role)} (${secretKillerLabel})` : roleLabel(role));
  if (descEl) {
    const baseDesc = isSecretSF ? t('desc_sf_secret') : (typeof I18N !== 'undefined' ? I18N.roleDesc(role) : '');
    const kuklaTitle = state.lang === 'tr' ? 'KUKLA DURUMU:' : state.lang === 'ru' ? 'СТАТУС КУКЛЫ:' : 'PUPPET STATUS:';
    const kuklaText = state.lang === 'tr'
      ? 'Aynı zamanda Mr. Schadenfreude\'nin kuklasısın! Kendi rol yeteneğini kullanırken, gece efendinin göndereceği infaz emirlerini de yerine getireceksin.'
      : state.lang === 'ru'
      ? 'Ты также кукла Mr. Schadenfreude! Используя способности своей роли, ночью ты также будешь исполнять приказы хозяина об убийстве.'
      : 'You are also Mr. Schadenfreude\'s puppet! While using your role abilities, you will also carry out your master\'s execution orders at night.';
    const kuklaDesc = kuklaActive ? `<br/><br/><strong style="color:#ff7043">🪆 ${kuklaTitle}</strong> ${kuklaText}` : '';
    descEl.innerHTML = baseDesc + kuklaDesc;
  }
  document.getElementById('role-modal')?.classList.remove('hidden');
}

function closeRoleModal() {
  document.getElementById('role-modal').classList.add('hidden');
  // After seeing role, request fresh private state
  socket.emit('game:requestPrivate');
}

// ─── KILL MODAL (Kukla) ───
function confirmKill() {
  if (state.pendingKillTarget) {
    if (typeof Sound !== 'undefined') Sound.playKill();
    socket.emit('action:kuklaKill', { targetId: state.pendingKillTarget });
    state.pendingKillTarget = null;
  }
  document.getElementById('kill-modal')?.classList.add('hidden');
  document.getElementById('pending-order-badge')?.classList.add('hidden');
  showToast(state.lang === 'tr' ? 'Emir yerine getirildi.' : state.lang === 'ru' ? 'Приказ исполнен.' : 'Order carried out.', 'confirm');
}

function closeKillModal() {
  document.getElementById('kill-modal')?.classList.add('hidden');
  if (state.pendingKillTarget) {
    document.getElementById('pending-order-badge')?.classList.remove('hidden');
    showToast(t('order_minimized_toast'), 'info');
  }
}

function reopenKillModal() {
  if (state.pendingKillTarget) {
    if (typeof Sound !== 'undefined') Sound.playClick();
    document.getElementById('pending-order-badge')?.classList.add('hidden');
    document.getElementById('kill-modal')?.classList.remove('hidden');
  }
}

function refuseKill() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  socket.emit('action:kuklaRefuse');
  state.pendingKillTarget = null;
  document.getElementById('kill-modal')?.classList.add('hidden');
  document.getElementById('pending-order-badge')?.classList.add('hidden');
}

function ackNoOrder() {
  if (typeof Sound !== 'undefined') Sound.playClick();
  document.getElementById('kill-modal')?.classList.add('hidden');
  document.getElementById('pending-order-badge')?.classList.add('hidden');
  state.pendingKillTarget = null;
}

// ─── TIMER ───
function startClientTimer(endsAt) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  const circle = document.getElementById('timer-svg-circle');
  const text = document.getElementById('timer-text');
  const circumference = 163.4;
  
  const totalMs = endsAt - Date.now();
  if (totalMs <= 0) return;
  state.timerDuration = totalMs / 1000;
  let lastTickedSecond = null;

  function tick() {
    const remaining = Math.max(0, (endsAt - Date.now()) / 1000);
    const wholeSec = Math.ceil(remaining);
    const pct = remaining / state.timerDuration;
    const offset = circumference * (1 - pct);
    if (circle) {
      circle.style.strokeDashoffset = offset;
      circle.classList.toggle('urgent', remaining <= 10);
    }
    if (text) text.textContent = wholeSec + 's';

    // Clockwork tension tick sound in final 5 seconds of active phases
    if (wholeSec <= 5 && wholeSec > 0 && lastTickedSecond !== wholeSec) {
      lastTickedSecond = wholeSec;
      if (typeof Sound !== 'undefined' && state.gameState?.phase !== 'ended') {
        Sound.playTick(wholeSec <= 3);
      }
    }

    if (remaining <= 0) clearInterval(state.timerInterval);
  }

  tick();
  state.timerInterval = setInterval(tick, 250);
}

// ─── PARTICLE SYSTEM ───
(function initParticles() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let W, H;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function createParticle() {
    const type = Math.random();
    let color, size, speedY, speedX, maxAlpha;
    if (type > 0.6) {
      // Golden flame sparks
      color = Math.random() > 0.5 ? '#f0cf65' : '#d4af37';
      size = Math.random() * 1.8 + 0.5;
      speedY = -Math.random() * 0.7 - 0.2;
      speedX = (Math.random() - 0.5) * 0.4;
      maxAlpha = Math.random() * 0.7 + 0.3;
    } else if (type > 0.3) {
      // Crimson velvet embers
      color = Math.random() > 0.5 ? '#b71c1c' : '#ef5350';
      size = Math.random() * 2.2 + 0.8;
      speedY = -Math.random() * 0.5 - 0.1;
      speedX = (Math.random() - 0.5) * 0.3;
      maxAlpha = Math.random() * 0.5 + 0.2;
    } else {
      // Shadow purple dust
      color = '#a94fd8';
      size = Math.random() * 1.4 + 0.4;
      speedY = -Math.random() * 0.3 - 0.05;
      speedX = (Math.random() - 0.5) * 0.2;
      maxAlpha = Math.random() * 0.4 + 0.1;
    }

    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: size,
      vx: speedX,
      vy: speedY,
      alpha: maxAlpha,
      maxAlpha: maxAlpha,
      color: color,
      oscillationSpeed: Math.random() * 0.03 + 0.01,
      oscillationDist: Math.random() * 1.2,
      angle: Math.random() * Math.PI * 2,
    };
  }

  let isRunning = false;

  function init() {
    resize();
    particles = Array.from({ length: 65 }, createParticle);
    window.addEventListener('resize', resize);
    loop();
  }

  function loop() {
    if (document.hidden) {
      isRunning = false;
      return;
    }
    isRunning = true;
    ctx.clearRect(0, 0, W, H);
    particles.forEach((p, i) => {
      p.angle += p.oscillationSpeed;
      p.x += p.vx + Math.sin(p.angle) * p.oscillationDist * 0.2;
      p.y += p.vy;
      p.alpha -= 0.0015;

      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = p.r * 3;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fill();
      ctx.restore();

      if (p.y < -10 || p.alpha <= 0 || p.x < -10 || p.x > W + 10) {
        particles[i] = createParticle();
        particles[i].y = H + 10;
      }
    });
    requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !isRunning) {
      loop();
    }
  });

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// ─── HELPERS ───
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── INITIALIZATION ───
function initApp() {
  document.getElementById('create-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
  document.getElementById('join-code')?.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  document.getElementById('join-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  document.getElementById('shadow-chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendShadowChat(); });
  document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  const initialLang = typeof I18N !== 'undefined' ? I18N.getLanguage() : 'en';
  changeLanguage(initialLang);

  // Set initial landing state in history and ensure active screen class
  if (!window.location.hash || window.location.hash === '#landing') {
    showScreen('landing', false);
    history.replaceState({ screen: 'landing' }, '', '#landing');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ─── COOKIE / LOCAL STORAGE CONSENT ───────────────────────────────────────
const CONSENT_KEY = 'msf_storage_consent';

function getStoredConsent() {
  try {
    return sessionStorage.getItem(CONSENT_KEY) || localStorage.getItem(CONSENT_KEY) || null;
  } catch (e) {
    return null;
  }
}

function cookieConsent(decision) {
  try {
    sessionStorage.setItem(CONSENT_KEY, decision);
    if (decision === 'accept') {
      localStorage.setItem(CONSENT_KEY, 'accept');
    } else {
      localStorage.removeItem(CONSENT_KEY);
      // Clear game-related stored data if user declines
      try {
        Object.keys(localStorage).forEach(k => {
          if (k.startsWith('msf_token_') || k === 'sf_language_v2' || k === 'sf_language') {
            localStorage.removeItem(k);
          }
        });
      } catch (e) {}
    }
  } catch (e) {}

  const banner = document.getElementById('cookie-consent-banner');
  if (banner) {
    banner.style.transition = 'transform 0.35s ease, opacity 0.3s ease';
    banner.style.transform = 'translateY(110%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.classList.add('hidden'), 360);
  }
}

function initCookieConsent() {
  const consent = getStoredConsent();
  if (consent !== null) return;
  const banner = document.getElementById('cookie-consent-banner');
  if (!banner) return;
  setTimeout(() => {
    banner.classList.remove('hidden');
    updateCookieBannerLanguage();
  }, 1200);
}

function openPrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (!modal) return;
  updatePrivacyModalLanguage();
  modal.classList.remove('hidden');
}

function closePrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) modal.classList.add('hidden');
}

function updateCookieBannerLanguage(lang) {
  if (typeof I18N !== 'undefined') {
    if (lang && I18N.getLanguage() !== lang) {
      I18N.setLanguage(lang);
    } else {
      const banner = document.getElementById('cookie-consent-banner');
      if (banner) I18N.applyDOM(banner);
    }
  }
}

function updatePrivacyModalLanguage(lang) {
  if (typeof I18N !== 'undefined') {
    if (lang && I18N.getLanguage() !== lang) {
      I18N.setLanguage(lang);
    } else {
      const modal = document.getElementById('privacy-modal');
      if (modal) I18N.applyDOM(modal);
    }
  }
}

// Boot the consent check after app init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCookieConsent);
} else {
  initCookieConsent();
}

