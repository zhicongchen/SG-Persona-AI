// =========================
// State
// =========================

let personasList = [];          // [{id, name, description}]
let conversations = [];         // [{id, personaId, personaName, title, updatedAt, messageCount}]
let activeConversationId = null;
let activePersonaId = null;
let activePersonaDetails = null;
let interactionEndInProgress = false;
let personaRestoreInProgress = false;
let chatRequestInProgress = false;

// =========================
// Auth guard — this page requires login
// =========================

async function checkAuth() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();

    if (!data.user) {
      window.location.replace('/login.html');
      return false;
    }

    document.getElementById('userEmail').textContent = data.user.email;
    return true;
  } catch (err) {
    console.error('Error checking login status:', err);
    return false;
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
  window.location.replace('/login.html');
}

// =========================
// Init
// =========================

async function init() {
  const loggedIn = await checkAuth();
  if (!loggedIn) return;

  const [personasRes, conversationsRes] = await Promise.all([
    fetch('/personas'),
    fetch('/conversations')
  ]);
  personasList = await personasRes.json();
  conversations = await conversationsRes.json();

  renderNewConvMenu();
  renderSidebar();

  if (conversations.length > 0) {
    openConversation(conversations[0].id);
  } else {
    showEmptyState();
  }
}

init();

function showEmptyState() {
  closePersonaDetails();
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('chatArea').classList.add('hidden');
}

function showChatArea() {
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('chatArea').classList.remove('hidden');
}

// =========================
// Sidebar
// =========================

async function refreshConversations() {
  try {
    const res = await fetch('/conversations');
    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }
    conversations = await res.json();
    renderSidebar();
  } catch (err) {
    console.error('Error loading conversations:', err);
  }
}

// Tag colour follows the persona's position in the personas list
function personaTagClass(personaId) {
  const index = personasList.findIndex(p => p.id === personaId);
  return 'tag-' + (index >= 0 ? index % 4 : 0);
}

function renderSidebar() {
  const list = document.getElementById('convList');
  list.innerHTML = '';

  conversations.forEach(c => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === activeConversationId ? ' active' : '');
    item.onclick = () => openConversation(c.id);

    const title = document.createElement('div');
    title.className = 'conv-item-title';
    title.textContent = c.title || 'New conversation';

    const tag = document.createElement('span');
    tag.className = 'persona-tag ' + personaTagClass(c.personaId);
    tag.textContent = c.personaName;

    const remove = document.createElement('button');
    remove.className = 'conv-item-delete';
    remove.type = 'button';
    remove.title = 'Delete this conversation';
    remove.setAttribute('aria-label', `Delete conversation: ${c.title || 'New conversation'}`);
    remove.textContent = '×';
    // Without this the click also opens the conversation being deleted.
    remove.onclick = (event) => {
      event.stopPropagation();
      deleteConversation(c.id);
    };

    item.appendChild(remove);
    item.appendChild(title);
    item.appendChild(tag);
    list.appendChild(item);
  });
}

// Deleting removes the chat and its interaction history. It does not roll the
// Persona back: State and Memory earned in the chat live in the Persona
// instance, and the details drawer is where those are restored.
async function deleteConversation(id) {
  const conversation = conversations.find(c => c.id === id);
  const name = conversation?.title || 'this conversation';

  const confirmed = window.confirm(
    `Delete "${name}"?

`
    + 'The messages and its interaction history are removed permanently. '
    + `The Persona keeps any State and Memory it gained from the chat; use `
    + 'Details to restore those.'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/conversations/${id}`, { method: 'DELETE' });

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error || 'Could not delete this conversation.');
      return;
    }

    const wasActive = activeConversationId === id;
    await refreshConversations();

    if (!wasActive) return;

    activeConversationId = null;
    activePersonaId = null;
    activePersonaDetails = null;

    if (conversations.length > 0) {
      openConversation(conversations[0].id);
    } else {
      showEmptyState();
    }
  } catch (err) {
    console.error('Error deleting conversation:', err);
    window.alert('Could not delete this conversation.');
  }
}

// =========================
// New conversation (persona picker)
// =========================

function renderNewConvMenu() {
  const menu = document.getElementById('newConvMenu');
  menu.innerHTML = '';

  personasList.forEach(p => {
    const option = document.createElement('div');
    option.className = 'new-conv-option';
    option.onclick = () => createNewConversation(p.id);

    const name = document.createElement('strong');
    name.textContent = p.name;

    const desc = document.createElement('div');
    desc.className = 'new-conv-option-desc';
    desc.textContent = p.description;

    option.appendChild(name);
    option.appendChild(desc);
    menu.appendChild(option);
  });
}

function toggleNewConvMenu() {
  document.getElementById('newConvMenu').classList.toggle('hidden');
}

function hideNewConvMenu() {
  document.getElementById('newConvMenu').classList.add('hidden');
}

// Close the persona menu when clicking anywhere else
document.addEventListener('click', (e) => {
  if (!e.target.closest('.new-conv-wrap')) {
    hideNewConvMenu();
  }
});

async function createNewConversation(personaId) {
  hideNewConvMenu();

  try {
    const res = await fetch('/conversations/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId })
    });

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }

    const data = await res.json();

    await refreshConversations();
    openConversation(data.id);

  } catch (err) {
    console.error('Error creating conversation:', err);
  }
}

// =========================
// Open a conversation
// =========================

async function openConversation(id) {
  try {
    const res = await fetch(`/conversations/${id}`);

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }
    if (!res.ok) {
      console.error('Could not open conversation', id);
      return;
    }

    const data = await res.json();
    activeConversationId = data.id;
    activePersonaId = data.personaId;
    activePersonaDetails = null;
    hideEvolutionNotice();
    setInteractionButton(null);

    // Header: title + persona
    const persona = personasList.find(p => p.id === data.personaId);
    document.getElementById('convTitle').textContent = data.title || 'New conversation';
    document.getElementById('convPersonaName').textContent = persona ? persona.name : data.personaId;
    document.getElementById('convPersonaDesc').textContent =
      persona && persona.description ? ` · ${persona.description}` : '';

    // Messages
    const chat = document.getElementById('chat');
    chat.innerHTML = '';
    const boundaries = new Map(
      (data.interactions || []).map(item => [item.throughMessageId, item])
    );
    data.messages.forEach(m => {
      addMessage(m.content, m.role === 'user' ? 'user' : 'bot');
      const interaction = boundaries.get(m.id);
      if (interaction) addInteractionBoundary(interaction);
    });

    showChatArea();
    renderSidebar(); // update the active highlight
    renderPersonaSummary(null);
    renderPersonaDetails(null, persona?.name || data.personaId);
    loadPersonaDetails(data.personaId, data.id);
  } catch (err) {
    console.error('Error opening conversation:', err);
  }
}

// =========================
// Persona inspector
// =========================

async function loadPersonaDetails(personaId, conversationId) {
  try {
    const params = new URLSearchParams({ conversationId });
    const res = await fetch(`/personas/${encodeURIComponent(personaId)}/instance?${params}`);

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }
    if (!res.ok) {
      throw new Error(`Could not load Persona details (${res.status})`);
    }

    const details = await res.json();
    if (activeConversationId !== conversationId) return;

    activePersonaDetails = details;
    renderPersonaSummary(details.state);
    renderPersonaDetails(details);
    return details;
  } catch (err) {
    console.error('Error loading Persona details:', err);
    renderPersonaSummary(null, 'Unavailable');
  }
}

function renderPersonaSummary(state, fallback = 'Loading…') {
  const relationship = state?.relationship;
  const mood = state?.mood;

  setText('summaryMood', mood?.current ? humanize(mood.current) : fallback);
  setText('summaryRelationship', relationship?.stage ? humanize(relationship.stage) : fallback);
  setText('summaryInteractions', relationship?.interactionCount ?? fallback);
}

function renderPersonaDetails(details, fallbackName = 'Persona') {
  const state = details?.state || {};
  const relationship = state.relationship || {};
  const mood = state.mood || {};
  const drift = state.speakingStyleDrift || {};
  const conversation = details?.conversation || {};

  setText('drawerPersonaName', details?.name || fallbackName);
  setText('detailRelationshipStage', humanize(relationship.stage));
  setText('detailInteractionCount', relationship.interactionCount);
  setText('detailFirstInteraction', formatDate(relationship.firstInteraction));
  setText('detailLastInteraction', formatDate(relationship.lastInteraction));

  setText('detailMoodCurrent', humanize(mood.current));
  setText('detailMoodIntensity', formatIntensity(mood.intensity));
  setText('detailMoodBaseline', mood.baseline);

  setText('detailFormality', formatSignedNumber(drift.formality));
  setText('detailEmojiFrequency', formatSignedNumber(drift.emoji_frequency));
  setText('detailVerbosity', formatSignedNumber(drift.verbosity));

  renderChips('detailTraits', state.evolvedTraits || []);
  renderInterests(state.interests || {});
  setText('detailRawState', details?.state ? JSON.stringify(details.state, null, 2) : 'Loading…');

  setText('contextMessageCount', conversation.messageCount);
  setText('contextCurrentMessageCount', conversation.currentInteractionMessageCount);
  setText('contextCompletedInteractions', conversation.interactions?.length ?? 0);
  setText('contextCreatedAt', formatDate(conversation.createdAt));
  setText('contextUpdatedAt', formatDate(conversation.updatedAt));
  setText('detailStoredPrompt', conversation.storedSystemPrompt || 'Loading…');
  renderContextMessages(conversation.messages || []);
  setText(
    'contextRawMessages',
    details?.conversation
      ? JSON.stringify(
          (conversation.messages || []).map(({ role, content }) => ({ role, content })),
          null,
          2
        )
      : 'Loading…'
  );

  renderMemory(details?.memory);
  renderPersonaHistory(details);
  renderPersonaSettings(details?.relationshipMinimums);
  renderPersonaRestoreControls(details);
  setInteractionButton(details);
}

function renderContextMessages(messages) {
  const container = document.getElementById('contextMessages');
  container.innerHTML = '';

  if (!messages.length) {
    const empty = document.createElement('span');
    empty.className = 'detail-empty';
    empty.textContent = 'No messages in this conversation.';
    container.appendChild(empty);
    return;
  }

  messages.forEach(message => {
    const item = document.createElement('details');
    item.className = 'context-message';

    const summary = document.createElement('summary');

    const role = document.createElement('span');
    role.className = `context-role context-role-${message.role}`;
    role.textContent = message.role;

    const preview = document.createElement('span');
    preview.className = 'context-message-preview';
    const compactContent = message.content.replace(/\s+/g, ' ').trim();
    preview.textContent = compactContent.length > 80
      ? `${compactContent.slice(0, 80)}…`
      : compactContent;

    const time = document.createElement('time');
    time.className = 'context-message-time';
    time.textContent = formatDate(message.createdAt);

    const content = document.createElement('pre');
    content.textContent = message.content;

    summary.appendChild(role);
    summary.appendChild(preview);
    summary.appendChild(time);
    item.appendChild(summary);
    item.appendChild(content);
    container.appendChild(item);
  });
}

function renderChips(containerId, values) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!values.length) {
    const empty = document.createElement('span');
    empty.className = 'detail-empty';
    empty.textContent = 'None yet';
    container.appendChild(empty);
    return;
  }

  values.forEach(value => {
    const chip = document.createElement('span');
    chip.className = 'detail-chip';
    chip.textContent = typeof value === 'string' ? value : JSON.stringify(value);
    container.appendChild(chip);
  });
}

function renderInterests(interests) {
  const entries = Object.entries(interests);
  const labels = entries.map(([name, value]) => {
    if (typeof value === 'number') {
      return `${humanize(name)} (${Math.round(value * 100)}%)`;
    }
    return humanize(name);
  });
  renderChips('detailInterests', labels);
}

function renderMemory(memory) {
  const snapshot = memory || {
    totalMemories: 0,
    summaryCount: 0,
    durableMemoryCount: 0,
    topTags: [],
    memories: []
  };
  setText('memorySummaryCount', memory ? snapshot.summaryCount : 'Loading…');
  setText('memoryDurableCount', memory ? snapshot.durableMemoryCount : 'Loading…');
  setText('memoryTotal', memory ? snapshot.totalMemories : 'Loading…');
  renderChips(
    'memoryTopTags',
    (snapshot.topTags || []).map(item => `${item.tag} (${item.count})`)
  );

  const container = document.getElementById('memoryList');
  container.innerHTML = '';
  if (!snapshot.memories?.length) {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    empty.textContent = memory
      ? 'No completed interaction has created Memory yet.'
      : 'Loading…';
    container.appendChild(empty);
  } else {
    snapshot.memories.forEach(memoryItem => {
      const entry = document.createElement('article');
      entry.className = 'memory-entry';

      const meta = document.createElement('div');
      meta.className = 'memory-meta';
      meta.textContent = [
        humanize(memoryItem.type),
        memoryItem.subject && memoryItem.subject !== 'interaction'
          ? humanize(memoryItem.subject)
          : null,
        memoryItem.interactionNumber
          ? `Interaction ${memoryItem.interactionNumber}`
          : null,
        formatDate(memoryItem.timestamp)
      ].filter(Boolean).join(' · ');

      const content = document.createElement('div');
      content.className = 'memory-content';
      content.textContent = memoryItem.content;

      entry.appendChild(meta);
      entry.appendChild(content);
      if (memoryItem.evidence) {
        const evidence = document.createElement('div');
        evidence.className = 'memory-evidence';
        evidence.textContent = `Evidence: “${memoryItem.evidence}”`;
        entry.appendChild(evidence);
      }
      container.appendChild(entry);
    });
  }

  setText('memoryRaw', memory ? JSON.stringify(snapshot, null, 2) : 'Loading…');
}

function renderPersonaSettings(minimums) {
  const values = minimums || {};
  document.getElementById('settingStranger').value = values.stranger ?? '';
  document.getElementById('settingAcquaintance').value = values.acquaintance ?? '';
  document.getElementById('settingFriend').value = values.friend ?? '';
  document.getElementById('settingCloseFriend').value = values.close_friend ?? '';
  document.getElementById('personaSettingsStatus').textContent = '';
}

function renderPersonaHistory(details) {
  const container = document.getElementById('detailHistory');
  const state = details?.state || {};
  const interactionHistory = details?.interactionHistory || [];
  const restoreHistory = details?.restoreHistory || [];
  const legacyEvolutionRuns = (details?.conversation?.evolutionRuns || [])
    .filter(item => item.legacy);
  const entries = [
    ...interactionHistory.map(item => ({ category: 'Interaction', item })),
    ...restoreHistory.map(item => ({ category: 'Restore', item })),
    ...legacyEvolutionRuns.map(item => ({ category: 'Evolution', item })),
    ...(state.stateHistory || []).map(item => ({ category: 'State', item })),
    ...(state.eventLog || []).map(item => ({ category: 'Event', item })),
    ...(state.milestones || []).map(item => ({ category: 'Milestone', item }))
  ].sort((first, second) => (
    new Date(historyDate(second.item) || 0) - new Date(historyDate(first.item) || 0)
  ));

  container.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No Persona changes have been recorded yet.';
    container.appendChild(empty);
    return;
  }

  entries.forEach(({ category, item }) => {
    const entry = document.createElement('article');
    entry.className = 'history-entry';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = [
      category,
      category === 'Interaction'
        ? item.conversationTitle || `Conversation ${item.conversationId}`
        : null,
      formatDate(historyDate(item))
    ].filter(Boolean).join(' · ');

    const content = document.createElement('div');
    content.className = 'history-content';
    content.textContent = historyText(item, category);

    entry.appendChild(meta);
    entry.appendChild(content);
    if (category === 'Interaction'
        && item.assessment
        && Object.keys(item.assessment).length) {
      const assessment = document.createElement('details');
      assessment.className = 'history-assessment';

      const summary = document.createElement('summary');
      summary.textContent = 'Evidence assessment';

      const raw = document.createElement('pre');
      raw.textContent = JSON.stringify(item.assessment, null, 2);

      assessment.appendChild(summary);
      assessment.appendChild(raw);
      entry.appendChild(assessment);
    }
    if (category === 'Interaction') {
      const actions = document.createElement('div');
      actions.className = 'history-actions';

      if (item.canRestore && item.interactionId) {
        const restoreButton = document.createElement('button');
        restoreButton.type = 'button';
        restoreButton.className = 'history-restore-btn';
        restoreButton.dataset.personaRestore = 'interaction';
        restoreButton.disabled = (
          personaRestoreInProgress
          || interactionEndInProgress
          || chatRequestInProgress
        );
        restoreButton.textContent = 'Restore to this interaction';
        restoreButton.onclick = () => restorePersona(
          item.interactionId,
          item.interactionNumber,
          item.checkpointQuality
        );
        actions.appendChild(restoreButton);

        if (item.checkpointQuality === 'reconstructed') {
          const quality = document.createElement('span');
          quality.className = 'history-checkpoint-quality';
          quality.textContent = 'Reconstructed checkpoint';
          actions.appendChild(quality);
        }
      } else {
        const unavailable = document.createElement('span');
        unavailable.className = 'history-checkpoint-unavailable';
        unavailable.textContent = 'Checkpoint unavailable';
        actions.appendChild(unavailable);
      }
      entry.appendChild(actions);
    }
    container.appendChild(entry);
  });
}

function renderPersonaRestoreControls(details) {
  const panel = document.getElementById('personaRestorePanel');
  const resetButton = document.getElementById('resetPersonaBtn');
  const busy = (
    personaRestoreInProgress
    || interactionEndInProgress
    || chatRequestInProgress
  );
  panel.setAttribute('aria-busy', personaRestoreInProgress ? 'true' : 'false');
  resetButton.disabled = !details || busy;

  document.querySelectorAll('[data-persona-restore]').forEach(button => {
    button.disabled = busy;
  });

  if (!details) {
    setPersonaRestoreStatus('', '');
  } else if (
    details.checkpointWarning
    && !personaRestoreInProgress
    && !document.getElementById('personaRestoreStatus').textContent
  ) {
    setPersonaRestoreStatus(
      'Some older interactions could not be reconstructed, so their restore buttons are unavailable.',
      'warning'
    );
  }
}

function setPersonaRestoreStatus(message, type = '') {
  const status = document.getElementById('personaRestoreStatus');
  status.textContent = message;
  status.className = [
    'history-restore-status',
    type ? `history-restore-status-${type}` : ''
  ].filter(Boolean).join(' ');
}

function historyDate(item) {
  if (!item || typeof item !== 'object') return null;
  return item.timestamp || item.createdAt || item.lastUpdatedAt || item.at || item.date;
}

function historyText(item, category) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item ?? '');
  if (category === 'Evolution') {
    return `${item.shouldEvolve ? 'Persona updated' : 'Reviewed with no substantive change'}: ${item.reason}`;
  }
  if (category === 'Interaction') {
    const result = item.shouldEvolve
      ? 'Persona state changed.'
      : 'No substantive Persona change.';
    return `Interaction ${item.interactionNumber} ended: ${item.summary} ${result} ${item.reason || ''}`.trim();
  }
  if (category === 'Restore') {
    const target = item.targetKind === 'initial'
      ? 'the initial Persona'
      : `Interaction ${item.targetInteractionNumber}`;
    return `State and Memory were restored to ${target}. Chat history and relationship settings were preserved.`;
  }
  if (category === 'State' && (item.relationship || item.mood)) {
    const mood = humanize(item.mood?.current);
    const relationship = humanize(item.relationship?.stage);
    const interactions = item.relationship?.interactionCount ?? 0;
    return `Snapshot before update: mood ${mood}, relationship ${relationship}, interactions ${interactions}.`;
  }
  if (item.trigger && item.delta) return `${item.trigger} — ${item.delta}`;
  return item.description || item.summary || item.event || item.change || item.type || JSON.stringify(item);
}

async function restorePersona(interactionId, interactionNumber, checkpointQuality = 'exact') {
  if (!activePersonaId || !activeConversationId || personaRestoreInProgress) return;
  if (interactionEndInProgress || chatRequestInProgress) {
    setPersonaRestoreStatus(
      'Wait for the current reply or Persona update to finish.',
      'warning'
    );
    return;
  }

  const personaId = activePersonaId;
  const conversationId = activeConversationId;
  const isInitial = interactionId === null;
  const currentMessageCount = (
    activePersonaDetails?.conversation?.currentInteractionMessageCount || 0
  );
  const targetLabel = isInitial
    ? 'its initial state'
    : `Interaction ${interactionNumber}`;
  const confirmation = [
    isInitial
      ? 'Reset Persona to its initial state?'
      : `Restore Persona to Interaction ${interactionNumber}?`,
    '',
    isInitial
      ? 'State and Memory will return to the original Persona template.'
      : `State and Memory will return to the end of Interaction ${interactionNumber}.`,
    'Chat history and relationship settings will remain unchanged.',
    checkpointQuality === 'reconstructed'
      ? 'This older checkpoint was reconstructed from saved interaction records.'
      : null,
    currentMessageCount > 0
      ? `The ${currentMessageCount} messages in the current unfinished interaction will remain and continue from the restored Persona state.`
      : null
  ].filter(line => line !== null).join('\n');

  if (!window.confirm(confirmation)) return;

  personaRestoreInProgress = true;
  renderPersonaRestoreControls(activePersonaDetails);
  setInteractionButton(activePersonaDetails);
  updateChatControls();
  setPersonaRestoreStatus(`Restoring Persona to ${targetLabel}…`, 'working');

  try {
    const res = await fetch(`/personas/${encodeURIComponent(personaId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionId, conversationId })
    });

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Could not restore Persona.');
    }

    if (activePersonaId !== personaId || activeConversationId !== conversationId) return;

    await loadPersonaDetails(personaId, conversationId);
    showPersonaTab('history');
    openPersonaDetails();
    const successMessage = result.unchanged
      ? `Persona is already at ${result.target.label}.`
      : `Persona restored to ${result.target.label}. State and Memory moved together; chat and settings were preserved.`;
    setPersonaRestoreStatus(successMessage, 'success');
    showEvolutionNotice(successMessage, 'success');
    document.getElementById('personaRestoreStatus').focus();
  } catch (err) {
    console.error('Error restoring Persona:', err);
    if (activePersonaId === personaId && activeConversationId === conversationId) {
      setPersonaRestoreStatus(err.message || 'Could not restore Persona.', 'error');
    }
  } finally {
    personaRestoreInProgress = false;
    renderPersonaRestoreControls(activePersonaDetails);
    setInteractionButton(activePersonaDetails);
    updateChatControls();
  }
}

function setInteractionButton(details) {
  const button = document.getElementById('endInteractionBtn');
  const canEnd = Boolean(details?.conversation?.canEndInteraction);
  const busy = (
    interactionEndInProgress
    || personaRestoreInProgress
    || chatRequestInProgress
  );
  button.disabled = !canEnd || busy;
  button.textContent = 'End Interaction';
  button.title = canEnd && !busy
    ? 'Summarize this interaction, save Memory, and update the Persona'
    : busy
      ? 'Wait for the current operation to finish'
    : details
      ? 'No completed messages in the current interaction'
      : 'Loading Persona state';
}

async function endInteraction() {
  if (!activeConversationId
      || !activePersonaId
      || interactionEndInProgress
      || personaRestoreInProgress
      || chatRequestInProgress) return;

  const conversationId = activeConversationId;
  const personaId = activePersonaId;
  const button = document.getElementById('endInteractionBtn');
  interactionEndInProgress = true;
  button.disabled = true;
  button.textContent = 'Ending…';
  renderPersonaRestoreControls(activePersonaDetails);
  updateChatControls();
  showEvolutionNotice('Summarizing this interaction and writing Memory…', 'working');

  try {
    const res = await fetch(`/personas/${encodeURIComponent(personaId)}/end-interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId })
    });

    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Persona update failed.');
    }

    if (activeConversationId !== conversationId || activePersonaId !== personaId) return;

    addInteractionBoundary({
      interactionNumber: result.interactionNumber,
      summary: result.summary,
      createdAt: new Date().toISOString()
    });
    await loadPersonaDetails(personaId, conversationId);
    showEvolutionNotice(
      `Interaction ${result.interactionNumber} ended. Summary saved; ${result.durableMemoryCount} durable memories saved. ${result.shouldEvolve ? 'Persona state updated.' : 'No substantive Persona change.'}`,
      'success'
    );
    showPersonaTab('memory');
    openPersonaDetails();
  } catch (err) {
    console.error('Error ending interaction:', err);
    showEvolutionNotice(err.message || 'Could not end interaction.', 'error');
    setInteractionButton(activePersonaDetails);
  } finally {
    interactionEndInProgress = false;
    setInteractionButton(activePersonaDetails);
    renderPersonaRestoreControls(activePersonaDetails);
    updateChatControls();
  }
}

async function savePersonaSettings(event) {
  event.preventDefault();
  if (!activePersonaId) return;

  const button = document.getElementById('savePersonaSettingsBtn');
  const status = document.getElementById('personaSettingsStatus');
  const relationshipMinimums = {
    stranger: Number(document.getElementById('settingStranger').value),
    acquaintance: Number(document.getElementById('settingAcquaintance').value),
    friend: Number(document.getElementById('settingFriend').value),
    close_friend: Number(document.getElementById('settingCloseFriend').value)
  };

  button.disabled = true;
  status.className = 'settings-status';
  status.textContent = 'Saving…';

  try {
    const res = await fetch(`/personas/${encodeURIComponent(activePersonaId)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relationshipMinimums })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Could not save settings.');

    if (activePersonaDetails) {
      activePersonaDetails.relationshipMinimums = result.relationshipMinimums;
    }
    renderPersonaSettings(result.relationshipMinimums);
    status.className = 'settings-status settings-status-success';
    status.textContent = 'Saved for this Persona.';
  } catch (err) {
    status.className = 'settings-status settings-status-error';
    status.textContent = err.message || 'Could not save settings.';
  } finally {
    button.disabled = false;
  }
}

function showEvolutionNotice(message, type) {
  const notice = document.getElementById('evolutionNotice');
  notice.textContent = message;
  notice.className = `evolution-notice evolution-notice-${type}`;
}

function hideEvolutionNotice() {
  const notice = document.getElementById('evolutionNotice');
  notice.textContent = '';
  notice.className = 'evolution-notice hidden';
}

function openPersonaDetails() {
  if (!activePersonaId) return;
  document.getElementById('personaDrawer').classList.remove('hidden');
  document.getElementById('personaDrawerBackdrop').classList.remove('hidden');
  document.getElementById('personaDrawer').setAttribute('aria-hidden', 'false');
}

function closePersonaDetails() {
  document.getElementById('personaDrawer').classList.add('hidden');
  document.getElementById('personaDrawerBackdrop').classList.add('hidden');
  document.getElementById('personaDrawer').setAttribute('aria-hidden', 'true');
}

function showPersonaTab(tabName) {
  document.querySelectorAll('.persona-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.persona-tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabName);
  });
}

function setText(id, value) {
  document.getElementById(id).textContent = value === undefined || value === null || value === '' ? '—' : value;
}

function humanize(value) {
  if (!value) return '—';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatSignedNumber(value) {
  if (value === undefined || value === null) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function formatIntensity(value) {
  if (value === undefined || value === null) return '—';
  return `${Math.round(Number(value) * 100)}%`;
}

function formatDate(value) {
  if (!value) return '—';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePersonaDetails();
});

// =========================
// Chat
// =========================

function addMessage(text, className) {
  const chat = document.getElementById('chat');

  const div = document.createElement('div');
  div.className = `message ${className}`;
  div.textContent = text;

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;

  return div; // important for updating the whole conversation later
}

function addInteractionBoundary(interaction) {
  const chat = document.getElementById('chat');
  const boundary = document.createElement('div');
  boundary.className = 'interaction-boundary';

  const label = document.createElement('span');
  label.textContent = `Interaction ${interaction.interactionNumber} ended`;

  const summary = document.createElement('p');
  summary.textContent = interaction.summary;

  boundary.appendChild(label);
  boundary.appendChild(summary);
  chat.appendChild(boundary);
  chat.scrollTop = chat.scrollHeight;
}

async function sendMessage() {
  if (!activeConversationId
      || interactionEndInProgress
      || personaRestoreInProgress
      || chatRequestInProgress) return;

  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  const conversationId = activeConversationId;
  const personaId = activePersonaId;

  input.value = '';
  chatRequestInProgress = true;
  updateChatControls();
  setInteractionButton(activePersonaDetails);
  renderPersonaRestoreControls(activePersonaDetails);

  // User message
  addMessage(text, 'user');

  // Typing bubble
  const typingBubble = addMessage("Your partner is typing...", 'bot typing');

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationId
      })
    });

    // Session expired — back to the login page
    if (res.status === 401) {
      window.location.replace('/login.html');
      return;
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not generate a reply.');
    }

    // Replace typing text with real response
    typingBubble.textContent = data.reply;
    typingBubble.classList.remove('typing');

    // First message names the conversation and ordering may change
    await refreshConversations();
    if (activeConversationId === conversationId && activePersonaId === personaId) {
      const current = conversations.find(c => c.id === conversationId);
      if (current) {
        document.getElementById('convTitle').textContent = current.title || 'New conversation';
      }
      loadPersonaDetails(personaId, conversationId);
    }

  } catch (err) {
    console.error(err);
    typingBubble.textContent = err.message || 'Error getting response.';
    typingBubble.classList.remove('typing');
  } finally {
    chatRequestInProgress = false;
    updateChatControls();
    setInteractionButton(activePersonaDetails);
    renderPersonaRestoreControls(activePersonaDetails);
  }
}

function updateChatControls() {
  const disabled = (
    chatRequestInProgress
    || interactionEndInProgress
    || personaRestoreInProgress
  );
  document.getElementById('input').disabled = disabled;
  document.getElementById('sendBtn').disabled = disabled;
}

const input = document.getElementById('input');

input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault(); // prevents newline / weird behavior
    sendMessage();
  }
});

// =========================
// PDF export
// =========================

async function exportChatToPDF() {
  if (!activeConversationId) return;

  const { jsPDF } = window.jspdf;

  // Persona of the active conversation
  const conversation = conversations.find(c => c.id === activeConversationId);
  const personaName = conversation ? conversation.personaName : 'unknown';

  // Create date string
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Create PDF
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4"
  });

  // A4 landscape dimensions
  const pageWidth = 297;
  const pageHeight = 210;

  // Margins
  const margin = 15;

  // Current vertical position
  let y = margin;

  // Max text width
  const maxWidth = pageWidth - margin * 2;

  // Get all messages
  const messages = document.querySelectorAll("#chat .message");

  // Fonts
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(11);

  // Title with persona name and date
  pdf.setFontSize(18);
  pdf.text(`Chat with ${personaName} on ${dateStr}`, margin, y);

  y += 12;

  pdf.setFontSize(11);

  messages.forEach((msg) => {

    const isUser = msg.classList.contains("user");

    const text = msg.innerText.trim();

    // Split long lines
    const lines = pdf.splitTextToSize(text, maxWidth - 20);

    // Bubble height
    const bubbleHeight = lines.length * 6 + 10;

    // Page break
    if (y + bubbleHeight > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }

    // Bubble styles
    if (isUser) {
   // Red bubble
      pdf.setFillColor(255, 77, 77);

      // White text
      pdf.setTextColor(255, 255, 255);

    } else {
      pdf.setFillColor(240, 240, 240);
      pdf.setTextColor(0, 0, 0);
    }

    // Draw bubble
    pdf.roundedRect(
      margin,
      y,
      maxWidth,
      bubbleHeight,
      3,
      3,
      "F"
    );

    // Draw text
    pdf.text(lines, margin + 5, y + 7);

    // Move down
    y += bubbleHeight + 6;
  });

// Clean persona name for filename safety
const fileNamePersona = personaName
  .toLowerCase()
  .replace(/\s+/g, "-")
  .replace(/[^a-z0-9-_]/g, "");


const timestamp =
  now.getFullYear() +
  "-" +
  String(now.getMonth() + 1).padStart(2, "0") +
  "-" +
  String(now.getDate()).padStart(2, "0") +
  "_" +
  String(now.getHours()).padStart(2, "0") +
  "-" +
  String(now.getMinutes()).padStart(2, "0") +
  "-" +
  String(now.getSeconds()).padStart(2, "0");

// Final filename
const filename = `sg-persona-${fileNamePersona}-${timestamp}.pdf`;

// Save PDF
pdf.save(filename);
}
