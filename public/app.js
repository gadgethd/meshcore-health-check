const SESSION_STORAGE_KEY = 'mesh-health-check-session-id';
const SESSION_HISTORY_STORAGE_KEY = 'mesh-health-check-session-history';
const OBSERVER_ALLOWLIST_STORAGE_KEY = 'mesh-health-check-observer-allowlist';

const ui = {
  mqttPill: document.querySelector('#mqtt-pill'),
  newSessionButton: document.querySelector('#new-session-button'),
  copySessionCodeButton: document.querySelector('#copy-session-code'),
  sessionCode: document.querySelector('#session-code'),
  sessionInstructions: document.querySelector('#session-instructions'),
  sessionStatus: document.querySelector('#session-status'),
  sessionHash: document.querySelector('#session-hash'),
  healthLabel: document.querySelector('#health-label'),
  healthPercent: document.querySelector('#health-percent'),
  observedCount: document.querySelector('#observed-count'),
  senderName: document.querySelector('#sender-name'),
  channelName: document.querySelector('#channel-name'),
  heroEyebrow: document.querySelector('#hero-eyebrow'),
  heroTitle: document.querySelector('#hero-title'),
  heroDescriptionPrefix: document.querySelector('#hero-description-prefix'),
  heroDescriptionSuffix: document.querySelector('#hero-description-suffix'),
  heroChannel: document.querySelector('#hero-channel'),
  brokerName: document.querySelector('#broker-name'),
  messagePreview: document.querySelector('#message-preview'),
  expectedSource: document.querySelector('#expected-source'),
  expectedObservers: document.querySelector('#expected-observers'),
  observerAllowlistNote: document.querySelector('#observer-allowlist-note'),
  observerAllowlist: document.querySelector('#observer-allowlist'),
  observerAllowlistClear: document.querySelector('#observer-allowlist-clear'),
  activeObserverNote: document.querySelector('#active-observer-note'),
  receiptsEmpty: document.querySelector('#receipts-empty'),
  receipts: document.querySelector('#receipts'),
  sessionHistory: document.querySelector('#session-history'),
};

localStorage.removeItem(SESSION_STORAGE_KEY);
localStorage.removeItem(SESSION_HISTORY_STORAGE_KEY);

const state = {
  snapshot: null,
  currentSessionId: sessionStorage.getItem(SESSION_STORAGE_KEY) || '',
  trackedSessionIds: loadTrackedSessionIds(),
  selectedObserverKeys: loadSelectedObserverKeys(),
  sessions: new Map(),
  socket: null,
  socketRetryTimer: 0,
  refreshInFlight: false,
};

function loadTrackedSessionIds() {
  try {
    const raw = sessionStorage.getItem(SESSION_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveTrackedSessionIds() {
  sessionStorage.setItem(
    SESSION_HISTORY_STORAGE_KEY,
    JSON.stringify(state.trackedSessionIds),
  );
}

function loadSelectedObserverKeys() {
  try {
    const raw = sessionStorage.getItem(OBSERVER_ALLOWLIST_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveSelectedObserverKeys() {
  sessionStorage.setItem(
    OBSERVER_ALLOWLIST_STORAGE_KEY,
    JSON.stringify(state.selectedObserverKeys),
  );
}

function observerDirectory() {
  if (Array.isArray(state.snapshot?.observerDirectory) && state.snapshot.observerDirectory.length > 0) {
    return state.snapshot.observerDirectory;
  }
  return Array.isArray(state.snapshot?.activeObservers) ? state.snapshot.activeObservers : [];
}

function customSelectedObserverKeys() {
  const available = new Set(observerDirectory().map((observer) => observer.key));
  return state.selectedObserverKeys.filter((key) => available.has(key));
}

function defaultObserverKeys() {
  const available = new Set(observerDirectory().map((observer) => observer.key));
  const defaults = Array.isArray(state.snapshot?.defaultObserverKeys)
    ? state.snapshot.defaultObserverKeys
    : [];
  return defaults.filter((key) => available.has(key));
}

function usingDefaultObserverSet() {
  return customSelectedObserverKeys().length === 0;
}

function effectiveObserverKeysForCreate() {
  return usingDefaultObserverSet()
    ? defaultObserverKeys()
    : customSelectedObserverKeys();
}

function defaultObserverTargetSummary() {
  const source = String(state.snapshot?.defaultObserverSource || '');
  const count = defaultObserverKeys().length;
  if (source === 'configured') {
    return `Default: ${count} observer${count === 1 ? '' : 's'}.`;
  }
  return `Default: ${count} active observer${count === 1 ? '' : 's'}.`;
}

function sessionObserverSourceLabel(session) {
  if (!session) {
    return defaultObserverTargetSummary();
  }
  if (session.allowlistEnabled) {
    return 'Custom set';
  }
  if (session.expectedObserverSource === 'configured') {
    return 'Default set';
  }
  if (session.expectedObserverSource === 'active-window') {
    return 'Active set';
  }
  if (session.expectedObserverSource === 'first-observer') {
    return 'Matched observer';
  }
  return 'Observer target';
}

function upsertTrackedSession(session) {
  if (!session?.id) {
    return;
  }
  state.sessions.set(session.id, session);
  state.trackedSessionIds = [
    session.id,
    ...state.trackedSessionIds.filter((id) => id !== session.id),
  ].slice(0, 8);
  saveTrackedSessionIds();
}

function removeTrackedSession(sessionId) {
  state.sessions.delete(sessionId);
  state.trackedSessionIds = state.trackedSessionIds.filter((id) => id !== sessionId);
  saveTrackedSessionIds();
  if (state.currentSessionId === sessionId) {
    state.currentSessionId = '';
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

async function apiFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return 'Pending';
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function healthClass(label) {
  if (label === 'VERY HEALTHY' || label === 'GOOD') {
    return 'status-good';
  }
  if (label === 'FAIR') {
    return 'status-fair';
  }
  return 'status-poor';
}

function updateRing(percent) {
  const degrees = Math.max(0, Math.min(100, percent)) * 3.6;
  document.documentElement.style.setProperty('--ring-angle', `${degrees}deg`);
  document.querySelector('.score-ring').style.background =
    `radial-gradient(circle at center, rgba(16, 21, 18, 0.95) 50%, transparent 52%), conic-gradient(var(--accent-strong) ${degrees}deg, rgba(255, 255, 255, 0.08) 0deg)`;
}

function redirectToLanding() {
  window.location.href = '/';
}

async function copyCurrentCode() {
  const session = currentSession();
  const code = session?.code || '';
  if (!code) {
    return;
  }

  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = code;
    helper.setAttribute('readonly', '');
    helper.style.position = 'absolute';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }

  const originalText = ui.copySessionCodeButton.textContent;
  ui.copySessionCodeButton.textContent = 'Copied';
  window.setTimeout(() => {
    ui.copySessionCodeButton.textContent = originalText;
  }, 1200);
}

async function createSession() {
  ui.newSessionButton.disabled = true;
  try {
    const response = await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedObserverKeys: usingDefaultObserverSet() ? [] : customSelectedObserverKeys(),
      }),
    });
    const session = await response.json();
    if (response.status === 403 && session.error === 'turnstile_required') {
      redirectToLanding();
      return;
    }
    if (!response.ok) {
      throw new Error(session.error || 'Failed to create session');
    }
    state.currentSessionId = session.id;
    sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
    upsertTrackedSession(session);
    render();
  } catch (error) {
    ui.sessionInstructions.textContent = error.message;
  } finally {
    ui.newSessionButton.disabled = false;
  }
}

function currentSession() {
  if (!state.currentSessionId) {
    return null;
  }
  return state.sessions.get(state.currentSessionId) || null;
}

function renderExpectedObservers(session) {
  ui.expectedObservers.innerHTML = '';
  const expected = Array.isArray(session?.expectedObservers)
    ? session.expectedObservers
    : [];
  if (expected.length === 0) {
    ui.expectedObservers.innerHTML =
      '<div class="observer-pill waiting"><span>Waiting for first receipt</span><span class="status">--</span></div>';
    return;
  }
  for (const observer of expected) {
    const item = document.createElement('div');
    item.className = `observer-pill ${observer.seen ? 'seen' : 'waiting'}`;
    item.innerHTML = `
      <div class="observer-main">
        <strong class="observer-label">${observer.label}</strong>
        <div class="small-note observer-hash">${observer.hash || ''}</div>
      </div>
      <span class="status">${observer.seen ? 'Seen' : 'Waiting'}</span>
    `;
    ui.expectedObservers.appendChild(item);
  }
}

function renderObserverAllowlist() {
  const directory = observerDirectory();
  const selected = new Set(effectiveObserverKeysForCreate());
  ui.observerAllowlist.innerHTML = '';
  ui.observerAllowlistClear.disabled = usingDefaultObserverSet();

  if (directory.length === 0) {
    ui.observerAllowlistNote.textContent = 'No observers available to select yet.';
    ui.observerAllowlist.innerHTML =
      '<div class="empty-state compact">Observer choices appear as metadata and packets arrive.</div>';
    return;
  }

  const selectedCount = selected.size;
  ui.observerAllowlistNote.textContent = usingDefaultObserverSet()
    ? defaultObserverTargetSummary()
    : `Custom: ${selectedCount} observer${selectedCount === 1 ? '' : 's'}.`;

  for (const observer of directory) {
    const item = document.createElement('label');
    item.className = `observer-option ${observer.isActive ? 'active' : 'inactive'}`;
    item.innerHTML = `
      <input type="checkbox" value="${observer.key}" ${selected.has(observer.key) ? 'checked' : ''}>
      <span class="observer-option-copy">
        <strong>${observer.label}</strong>
        <span>${observer.hash || '--'} · ${observer.shortKey}${observer.isActive ? ' · active' : ' · idle'}</span>
      </span>
    `;
    const checkbox = item.querySelector('input');
    checkbox.addEventListener('change', () => {
      const next = new Set(effectiveObserverKeysForCreate());
      if (checkbox.checked) {
        next.add(observer.key);
      } else {
        next.delete(observer.key);
      }
      state.selectedObserverKeys = [...next];
      saveSelectedObserverKeys();
      renderObserverAllowlist();
    });
    ui.observerAllowlist.appendChild(item);
  }
}

function applySiteBranding(snapshot) {
  const site = snapshot?.site || {};
  const title = site.title || 'Mesh Health Check';
  const eyebrow = site.eyebrow || 'MeshCore Observer Coverage';
  const headline = site.headline || 'Check your mesh reach.';
  const description = site.description
    || 'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.';
  const [prefix, ...suffixParts] = description.split('configured channel');
  const suffix = suffixParts.join('configured channel');

  document.title = title;
  ui.heroEyebrow.textContent = eyebrow;
  ui.heroTitle.textContent = headline;
  ui.heroDescriptionPrefix.textContent = (prefix || '').trimEnd() || 'Generate a test code, send it to';
  ui.heroDescriptionSuffix.textContent = (suffix || '').trimStart()
    || 'and watch observer coverage build in real time.';
}

function renderReceipts(session) {
  const receipts = Array.isArray(session?.receipts) ? session.receipts : [];
  ui.receipts.innerHTML = '';
  ui.receiptsEmpty.classList.toggle('hidden', receipts.length > 0);

  for (const receipt of receipts) {
    const card = document.createElement('article');
    card.className = 'receipt-card';
    const metrics = [
      receipt.rssi != null ? `RSSI ${receipt.rssi}` : '',
      receipt.snr != null ? `SNR ${receipt.snr}` : '',
      receipt.duration != null ? `${receipt.duration} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    card.innerHTML = `
      <div class="receipt-head">
        <div>
          <h3 class="receipt-title">${receipt.observerLabel}</h3>
          <div class="receipt-hash">${receipt.observerHash || ''} · ${receipt.observerShortKey}</div>
        </div>
        <div class="small-note">${formatTime(receipt.firstSeenAt)}</div>
      </div>
      <p class="receipt-meta">
        Seen ${receipt.count} time${receipt.count === 1 ? '' : 's'}${metrics ? ` · ${metrics}` : ''}
      </p>
      <div class="receipt-path">${receipt.path.length > 0 ? receipt.path.join(' → ') : 'No path data'}</div>
    `;
    ui.receipts.appendChild(card);
  }
}

function renderHistory(sessions) {
  ui.sessionHistory.innerHTML = '';
  if (sessions.length === 0) {
    ui.sessionHistory.innerHTML =
      '<div class="empty-state compact">No previous checks in this browser session.</div>';
    return;
  }
  for (const session of sessions) {
    const item = document.createElement('article');
    item.className = 'history-item';
    item.innerHTML = `
      <div>
        <div class="history-code">${session.code}</div>
        <p>${session.observedCount}/${session.expectedCount} observers · ${session.healthLabel}</p>
      </div>
      <div>
        <strong class="${healthClass(session.healthLabel)}">${session.healthPercent}%</strong>
        <p>${formatTime(session.createdAt)}</p>
      </div>
    `;
    ui.sessionHistory.appendChild(item);
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const channelLabel = `#${snapshot.testChannel.name}`;
  const historySessions = state.trackedSessionIds
    .map((id) => state.sessions.get(id))
    .filter(Boolean);

  const session = currentSession();
  ui.newSessionButton.disabled = false;
  ui.copySessionCodeButton.disabled = !session;
  applySiteBranding(snapshot);
  ui.mqttPill.textContent = snapshot.mqtt.connected ? 'MQTT online' : 'MQTT offline';
  ui.mqttPill.classList.toggle('online', snapshot.mqtt.connected);
  ui.heroChannel.textContent = channelLabel;
  ui.brokerName.textContent = snapshot.mqtt.broker;
  ui.activeObserverNote.textContent =
    `${snapshot.observerStats.activeCount} active observer${snapshot.observerStats.activeCount === 1 ? '' : 's'} in the last ${snapshot.observerStats.windowSeconds}s`;
  if (!session) {
    ui.sessionCode.textContent = 'No active code';
    ui.sessionInstructions.textContent = 'Create a session to start listening.';
    ui.sessionStatus.textContent = 'Idle';
    ui.sessionHash.textContent = 'Pending';
    ui.healthLabel.textContent = 'Waiting';
    ui.healthLabel.className = '';
    ui.healthPercent.textContent = '0%';
    ui.observedCount.textContent = '0 / 0';
    ui.senderName.textContent = 'Pending';
    ui.channelName.textContent = channelLabel;
    ui.messagePreview.textContent = `Waiting for your ${channelLabel} message.`;
    ui.expectedSource.textContent = defaultObserverTargetSummary();
    renderObserverAllowlist();
    renderExpectedObservers(null);
    renderReceipts(null);
    renderHistory(historySessions);
    updateRing(0);
    return;
  }

  state.currentSessionId = session.id;
  sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);

  ui.sessionCode.textContent = session.code;
  ui.sessionInstructions.textContent = session.instructions;
  ui.sessionStatus.textContent = session.status.toUpperCase();
  ui.sessionHash.textContent = session.messageHash || 'Pending';
  ui.healthLabel.textContent = session.healthLabel;
  ui.healthLabel.className = healthClass(session.healthLabel);
  ui.healthPercent.textContent = `${session.healthPercent}%`;
  ui.observedCount.textContent = `${session.observedCount} / ${session.expectedCount}`;
  ui.senderName.textContent = session.sender || 'Pending';
  ui.channelName.textContent = session.channelName ? `#${session.channelName}` : channelLabel;
  ui.messagePreview.textContent = session.messageBody || `Waiting for your ${channelLabel} message.`;
  ui.expectedSource.textContent = sessionObserverSourceLabel(session);

  updateRing(session.healthPercent);
  renderObserverAllowlist();
  renderExpectedObservers(session);
  renderReceipts(session);
  renderHistory(historySessions);
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  render();
}

async function refreshTrackedSessions() {
  const ids = [...state.trackedSessionIds];
  if (ids.length === 0) {
    return;
  }

  const results = await Promise.all(ids.map(async (sessionId) => {
    const response = await apiFetch(`/api/sessions/${sessionId}`);
    if (response.status === 404) {
      return { sessionId, missing: true };
    }
    if (response.status === 403) {
      return { sessionId, turnstileRequired: true };
    }
    if (!response.ok) {
      return { sessionId, failed: true };
    }
    return {
      sessionId,
      session: await response.json(),
    };
  }));

  for (const result of results) {
    if (result.turnstileRequired) {
      redirectToLanding();
      return;
    }
    if (result.missing) {
      removeTrackedSession(result.sessionId);
      continue;
    }
    if (result.failed || !result.session) {
      continue;
    }
    state.sessions.set(result.session.id, result.session);
  }
}

async function refreshFromServer() {
  if (state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  try {
    const response = await apiFetch('/api/bootstrap');
    const snapshot = await response.json();
    if (snapshot.turnstile?.enabled && !snapshot.turnstile.verified) {
      redirectToLanding();
      return;
    }
    applySnapshot(snapshot);
    await refreshTrackedSessions();
    render();
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleSocketReconnect() {
  if (state.socket || state.socketRetryTimer) {
    return;
  }
  state.socketRetryTimer = window.setTimeout(() => {
    state.socketRetryTimer = 0;
    connectSocket();
  }, 2000);
}

function connectSocket() {
  if (state.socket) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'snapshot') {
        applySnapshot(message.data);
        refreshTrackedSessions().then(() => {
          render();
        });
      }
    } catch {
      // ignore malformed frames
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    scheduleSocketReconnect();
  });
}

async function bootstrap() {
  await refreshFromServer();
  if (!state.snapshot) {
    return;
  }
  if (!currentSession()) {
    await createSession();
  } else {
    render();
  }
  connectSocket();
}

ui.newSessionButton.addEventListener('click', () => {
  createSession();
});

ui.copySessionCodeButton.addEventListener('click', () => {
  copyCurrentCode();
});

ui.observerAllowlistClear.addEventListener('click', () => {
  if (selectedObserverKeysForCreate().length === 0) {
    return;
  }
  state.selectedObserverKeys = [];
  saveSelectedObserverKeys();
  renderObserverAllowlist();
});

bootstrap();
window.setInterval(() => {
  refreshFromServer();
}, 5000);
