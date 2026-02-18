const state = {
  messages: [],
  threads: [],
  selectedThreadId: null
};

const els = {
  composer: document.getElementById("composer"),
  author: document.getElementById("author"),
  content: document.getElementById("content"),
  composerStatus: document.getElementById("composer-status"),
  messages: document.getElementById("messages"),
  threads: document.getElementById("threads"),
  threadDetail: document.getElementById("thread-detail"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  searchResults: document.getElementById("search-results")
};

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMessages() {
  els.messages.innerHTML = state.messages
    .map((message) => {
      const threadLabel = message.thread_title
        ? `<span class="pill">${escapeHtml(message.thread_title)}</span>`
        : '<span class="pill">unassigned</span>';
      return `<li>
        <div>${threadLabel}<strong>${escapeHtml(message.author)}</strong>
        <span class="muted">${fmtTime(message.created_at)}</span></div>
        <div>${escapeHtml(message.content)}</div>
        <div class="muted">status: ${message.assignment_status}</div>
      </li>`;
    })
    .join("");
}

function renderThreads() {
  els.threads.innerHTML = state.threads
    .map((thread) => {
      const selected = state.selectedThreadId === thread.id ? " *" : "";
      const last = thread.last_message_at
        ? fmtTime(thread.last_message_at)
        : fmtTime(thread.created_at);
      return `<li>
        <div>
          <span class="thread-link" data-thread-id="${thread.id}">
            ${escapeHtml(thread.title)}
          </span>${selected}
          <span class="pill">${thread.state}</span>
        </div>
        <div class="muted">${thread.message_count} messages • ${last}</div>
      </li>`;
    })
    .join("");
}

function renderThreadDetail(payload) {
  const linked = payload.linked_threads
    .map((item) => {
      return `<div>
        <span class="pill">${item.relation}</span>
        <span class="thread-link" data-thread-id="${item.id}">
          ${escapeHtml(item.title)}
        </span>
        <span class="muted">(${item.state})</span>
      </div>`;
    })
    .join("");

  const messages = payload.messages
    .map((message) => {
      return `<li>
        <div><strong>${escapeHtml(message.author)}</strong>
        <span class="muted">${fmtTime(message.created_at)}</span></div>
        <div>${escapeHtml(message.content)}</div>
      </li>`;
    })
    .join("");

  els.threadDetail.innerHTML = `
    <div><strong>${escapeHtml(payload.thread.title)}</strong>
    <span class="pill">${payload.thread.state}</span></div>
    <div class="muted">Created ${fmtTime(payload.thread.created_at)}</div>
    <div class="muted">Last message ${fmtTime(payload.thread.last_message_at)}</div>
    <h3>Links</h3>
    <div>${linked || '<span class="muted">No links</span>'}</div>
    <h3>Messages</h3>
    <ul class="list">${messages || '<li class="muted">No messages</li>'}</ul>
  `;
}

async function loadMessages() {
  const response = await fetch("/api/messages?limit=200");
  const payload = await response.json();
  state.messages = payload.messages;
  renderMessages();
}

async function loadThreads() {
  const response = await fetch("/api/threads");
  const payload = await response.json();
  state.threads = payload.threads;
  renderThreads();
}

async function loadThreadDetail(threadId) {
  const response = await fetch(`/api/threads/${threadId}`);
  if (!response.ok) {
    els.threadDetail.textContent = "Thread not found.";
    return;
  }
  const payload = await response.json();
  renderThreadDetail(payload);
}

async function submitMessage(event) {
  event.preventDefault();
  const author = els.author.value.trim();
  const content = els.content.value.trim();
  if (!author || !content) return;

  els.composerStatus.textContent = "Sending...";
  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author, content })
  });

  if (!response.ok) {
    const payload = await response.json();
    els.composerStatus.textContent = payload.error || "Failed to send message.";
    return;
  }
  els.content.value = "";
  els.composerStatus.textContent = "Sent. AI assignment pending.";
}

async function submitSearch(event) {
  event.preventDefault();
  const q = els.searchInput.value.trim();
  if (q.length < 2) {
    return;
  }
  const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!response.ok) {
    els.searchResults.innerHTML = "<li class='muted'>Search failed.</li>";
    return;
  }
  const payload = await response.json();
  els.searchResults.innerHTML = payload.results
    .map((result) => {
      return `<li>
        <span class="thread-link" data-thread-id="${result.id}">
          ${escapeHtml(result.title)}
        </span>
        <span class="pill">${result.state}</span>
      </li>`;
    })
    .join("");
  if (payload.results.length === 0) {
    els.searchResults.innerHTML = "<li class='muted'>No results.</li>";
  }
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("message", async (event) => {
    const envelope = JSON.parse(event.data);
    if (envelope.type === "message.created") {
      state.messages.push(envelope.payload);
      renderMessages();
    }
    if (envelope.type === "message.updated") {
      const message = state.messages.find((item) => item.id === envelope.payload.id);
      if (message) {
        Object.assign(message, envelope.payload);
      }
      await loadMessages();
    }
    if (envelope.type.startsWith("thread.")) {
      await loadThreads();
      if (state.selectedThreadId) {
        await loadThreadDetail(state.selectedThreadId);
      }
    }
  });

  socket.addEventListener("close", () => {
    setTimeout(connectSocket, 1000);
  });
}

function attachEvents() {
  els.composer.addEventListener("submit", (event) => {
    submitMessage(event).catch((error) => {
      console.error(error);
      els.composerStatus.textContent = "Failed to send message.";
    });
  });

  document.body.addEventListener("click", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const threadId = element.dataset.threadId;
    if (!threadId) return;
    state.selectedThreadId = threadId;
    loadThreadDetail(threadId).catch(console.error);
    renderThreads();
  });

  els.searchForm.addEventListener("submit", (event) => {
    submitSearch(event).catch(console.error);
  });
}

async function bootstrap() {
  attachEvents();
  await loadMessages();
  await loadThreads();
  connectSocket();
}

bootstrap().catch((error) => {
  console.error(error);
  els.composerStatus.textContent = "Initial load failed.";
});

