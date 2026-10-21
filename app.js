(() => {
  const DB_NAME = 'voice-desk-calls';
  const DB_VERSION = 1;
  const STATUS = ['Converted', 'Interested', 'Follow-up Required', 'Not Interested', 'Demo Requested', 'No Response'];
  let db;
  let active = false;
  let startedAt = 0;
  let timer = null;
  let recognition = null;
  let assistantSpeaking = false;
  let speechPlayer = null;
  let speechObjectUrl = null;
  let availableVoices = [];
  let mediaRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let messages = [];
  let callId = null;
  let recordingConsent = false;
  let currentObjectUrl = null;

  const $ = (id) => document.getElementById(id);
  const elements = {
    status: $('callStatus'), visual: $('callVisual'), visualCaption: $('visualCaption'), visualSubcaption: $('visualSubcaption'), duration: $('duration'), recording: $('recordingIndicator'), consent: $('consentToggle'), start: $('startCall'), end: $('endCall'), messages: $('messages'), input: $('messageInput'), form: $('messageForm'), send: $('messageForm').querySelector('.send-button'), mic: $('micButton'), voiceSelect: $('voiceSelect'), summary: $('summaryContent'), outcome: $('statusContent'), navCount: $('navCount'), historyTotal: $('historyTotal'), historyList: $('historyList'), search: $('historySearch'), filter: $('statusFilter'), studio: $('studioView'), history: $('historyView'), breadcrumb: $('breadcrumb')
  };
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('calls')) database.createObjectStore('calls', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const allCalls = () => new Promise((resolve, reject) => {
    const request = db.transaction('calls').objectStore('calls').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
  const saveCall = (record) => new Promise((resolve, reject) => {
    const request = db.transaction('calls', 'readwrite').objectStore('calls').put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const removeCall = (id) => new Promise((resolve, reject) => {
    const request = db.transaction('calls', 'readwrite').objectStore('calls').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const timeLabel = (timestamp) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);

  function renderMessages() {
    if (!messages.length) {
      elements.messages.innerHTML = '<div class="empty-chat"><div class="empty-icon">◌</div><strong>Your conversation will appear here</strong><p>Start a call and your assistant will greet your customer.</p></div>';
      return;
    }
    elements.messages.innerHTML = messages.map(message => `<div class="message ${message.role}"><div class="message-avatar">${message.role === 'assistant' ? '✦' : '◉'}</div><div class="message-body">${escapeHtml(message.text)}<span class="message-time">${escapeHtml(message.time)}</span></div></div>`).join('');
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
  function addMessage(role, text) {
    messages.push({ role, text, time: timeLabel(Date.now()) });
    renderMessages();
  }
  function rankVoice(voice) {
    const language = voice.lang.toLowerCase();
    if (!language.startsWith('en')) return -1;
    let score = language === 'en-us' ? 50 : 35;
    if (/natural|neural|enhanced/i.test(voice.name)) score += 35;
    if (/google us english|samantha|ava|aria|jenny|serena/i.test(voice.name)) score += 25;
    if (voice.default) score += 5;
    return score;
  }
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    availableVoices = window.speechSynthesis.getVoices().filter(voice => rankVoice(voice) >= 0);
    const select = elements.voiceSelect;
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '<option value="auto">Auto voice</option>';
    availableVoices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} · ${voice.lang}`;
      select.appendChild(option);
    });
    if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
  }
  function browserVoice() {
    if (elements.voiceSelect?.value && elements.voiceSelect.value !== 'auto') {
      return availableVoices.find(voice => voice.voiceURI === elements.voiceSelect.value) || null;
    }
    return [...availableVoices].sort((a, b) => rankVoice(b) - rankVoice(a))[0] || null;
  }
  function stopListeningForSpeech() {
    assistantSpeaking = true;
    if (recognition) { try { recognition.stop(); } catch (_) {} }
  }
  function resumeListeningAfterSpeech() {
    assistantSpeaking = false;
    if (!active) return;
    if (recognition) { try { recognition.start(); return; } catch (_) {} }
    startRecognition();
  }
  function speakWithBrowser(text) {
    if (!active) { assistantSpeaking = false; return; }
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
      resumeListeningAfterSpeech();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.lang = 'en-US';
    const voice = browserVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = resumeListeningAfterSpeech;
    utterance.onerror = resumeListeningAfterSpeech;
    window.speechSynthesis.speak(utterance);
  }
  async function speak(text) {
    if (!text) return;
    stopListeningForSpeech();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (!elements.voiceSelect?.value || elements.voiceSelect.value === 'auto') {
      try {
        const response = await fetch('/api/speech', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!active) { assistantSpeaking = false; return; }
        if (response.ok) {
          const audioBlob = await response.blob();
          if (!active) { assistantSpeaking = false; return; }
          if (speechObjectUrl) URL.revokeObjectURL(speechObjectUrl);
          speechObjectUrl = URL.createObjectURL(audioBlob);
          speechPlayer = new Audio(speechObjectUrl);
          speechPlayer.onended = () => {
            speechPlayer = null;
            URL.revokeObjectURL(speechObjectUrl);
            speechObjectUrl = null;
            resumeListeningAfterSpeech();
          };
          speechPlayer.onerror = () => {
            speechPlayer = null;
            if (speechObjectUrl) URL.revokeObjectURL(speechObjectUrl);
            speechObjectUrl = null;
            speakWithBrowser(text);
          };
          await speechPlayer.play();
          return;
        }
      } catch (_) {}
    }
    speakWithBrowser(text);
  }
  function startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition || !active || assistantSpeaking) return;
    if (recognition) { try { recognition.start(); return; } catch (_) {} }
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    let finalText = '';
    recognition.onresult = (event) => {
      if (assistantSpeaking) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += `${chunk} `;
        else interim += chunk;
      }
      if (finalText.trim()) {
        const utterance = finalText.trim();
        finalText = '';
        handleCustomerMessage(utterance);
      } else if (interim && elements.input) {
        elements.input.placeholder = interim;
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') $('browserNote').textContent = 'Microphone access was blocked. Enable it in your browser settings or type a response below.';
    };
    recognition.onend = () => { if (active && !assistantSpeaking && recognition) { try { recognition.start(); } catch (_) {} } };
    try { recognition.start(); } catch (_) {}
  }
  async function startRecording() {
    if (!recordingConsent || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!active) { audioStream.getTracks().forEach(track => track.stop()); return; }
      audioChunks = [];
      mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
      mediaRecorder.start(500);
      elements.recording.classList.add('on');
      elements.recording.innerHTML = '<span></span> Recording';
    } catch (_) {
      elements.recording.innerHTML = '<span></span> Mic unavailable';
      $('browserNote').textContent = 'Recording permission was not granted. The conversation can continue without a recording.';
    }
  }
  function productIntro() {
    return 'Hi, thanks for taking a moment. I’m your sales assistant. I’d love to learn about your workflow. What is one challenge your team is trying to solve right now?';
  }
  function assistantReply(text) {
    const t = text.toLowerCase();
    if (/\b(hello|hi|hey|good morning|good afternoon)\b/.test(t) && messages.filter(m => m.role === 'user').length === 1) return 'Great to meet you! To make this useful, what does your team currently use to manage this process?';
    if (/\b(price|pricing|cost|expensive|budget|plan)\b/.test(t)) return 'Pricing depends on your team size and the features you need. We can help you find a plan that fits. Roughly how many people would use this, and would it help to schedule a quick demo to walk through the options?';
    if (/\b(demo|demonstration|show me|see it)\b/.test(t)) return 'Absolutely, a demo is a great next step. I can have someone walk you through a version tailored to your workflow. What day or time tends to work best for your team?';
    if (/\b(integrat|connect|api|tool|software|crm)\b/.test(t)) return 'That’s a useful question. Our product is designed to fit into existing workflows, and the right setup depends on the tools you already use. Which systems would you want it to connect with?';
    if (/\b(not interested|no thanks|not for us|no need|unsubscribe)\b/.test(t)) return 'Understood, and thanks for being direct. I won’t take more of your time. Would you like me to close this out, or is there a better time to reconnect?';
    if (/\b(later|follow up|follow-up|next week|busy|think about|send me)\b/.test(t)) return 'Of course. I can make a note to follow up when it’s more convenient. Is there a particular day or timeframe that would work better for you?';
    if (/\b(yes|interested|sounds good|that helps|we need|looking for|challenge|problem|manual|slow|team)\b/.test(t)) return 'That makes sense, and it sounds like there may be a good fit. Our product helps teams make this process simpler and easier to manage. What would a successful outcome look like for you?';
    if (/\b(thank|bye|goodbye|that’s all|that's all)\b/.test(t)) return 'Thanks for sharing that with me. I’ll capture what we discussed so the next step is clear. Have a great day!';
    return 'Thanks for sharing that. Could you tell me a little more about what matters most to your team: saving time, improving results, or making the process easier to manage?';
  }
  function handleCustomerMessage(text) {
    if (!active || !text.trim()) return;
    addMessage('user', text.trim());
    window.setTimeout(() => {
      if (!active) return;
      requestAssistantReply(text).then(response => {
        if (!active) return;
        addMessage('assistant', response);
        speak(response);
      });
    }, 450);
  }
  async function requestAssistantReply(text) {
    try {
      const history = messages.slice(-12).map(({ role, text: content }) => ({ role, text: content }));
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history }) });
      if (response.ok) { const data = await response.json(); if (data.reply) return data.reply; }
    } catch (_) {}
    return assistantReply(text);
  }
  function classifyCall() {
    const customerText = messages.filter(m => m.role === 'user').map(m => m.text.toLowerCase()).join(' ');
    if (!customerText.trim()) return 'No Response';
    if (/\b(not interested|no thanks|not for us|no need|unsubscribe)\b/.test(customerText)) return 'Not Interested';
    if (/\b(convert|converted|sign up|signed up|buy|purchase|let’s do it|lets do it|go ahead)\b/.test(customerText)) return 'Converted';
    if (/\b(demo|demonstration|show me|see it)\b/.test(customerText)) return 'Demo Requested';
    if (/\b(later|follow up|follow-up|next week|busy|think about|send me)\b/.test(customerText)) return 'Follow-up Required';
    if (/\b(yes|interested|sounds good|we need|looking for|challenge|problem|manual|slow|team|pricing|budget)\b/.test(customerText)) return 'Interested';
    return 'No Response';
  }
  function buildSummary(status) {
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.text.trim());
    if (!userMessages.length) return { overview: 'No customer response was captured during this call.', needs: 'No specific needs identified.', objections: 'No objections captured.', next: status === 'No Response' ? 'Try reconnecting at a better time.' : 'Review the transcript and plan next steps.' };
    const full = userMessages.join(' ');
    const needs = userMessages.find(text => /\b(need|looking for|challenge|problem|team|workflow|manual|slow|integrat)\b/i.test(text)) || userMessages[0];
    const objections = userMessages.find(text => /\b(price|pricing|cost|expensive|budget|not sure|concern|later|busy|not interested)\b/i.test(text)) || 'No clear objection was raised.';
    const next = status === 'Demo Requested' ? 'Schedule a product demonstration and confirm a time.' : status === 'Follow-up Required' ? 'Follow up at the time the customer requested.' : status === 'Interested' ? 'Share relevant details and agree on a concrete next step.' : status === 'Converted' ? 'Confirm onboarding details and welcome the new customer.' : status === 'Not Interested' ? 'Respect the decision and close the outreach.' : 'Reach out again at a more convenient time.';
    return { overview: `${userMessages.length} customer response${userMessages.length === 1 ? '' : 's'} captured. ${full.length > 170 ? `${full.slice(0, 167)}…` : full}`, needs: needs.length > 95 ? `${needs.slice(0, 92)}…` : needs, objections, next };
  }
  async function getCallInsights(fallback) {
    try {
      const response = await fetch('/api/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
      if (response.ok) { const data = await response.json(); if (STATUS.includes(data.status)) return data; }
    } catch (_) {}
    return fallback;
  }
  async function startCall() {
    if (active) return;
    if (!db) { try { db = await openDb(); } catch (_) { $('browserNote').textContent = 'Local call storage is unavailable in this browser.'; } }
    active = true;
    startedAt = Date.now();
    callId = crypto.randomUUID ? crypto.randomUUID() : `call-${Date.now()}`;
    messages = [];
    recordingConsent = elements.consent.checked;
    renderMessages();
    elements.status.classList.add('live');
    elements.status.innerHTML = '<span></span> Live call';
    elements.visual.classList.add('active');
    elements.visualCaption.textContent = 'Your assistant is listening';
    elements.visualSubcaption.textContent = recordingConsent ? 'Recording with consent' : 'Conversation is not being recorded';
    elements.start.disabled = true;
    elements.end.disabled = false;
    elements.input.disabled = false;
    elements.send.disabled = false;
    elements.consent.disabled = true;
    timer = window.setInterval(() => { elements.duration.textContent = clock(Math.floor((Date.now() - startedAt) / 1000)); }, 250);
    if (recordingConsent) startRecording();
    addMessage('assistant', productIntro());
    speak(messages[0].text);
    startRecognition();
  }
  async function endCall() {
    if (!active) return;
    active = false;
    clearInterval(timer);
    timer = null;
    assistantSpeaking = false;
    if (speechPlayer) { speechPlayer.pause(); speechPlayer = null; }
    if (speechObjectUrl) { URL.revokeObjectURL(speechObjectUrl); speechObjectUrl = null; }
    if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
    window.speechSynthesis?.cancel();
    const duration = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      const recorder = mediaRecorder;
      await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    }
    if (audioStream) { audioStream.getTracks().forEach(track => track.stop()); audioStream = null; }
    const audio = audioChunks.length ? new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' }) : null;
    const status = classifyCall();
    const summary = await getCallInsights({ ...buildSummary(status), status });
    const finalStatus = STATUS.includes(summary.status) ? summary.status : status;
    const call = { id: callId, createdAt: startedAt, duration, status: finalStatus, summary, messages: [...messages], audio };
    if (db) { try { await saveCall(call); } catch (_) {} }
    mediaRecorder = null;
    audioChunks = [];
    elements.recording.classList.remove('on');
    elements.recording.innerHTML = `<span></span> ${audio ? 'Recording saved' : 'Recording off'}`;
    elements.status.classList.remove('live');
    elements.status.innerHTML = '<span></span> Call ended';
    elements.visual.classList.remove('active');
    elements.visualCaption.textContent = 'Conversation complete';
    elements.visualSubcaption.textContent = `Call ended after ${clock(duration)}`;
    elements.start.disabled = false;
    elements.end.disabled = true;
    elements.input.disabled = true;
    elements.send.disabled = true;
    elements.consent.disabled = false;
    elements.duration.textContent = clock(duration);
    elements.summary.innerHTML = `<div class="summary-result"><div class="insight-item"><strong>Overview</strong>${escapeHtml(summary.overview)}</div><div class="insight-item"><strong>Customer needs</strong>${escapeHtml(summary.needs)}</div><div class="insight-item"><strong>Objections</strong>${escapeHtml(summary.objections)}</div><div class="insight-item"><strong>Next step</strong>${escapeHtml(summary.next)}</div></div>`;
    elements.outcome.innerHTML = `<div class="status-result" data-status="${escapeHtml(finalStatus)}"><span class="status-ring">✦</span><div><strong>${escapeHtml(finalStatus)}</strong><p>Generated from conversation</p></div></div>`;
    await renderHistory();
  }
  function setView(view) {
    const isHistory = view === 'history';
    elements.studio.classList.toggle('hidden', isHistory);
    elements.history.classList.toggle('hidden', !isHistory);
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    elements.breadcrumb.textContent = isHistory ? 'Call history' : 'Live studio';
    if (isHistory) renderHistory();
  }
  async function renderHistory() {
    if (!db) { try { db = await openDb(); } catch (_) { return; } }
    const calls = await allCalls();
    elements.navCount.textContent = String(calls.length);
    elements.historyTotal.textContent = String(calls.length);
    const search = elements.search.value.trim().toLowerCase();
    const filter = elements.filter.value;
    const filtered = calls.filter(call => {
      const haystack = `${call.status} ${call.summary.overview} ${call.messages.map(message => message.text).join(' ')}`.toLowerCase();
      return (filter === 'all' || call.status === filter) && (!search || haystack.includes(search));
    });
    if (!filtered.length) {
      elements.historyList.innerHTML = `<div class="history-empty"><span>◷</span><strong>${calls.length ? 'No calls match your search' : 'No calls just yet'}</strong><p>${calls.length ? 'Try another search or status filter.' : 'Your completed calls, summaries and recordings will show up here.'}</p></div>`;
      return;
    }
    elements.historyList.innerHTML = filtered.map(call => `<article class="history-item card" data-id="${escapeHtml(call.id)}"><div class="history-main"><div class="history-icon">◉</div><div><strong>Product discovery call</strong><small>${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(call.createdAt)} · ${timeLabel(call.createdAt)}</small></div></div><div class="history-stat"><label>DURATION</label><span>${clock(call.duration)}</span></div><div class="history-stat"><label>OUTCOME</label><span class="status-chip" data-status="${escapeHtml(call.status)}">${escapeHtml(call.status)}</span></div><div class="history-actions">${call.audio ? '<button class="small-action play-audio">▶ Play</button>' : ''}<button class="small-action toggle-detail">Details</button><button class="small-action delete" aria-label="Delete call">Delete</button></div><div class="history-detail hidden"><div><strong>Summary</strong><p>${escapeHtml(call.summary.overview)}<br><br><b>Needs:</b> ${escapeHtml(call.summary.needs)}<br><b>Objections:</b> ${escapeHtml(call.summary.objections)}<br><b>Next step:</b> ${escapeHtml(call.summary.next)}</p></div><div><strong>Transcript</strong><p>${call.messages.map(message => `<b>${message.role === 'assistant' ? 'Assistant' : 'Customer'}:</b> ${escapeHtml(message.text)}`).join('<br><br>')}</p></div></div></article>`).join('');
    elements.historyList.querySelectorAll('.toggle-detail').forEach(button => button.addEventListener('click', () => button.closest('.history-item').querySelector('.history-detail').classList.toggle('hidden')));
    elements.historyList.querySelectorAll('.delete').forEach(button => button.addEventListener('click', async () => {
      const card = button.closest('.history-item');
      await removeCall(card.dataset.id);
      await renderHistory();
    }));
    elements.historyList.querySelectorAll('.play-audio').forEach(button => button.addEventListener('click', async () => {
      const call = calls.find(item => item.id === button.closest('.history-item').dataset.id);
      if (!call?.audio) return;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = URL.createObjectURL(call.audio);
      const player = new Audio(currentObjectUrl);
      player.play();
      button.textContent = 'Playing…';
      player.onended = () => { button.textContent = '▶ Play'; URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; };
    }));
  }

  $('todayDate').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  elements.start.addEventListener('click', startCall);
  elements.end.addEventListener('click', endCall);
  elements.form.addEventListener('submit', event => { event.preventDefault(); const value = elements.input.value.trim(); if (!value || !active) return; elements.input.value = ''; handleCustomerMessage(value); });
  elements.input.addEventListener('input', () => { elements.send.disabled = !elements.input.value.trim() || !active; });
  elements.mic.addEventListener('click', () => {
    if (!active) return;
    if (!recognition) startRecognition();
    else { try { recognition.stop(); elements.input.placeholder = 'Listening…'; } catch (_) {} }
  });
  $('clearChat').addEventListener('click', () => { if (!active) { messages = []; renderMessages(); } });
  document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => setView(item.dataset.view)));
  elements.search.addEventListener('input', renderHistory);
  elements.filter.addEventListener('change', renderHistory);
  $('consentInfo').addEventListener('click', () => $('infoDialog').showModal());
  $('closeDialog').addEventListener('click', () => $('infoDialog').close());
  $('gotIt').addEventListener('click', () => $('infoDialog').close());
  $('helpButton').addEventListener('click', () => $('infoDialog').showModal());
  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  openDb().then(database => { db = database; return renderHistory(); }).catch(() => { $('browserNote').textContent = 'This app needs browser storage enabled to save conversation history.'; });
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) $('browserNote').textContent = 'Live voice recognition is not available in this browser. Try Chrome or Edge, or type responses instead.';
})();
