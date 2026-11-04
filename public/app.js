/**
 * Voice-V5 Pro Client Application Logic
 * Fixed & Optimized:
 * 1. Flawless Opus audio recording with live VU meter & guaranteed flush
 * 2. Chrome Speech Recognition for Khmer (km-KH) + Edge detection banner
 * 3. Single Unified Text Box with Copy, Paste, Clear & Edit capabilities
 * 4. Mobile Phone Microphone Support
 * 5. Personal Telegram 1-click sharing
 * 6. Official Cambodian Administrative Minutes (Ministry of Interior format)
 */

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyserNode = null;
let activeMediaStream = null;
let visualizerAnimationId = null;
let recordingStartTime = 0;
let recordingTimerInterval = null;
let recordedDurationSeconds = 0;
let isPaused = false;
let currentAudioBlob = null;

// Long Continuous Recording & Memory Safeguards (>5 hours)
let wakeLockSentinel = null;
let speechWatchdogInterval = null;

// Dynamic Minutes Custom Sections & Tables (Columns)
let customMinutesSections = [];
let customMinutesTables = [];

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      console.log('Screen Wake Lock active: OS will not sleep');
    }
  } catch (err) {
    console.warn('Wake Lock notice:', err);
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    try {
      wakeLockSentinel.release();
    } catch (e) {}
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mediaRecorder && mediaRecorder.state === 'recording') {
    requestWakeLock();
  }
});

// Watchdog to keep Speech Recognition alive uninterrupted during hours of recording
function startSpeechWatchdog() {
  clearInterval(speechWatchdogInterval);
  speechWatchdogInterval = setInterval(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording' && !isPaused) {
      if (!isRecognizing) {
        startSpeechRecognition();
      }
    }
  }, 2500);
}

function stopSpeechWatchdog() {
  clearInterval(speechWatchdogInterval);
  speechWatchdogInterval = null;
}

// Prevent accidental tab close or reload during long continuous recording
window.addEventListener('beforeunload', event => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    event.preventDefault();
    event.returnValue = 'ការថតសម្លេងកំពុងដំណើរការ! តើលោកអ្នកពិតជាចង់ចាកចេញ ឬ Refresh មែនទេ?';
    return event.returnValue;
  }
});

let speechRecognition = null;
let isRecognizing = false;
let accumulatedTranscript = '';
let interimTranscript = '';
let currentTargetLang = 'en';
let appConfig = {};
let allRecordings = [];

// Audio Player state
let currentPlayingAudio = null;
let playerUpdateInterval = null;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  checkBrowserCompatibility();
  await loadConfig();
  await loadRecordings();
  initSpeechRecognition();
  setupDragAndDrop();
  initMinutesDate();
  updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  updateBoxCounts();
});

function checkBrowserCompatibility() {
  // Browser banner removed per user instruction
}

// Switch Main Tabs
function switchTab(tabId) {
  const tabs = ['record', 'library', 'minutes', 'settings'];
  tabs.forEach(t => {
    const pane = document.getElementById(`pane-${t}`);
    const btn = document.getElementById(`tab-${t}`);
    if (t === tabId) {
      if (pane) pane.classList.remove('hidden');
      if (btn) {
        btn.className = 'tab-btn px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 flex items-center gap-2 bg-emerald-600 text-white shadow-sm';
      }
    } else {
      if (pane) pane.classList.add('hidden');
      if (btn) {
        btn.className = 'tab-btn px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 flex items-center gap-2 text-slate-400 hover:text-white hover:bg-slate-800';
      }
    }
  });
  if (tabId === 'library') {
    loadRecordings();
  }
}

// --------------------------------------------------------------------------
// 1. HIGH-QUALITY AUDIO RECORDING (OPUS STREAM + LIVE VU METER)
// --------------------------------------------------------------------------

async function startRecording() {
  const hasGetUserMedia = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // If on mobile or insecure HTTP (where getUserMedia is blocked by browser security)
  if (!hasGetUserMedia) {
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      try {
        const resp = await fetch('/api/network-info');
        const net = await resp.json();
        if (net.tunnelUrl) {
          showToast('💡 កំពុងប្តូរទៅកាន់តំណភ្ជាប់ HTTPS សុវត្ថិភាពដើម្បីបើក Microphone...', 'info', 3000);
          setTimeout(() => {
            window.location.href = net.tunnelUrl;
          }, 800);
          return;
        }
      } catch (e) {}
    }

    const mobileInput = document.getElementById('mobileAudioCapture');
    if (mobileInput) {
      showToast('កំពុងបើក Microphone លើទូរស័ព្ទរបស់អ្នក...', 'info');
      mobileInput.click();
      return;
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    activeMediaStream = stream;

    // Detect optimal container
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    let selectedMimeType = '';
    for (const mt of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mt)) {
        selectedMimeType = mt;
        break;
      }
    }

    const options = {
      audioBitsPerSecond: 32000 // Fixed 32kbps Opus speech mode: ~14 MB/hr (5+ hours recording < 75 MB)
    };
    if (selectedMimeType) {
      options.mimeType = selectedMimeType;
    }
    mediaRecorder = new MediaRecorder(stream, options);

    audioChunks = [];
    currentAudioBlob = null;

    mediaRecorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
        // Consolidate every 60 chunks (1 min) to keep memory footprint flat & ultra-low (<75MB for 5+ hours)
        if (audioChunks.length > 60) {
          const combined = new Blob(audioChunks, { type: selectedMimeType || 'audio/webm' });
          audioChunks = [combined];
        }
        updateLiveStorageEstimate();
      }
    };

    // Save directly when recording stops (Zero race condition!)
    mediaRecorder.onstop = async () => {
      const finalType = selectedMimeType || 'audio/webm';
      currentAudioBlob = new Blob(audioChunks, { type: finalType });

      if (activeMediaStream) {
        activeMediaStream.getTracks().forEach(track => track.stop());
      }
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
      }
      cancelAnimationFrame(visualizerAnimationId);
      drawStaticWaveform();
      resetVuMeter();

      // Automatically save to server
      await saveRecordingToServer();
    };

    // Setup Web Audio Analyser & VU Meter
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.5;
    sourceNode.connect(analyserNode);

    // Collect chunks every 1000ms for stable long-duration streaming
    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    isPaused = false;

    // Prevent OS Sleep & start speech watchdog for 5+ hours durability
    await requestWakeLock();
    startSpeechWatchdog();

    clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(updateRecordingTimer, 500);

    // Update UI Elements
    document.getElementById('btnRecord').disabled = true;
    document.getElementById('btnRecord').classList.add('opacity-50', 'cursor-not-allowed');
    document.getElementById('btnPause').disabled = false;
    document.getElementById('btnStop').disabled = false;

    document.getElementById('mic-status-indicator').className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
    document.getElementById('mic-status-text').textContent = 'កំពុងថតសម្លេង (Live Recording)...';

    const statusPill = document.getElementById('unifiedStatusPill');
    if (statusPill) {
      statusPill.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> <span class="text-emerald-400 font-semibold">កំពុងទទួលសម្លេង & បម្លែងជាអក្សរផ្ទាល់...</span>';
    }

    startSpeechRecognition();
    drawLiveWaveform();
    showToast('បានចាប់ផ្តើមថតសម្លេងជោគជ័យ!', 'info');

  } catch (err) {
    console.warn('Microphone error:', err);
    const mobileInput = document.getElementById('mobileAudioCapture');
    if (mobileInput) {
      showToast('កំពុងបើក Microphone លើទូរស័ព្ទ...', 'info');
      mobileInput.click();
    } else {
      showToast('មិនអាចបើក Microphone៖ ' + err.message, 'error');
    }
  }
}

// Native mobile microphone capture handler
async function handleMobileAudioCapture(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  // Prevent saving empty 0-byte or corrupt header-only files
  if (file.size < 2048) {
    showToast('⚠️ មិនមានទិន្នន័យសម្លេងត្រូវបានថតទេ (ឯកសារទទេ)', 'warning', 4000);
    return;
  }

  const sizeMb = (file.size / 1024 / 1024).toFixed(2);
  showToast(`បានទទួលសម្លេង (${sizeMb} MB) កំពុងរក្សាទុក...`, 'info');

  currentAudioBlob = file;

  // Measure actual audio duration from the file
  let duration = 0;
  try {
    const audioObj = new Audio(URL.createObjectURL(file));
    await new Promise(resolve => {
      audioObj.onloadedmetadata = () => {
        duration = Math.round(audioObj.duration) || 0;
        resolve();
      };
      audioObj.onerror = () => resolve();
      setTimeout(resolve, 1200);
    });
  } catch (e) {}

  recordedDurationSeconds = duration;

  const title = `សម្លេងទូរស័ព្ទ_${new Date().toLocaleDateString('km-KH').replace(/\//g, '-')}_${new Date().toLocaleTimeString('km-KH').replace(/:/g, '')}`;

  try {
    const response = await fetch('/api/recordings/upload', {
      method: 'POST',
      headers: {
        'x-file-title': encodeURIComponent(title),
        'x-file-duration': String(duration),
        'x-original-name': encodeURIComponent(file.name || 'voice.m4a'),
        'x-mime-type': file.type || 'audio/mp4',
        'x-transcript': '',
        'x-translation': ''
      },
      body: file
    });

    const result = await response.json();
    if (result.success && result.recording) {
      showToast('បានរក្សាទុកសម្លេងជោគជ័យ!', 'success');

      const box = document.getElementById('unifiedTextBox');
      if (box && !box.value.trim()) {
        box.value = `[ឯកសារថតសម្លេង៖ ${title} (${sizeMb} MB)]`;
        updateBoxCounts();
      }

      // If Gemini Key is present, transcribe via AI
      if (appConfig.geminiApiKey) {
        showToast('កំពុងបម្លែងសម្លេងជាអក្សរតាម AI...', 'info');
        try {
          const transResp = await fetch('/api/ai/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordingId: result.recording.id })
          });
          const transData = await transResp.json();
          if (transData.success && transData.transcript) {
            box.value = transData.transcript;
            updateBoxCounts();
            showToast('បានបម្លែងសម្លេងជាអក្សរខ្មែរជោគជ័យ!', 'success');
          }
        } catch (e) {
          console.warn('AI transcribe notice:', e);
        }
      }

      await loadRecordings();

      if (document.getElementById('chkAutoPersonalTelegram')?.checked) {
        openPersonalTelegram({
          title,
          transcript: box ? box.value : '',
          recordingId: result.recording.id
        });
      }
    }
  } catch (err) {
    showToast('បរាជ័យក្នុងការរក្សាទុកសម្លេង៖ ' + err.message, 'error');
  }
}

function togglePauseRecording() {
  if (!mediaRecorder) return;
  const pauseBtn = document.getElementById('btnPause');
  const pauseText = document.getElementById('pauseBtnText');

  if (!isPaused) {
    mediaRecorder.pause();
    isPaused = true;
    pauseText.textContent = 'បន្តថត (Resume)';
    document.getElementById('mic-status-indicator').className = 'w-2 h-2 rounded-full bg-amber-400';
    document.getElementById('mic-status-text').textContent = 'បានផ្អាកជាបណ្តោះអាសន្ន (Paused)';
    if (speechRecognition) speechRecognition.stop();
  } else {
    mediaRecorder.resume();
    isPaused = false;
    pauseText.textContent = 'ផ្អាក (Pause)';
    document.getElementById('mic-status-indicator').className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
    document.getElementById('mic-status-text').textContent = 'កំពុងថតសម្លេង (Live Recording)...';
    if (speechRecognition) speechRecognition.start();
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  clearInterval(recordingTimerInterval);
  releaseWakeLock();
  stopSpeechWatchdog();

  if (speechRecognition) {
    try { speechRecognition.stop(); } catch (e) {}
    isRecognizing = false;
  }

  // Force remaining audio chunk to flush!
  try {
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }
  } catch (e) {}

  mediaRecorder.stop();

  // Reset UI Controls
  document.getElementById('btnRecord').disabled = false;
  document.getElementById('btnRecord').classList.remove('opacity-50', 'cursor-not-allowed');
  document.getElementById('btnPause').disabled = true;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('pauseBtnText').textContent = 'ផ្អាក (Pause)';
  document.getElementById('mic-status-indicator').className = 'w-2 h-2 rounded-full bg-slate-600';
  document.getElementById('mic-status-text').textContent = 'ថតចប់រួចរាល់';

  const statusPill = document.getElementById('unifiedStatusPill');
  if (statusPill) {
    statusPill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> <span>ការថតសម្លេងបានបញ្ចប់រួចរាល់</span>';
  }

  showToast('កំពុងរក្សាទុកឯកសារថតសម្លេង...', 'info');
}

function updateRecordingTimer() {
  if (isPaused) return;
  const elapsedMs = Date.now() - recordingStartTime;
  recordedDurationSeconds = elapsedMs / 1000;

  const hours = Math.floor(recordedDurationSeconds / 3600);
  const minutes = Math.floor((recordedDurationSeconds % 3600) / 60);
  const seconds = Math.floor(recordedDurationSeconds % 60);

  const pad = n => String(n).padStart(2, '0');
  document.getElementById('timerDisplay').textContent = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function updateLiveStorageEstimate() {
  let totalBytes = 0;
  for (const chunk of audioChunks) {
    totalBytes += chunk.size;
  }
  const mb = totalBytes / (1024 * 1024);
  document.getElementById('sizeEstimateDisplay').textContent = `${mb.toFixed(2)} MB`;
}

// Live Oscilloscope Waveform & Audio VU Meter
function drawLiveWaveform() {
  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width = canvas.offsetWidth;
  const height = canvas.height = canvas.offsetHeight;
  const vuBar = document.getElementById('micVolumeBar');
  const vuText = document.getElementById('micVolumePercent');

  if (!analyserNode) return;
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function render() {
    visualizerAnimationId = requestAnimationFrame(render);
    analyserNode.getByteTimeDomainData(dataArray);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#10b981';
    ctx.beginPath();

    const sliceWidth = width * 1.0 / bufferLength;
    let x = 0;
    let sumSquares = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * height) / 2;

      const deviation = (dataArray[i] - 128) / 128;
      sumSquares += deviation * deviation;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Calculate Volume RMS (0% to 100%)
    const rms = Math.sqrt(sumSquares / bufferLength);
    const volumePercent = Math.min(100, Math.round(rms * 250));
    if (vuBar) vuBar.style.width = volumePercent + '%';
    if (vuText) vuText.textContent = volumePercent + '%';
  }
  render();
}

function drawStaticWaveform() {
  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width = canvas.offsetWidth;
  const height = canvas.height = canvas.offsetHeight;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
}

function resetVuMeter() {
  const vuBar = document.getElementById('micVolumeBar');
  const vuText = document.getElementById('micVolumePercent');
  if (vuBar) vuBar.style.width = '0%';
  if (vuText) vuText.textContent = '0%';
}

// --------------------------------------------------------------------------
// 2. LIVE SPEECH-TO-TEXT INTO THE SINGLE UNIFIED TEXT BOX
// --------------------------------------------------------------------------

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition API not available in this browser.');
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'km-KH'; // Khmer

  speechRecognition.onstart = () => {
    isRecognizing = true;
  };

  speechRecognition.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      let trans = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        // Real-time filter: strip out stray English/Latin noise tokens when transcribing Khmer
        trans = trans.replace(/\b[a-zA-Z]+\b/g, '').replace(/[ \t]+/g, ' ');
        accumulatedTranscript += trans + ' ';
      } else {
        interim += trans;
      }
    }
    interimTranscript = interim;

    // Stream directly into the single unified text box!
    const box = document.getElementById('unifiedTextBox');
    if (box) {
      box.value = (accumulatedTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();
      updateBoxCounts();
      box.scrollTop = box.scrollHeight;
    }
  };

  speechRecognition.onerror = event => {
    console.warn('Speech recognition notice:', event.error);
    if (event.error === 'no-speech' || event.error === 'aborted') {
      // Normal pause during speech, watchdog will keep active
      return;
    }
    if (event.error === 'language-not-supported') {
      showToast('Microsoft Edge មិនគាំទ្រភាសាខ្មែរទេ។ សូមបើកកម្មវិធី Google Chrome ដើម្បីបម្លែងជាអក្សរខ្មែរផ្ទាល់!', 'error');
    }
  };

  speechRecognition.onend = () => {
    isRecognizing = false;
    if (mediaRecorder && mediaRecorder.state === 'recording' && !isPaused) {
      try {
        speechRecognition.start();
      } catch (e) {}
    }
  };
}

function startSpeechRecognition() {
  if (!speechRecognition) return;
  try {
    speechRecognition.start();
    isRecognizing = true;
  } catch (e) {}
}

// --------------------------------------------------------------------------
// 3. SINGLE UNIFIED TEXT BOX ACTIONS (COPY, PASTE, CLEAR, TRANSLATE)
// --------------------------------------------------------------------------

function updateBoxCounts() {
  const box = document.getElementById('unifiedTextBox');
  if (!box) return;
  const text = box.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.length;
  const countEl = document.getElementById('boxWordCount');
  if (countEl) countEl.textContent = `${words} ពាក្យ • ${chars} តួអក្សរ`;
}

function copyUnifiedText() {
  const box = document.getElementById('unifiedTextBox');
  if (!box || !box.value.trim()) {
    showToast('គ្មានអត្ថបទដើម្បីចម្លងទេ', 'info');
    return;
  }

  const textToCopy = box.value.trim();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('បានចម្លងអត្ថបទទាំងអស់រួចរាល់ (Copied)!', 'success');
    }).catch(() => {
      box.select();
      document.execCommand('copy');
      showToast('បានចម្លងអត្ថបទរួចរាល់!', 'success');
    });
  } else {
    box.select();
    document.execCommand('copy');
    showToast('បានចម្លងអត្ថបទរួចរាល់!', 'success');
  }
}

async function pasteUnifiedText() {
  const box = document.getElementById('unifiedTextBox');
  if (!box) return;

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const clipText = await navigator.clipboard.readText();
      if (clipText) {
        box.value = (box.value ? box.value + '\n' : '') + clipText;
        updateBoxCounts();
        showToast('បានបិទភ្ជាប់អត្ថបទជោគជ័យ (Pasted)!', 'success');
        return;
      }
    }
    box.focus();
    showToast('សូមចុច Ctrl+V (ឬចុចសង្កត់លើអេក្រង់ដើម្បី Paste) ក្នុងប្រអប់នេះ', 'info');
  } catch (err) {
    box.focus();
    showToast('សូមចុច Ctrl+V (ឬ Paste) ក្នុងប្រអប់នេះ', 'info');
  }
}

function clearUnifiedText() {
  const box = document.getElementById('unifiedTextBox');
  if (box) {
    box.value = '';
    accumulatedTranscript = '';
    interimTranscript = '';
    updateBoxCounts();
    showToast('បានលុបសម្អាតអត្ថបទរួចរាល់', 'info');
  }
}

function sendBoxToPersonalTelegram() {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    showToast('សូមវាយបញ្ចូល ឬថតសម្លេងជាមុនសិន', 'error');
    return;
  }
  openPersonalTelegram({
    title: 'អត្ថបទបម្លែងសម្លេង Voice-V5',
    transcript: text
  });
}

function applyBoxToMinutes() {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    showToast('សូមវាយបញ្ចូល ឬថតសម្លេងជាមុនសិន', 'error');
    return;
  }
  document.getElementById('minContent').value = text;
  switchTab('minutes');
  switchAdminDocType('minutes');
  updateMinutesPreview();
  showToast('បានបញ្ចូលអត្ថបទទៅក្នុងកំណត់ហេតុរដ្ឋបាល!', 'success');
}

function applyBoxToInvitation() {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    showToast('សូមវាយបញ្ចូល ឬថតសម្លេងជាមុនសិន', 'error');
    return;
  }
  document.getElementById('invPurpose').value = text;
  switchTab('minutes');
  switchAdminDocType('invitation');
  updateInvitationPreview();
  showToast('បានបញ្ចូលអត្ថបទទៅក្នុងលិខិតអញ្ជើញ!', 'success');
}

function applyBoxToRouting() {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    showToast('សូមវាយបញ្ចូល ឬថតសម្លេងជាមុនសិន', 'error');
    return;
  }
  document.getElementById('rtSubject').value = text;
  switchTab('minutes');
  switchAdminDocType('routing');
  updateRoutingPreview();
  showToast('បានបញ្ចូលអត្ថបទទៅក្នុងកំណត់បង្ហាញលិខិតចូល!', 'success');
}

async function translateUnifiedBox() {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    showToast('សូមវាយបញ្ចូល ឬថតសម្លេងជាមុនសិន', 'error');
    return;
  }
  const tl = document.getElementById('quickTransLang')?.value || 'en';
  showToast('កំពុងបកប្រែ...', 'info');

  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sl: 'km', tl })
    });
    const data = await resp.json();
    if (data.translatedText) {
      box.value = text + '\n\n--- [ការបកប្រែ / Translation] ---\n' + data.translatedText;
      updateBoxCounts();
      showToast('បានបកប្រែជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បរាជ័យក្នុងការបកប្រែ៖ ' + err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// AI & LINGUISTIC KHMER TRANSCRIPT REFINEMENT
// --------------------------------------------------------------------------

async function refineUnifiedTextWithAI(isSilent = false) {
  const box = document.getElementById('unifiedTextBox');
  const text = box ? box.value.trim() : '';
  if (!text) {
    if (!isSilent) showToast('គ្មានអត្ថបទដើម្បីកែសម្រួលទេ', 'info');
    return;
  }

  const btn = document.getElementById('btnRefineKhmer');
  const btnText = document.getElementById('refineBtnText');
  if (btn && !isSilent) {
    btn.disabled = true;
    if (btnText) btnText.innerHTML = '<span class="animate-spin inline-block mr-1">⌛</span> កំពុងកែសម្រួល...';
  }

  try {
    const response = await fetch('/api/ai/refine-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await response.json();

    if (data.success && data.refinedText) {
      box.value = data.refinedText;
      updateBoxCounts();

      if (!isSilent) {
        if (data.aiRefined) {
          showToast('✨ បានកែសម្រួលអក្ខរាវិរុទ្ធ និងវេយ្យាករណ៍ខ្មែរតាម AI ជោគជ័យ!', 'success');
        } else {
          showToast('✨ បានកែសម្រួលអក្ខរាវិរុទ្ធ និងលុបពាក្យច្រឡំរួចរាល់!', 'success');
        }
      }
    }
  } catch (err) {
    console.error('Refine error:', err);
    if (!isSilent) showToast('បរាជ័យក្នុងការកែសម្រួល៖ ' + err.message, 'error');
  } finally {
    if (btn && !isSilent) {
      btn.disabled = false;
      if (btnText) btnText.innerHTML = '✨ កែអក្ខរាវិរុទ្ធ (AI Refine)';
    }
  }
}

// --------------------------------------------------------------------------
// 4. SAVE RECORDING TO SERVER
// --------------------------------------------------------------------------

async function saveRecordingToServer() {
  if (!currentAudioBlob || currentAudioBlob.size === 0) {
    showToast('គ្មានទិន្នន័យសម្លេងដើម្បីរក្សាទុក', 'error');
    return;
  }

  const title = `ការថតសម្លេង_${new Date().toLocaleDateString('km-KH').replace(/\//g, '-')}_${new Date().toLocaleTimeString('km-KH').replace(/:/g, '')}`;
  const box = document.getElementById('unifiedTextBox');

  // Auto-refine Khmer transcript if enabled
  const autoRefine = document.getElementById('chkAutoRefineKhmer')?.checked;
  if (autoRefine && box && box.value.trim()) {
    await refineUnifiedTextWithAI(true);
  }

  const transcriptText = box ? box.value.trim() : accumulatedTranscript.trim();

  try {
    const response = await fetch('/api/recordings/upload', {
      method: 'POST',
      headers: {
        'x-file-title': encodeURIComponent(title),
        'x-file-duration': String(recordedDurationSeconds),
        'x-original-name': encodeURIComponent('recording.webm'),
        'x-mime-type': currentAudioBlob.type || 'audio/webm',
        'x-transcript': encodeURIComponent(transcriptText),
        'x-translation': ''
      },
      body: currentAudioBlob
    });

    const result = await response.json();
    if (result.success && result.recording) {
      showToast('បានរក្សាទុកការថតសម្លេងជោគជ័យ!', 'success');
      
      // If transcript was empty on PC, and Gemini key exists, transcribe it
      if (!transcriptText && appConfig.geminiApiKey) {
        showToast('កំពុងបម្លែងសម្លេងតាម Gemini AI...', 'info');
        try {
          const transResp = await fetch('/api/ai/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordingId: result.recording.id })
          });
          const transData = await transResp.json();
          if (transData.success && transData.transcript && box) {
            box.value = transData.transcript;
            updateBoxCounts();
            showToast('បានបម្លែងជាអក្សរខ្មែរជោគជ័យ!', 'success');
          }
        } catch (e) {}
      }

      if (document.getElementById('chkAutoMinutes').checked && transcriptText) {
        document.getElementById('minContent').value = transcriptText;
        updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
      }

      await loadRecordings();

      const autoPersonalTg = document.getElementById('chkAutoPersonalTelegram')?.checked;
      if (autoPersonalTg) {
        openPersonalTelegram({
          title,
          duration: recordedDurationSeconds,
          transcript: transcriptText,
          recordingId: result.recording.id
        });
      }
    } else {
      throw new Error(result.error || 'Server error');
    }
  } catch (err) {
    console.error('Upload error:', err);
    showToast('បរាជ័យក្នុងការបញ្ជូនឯកសារទៅ server៖ ' + err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// 5. PERSONAL TELEGRAM 1-CLICK SHARE
// --------------------------------------------------------------------------

async function getShareUrlForRecording(recordingId) {
  try {
    const resp = await fetch('/api/network-info');
    const info = await resp.json();
    const base = info.tunnelUrl || info.hostUrl || window.location.origin;
    return `${base}/share?id=${recordingId}`;
  } catch (e) {
    return `${window.location.origin}/share?id=${recordingId}`;
  }
}

async function openPersonalTelegram({ title, duration, transcript, minutes, recordingId }) {
  showToast('កំពុងរៀបចំ និងចម្លងខ្លឹមសារទៅ Telegram...', 'info');

  let shareUrl = window.location.origin;
  if (recordingId) {
    shareUrl = await getShareUrlForRecording(recordingId);
  } else {
    try {
      const resp = await fetch('/api/network-info');
      const net = await resp.json();
      shareUrl = net.tunnelUrl || net.hostUrl || window.location.origin;
    } catch (e) {}
  }

  // 1. Build FULL detailed message for clipboard (100% complete)
  let fullMessage = `🎙️ ឯកសារថតសម្លេង៖ ${title || 'ការថតសម្លេង Voice-V5'}\n`;
  if (duration && duration > 0) {
    fullMessage += `⏱️ រយៈពេល៖ ${Math.round(duration)} វិនាទី\n`;
  }
  fullMessage += `\n`;

  if (minutes && minutes.title) {
    fullMessage += `📄 កំណត់ហេតុរដ្ឋបាល៖ ${minutes.title}\n`;
    if (minutes.datetime) fullMessage += `📅 កាលបរិច្ឆេទ៖ ${minutes.datetime}\n`;
    if (minutes.location) fullMessage += `📍 ទីកន្លែង៖ ${minutes.location}\n`;
    if (minutes.attendees) fullMessage += `👥 សមាសភាពចូលរួម៖\n${minutes.attendees}\n\n`;
    if (minutes.agenda) fullMessage += `📋 របៀបវារៈ៖\n${minutes.agenda}\n\n`;
    if (minutes.content) fullMessage += `📝 ដំណើរការអង្គប្រជុំ៖\n${minutes.content}\n\n`;
    if (minutes.decisions) fullMessage += `✅ សេចក្តីសម្រេច៖\n${minutes.decisions}\n\n`;
  } else if (transcript && transcript.trim()) {
    fullMessage += `📝 ខ្លឹមសារបម្លែងសម្លេង៖\n${transcript.trim()}\n\n`;
  }

  fullMessage += `🔗 តំណភ្ជាប់ស្តាប់ & ទាញយកឯកសារ៖\n${shareUrl}`;

  // Copy FULL message to clipboard so user can paste the complete text anytime!
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(fullMessage);
      copied = true;
    } else {
      throw new Error('Fallback needed');
    }
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = fullMessage;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copied = true;
    } catch (err) {}
  }

  // 2. Guaranteed safe Telegram URL parameter:
  // Strictly clean, short title without any emoji surrogates or broken UTF-8
  const username = (appConfig.personalTelegramUsername || document.getElementById('cfgPersonalUsername')?.value || '').replace(/^@/, '').trim();

  let tgUrl = '';
  if (username) {
    tgUrl = `https://t.me/${username}`;
  } else {
    // Strip symbols, emojis, and quotes to avoid any proxy/nginx 400 Bad Request error
    const rawName = (title || 'Voice-V5').replace(/[^\u1780-\u17FFa-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const safeCaption = Array.from(rawName).slice(0, 30).join('').trim() || 'Voice-V5 Audio';
    const textParam = encodeURIComponent(`Voice-V5: ${safeCaption}`);
    const urlParam = encodeURIComponent(shareUrl);
    tgUrl = `https://t.me/share/url?url=${urlParam}&text=${textParam}`;
  }

  window.open(tgUrl, '_blank');

  if (copied) {
    showToast('✅ បានចម្លងខ្លឹមសារពេញលេញ (100%) ចូលក្ដារចម្លង (Clipboard)! សូមចុច Ctrl+V (Paste) ក្នុង Telegram', 'success', 6000);
  } else {
    showToast('បានបើក Telegram!', 'info');
  }
}

function testOpenPersonalTelegram() {
  const username = (appConfig.personalTelegramUsername || document.getElementById('cfgPersonalUsername')?.value || '').replace(/^@/, '').trim();
  const testText = encodeURIComponent('Voice-V5 Pro Telegram Connection OK');
  
  let tgUrl = '';
  if (username) {
    tgUrl = `https://t.me/${username}`;
  } else {
    tgUrl = `https://t.me/share/url?url=${encodeURIComponent(window.location.origin)}&text=${testText}`;
  }
  window.open(tgUrl, '_blank');
  showToast('បានបើកកម្មវិធី Telegram!', 'success');
}

async function sendToPersonalTelegram(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec) return;

  await openPersonalTelegram({
    title: rec.title,
    duration: rec.duration,
    transcript: rec.transcript,
    minutes: rec.administrativeMinutes,
    recordingId: rec.id
  });
}

async function sendMinutesToPersonalTelegram() {
  const minutes = getMinutesData();
  await openPersonalTelegram({
    title: `កំណត់ហេតុ៖ ${minutes.title}`,
    transcript: minutes.content,
    minutes: minutes
  });
}

// --------------------------------------------------------------------------
// 6. DRAG-AND-DROP FILE UPLOADER
// --------------------------------------------------------------------------

function setupDragAndDrop() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.add('border-emerald-500', 'bg-emerald-500/10');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.remove('border-emerald-500', 'bg-emerald-500/10');
    });
  });

  dropZone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadDroppedFiles(files);
    }
  });
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    uploadDroppedFiles(files);
  }
}

async function uploadDroppedFiles(files) {
  for (const file of files) {
    showToast(`កំពុងបង្ហោះឯកសារ៖ ${file.name}...`, 'info');
    try {
      const response = await fetch('/api/recordings/upload', {
        method: 'POST',
        headers: {
          'x-file-title': encodeURIComponent(file.name.replace(/\.[^/.]+$/, "")),
          'x-file-duration': '0',
          'x-original-name': encodeURIComponent(file.name),
          'x-mime-type': file.type || 'application/octet-stream',
          'x-transcript': '',
          'x-translation': ''
        },
        body: file
      });
      const data = await response.json();
      if (data.success && data.recording) {
        showToast(`បានបង្ហោះ ${file.name} ជោគជ័យ!`, 'success');
        
        // Auto-transcribe if Gemini key configured
        if (appConfig.geminiApiKey) {
          fetch('/api/ai/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordingId: data.recording.id })
          }).then(() => loadRecordings());
        }
      }
    } catch (err) {
      showToast(`បរាជ័យក្នុងការបង្ហោះ ${file.name}៖ ${err.message}`, 'error');
    }
  }
  await loadRecordings();
}

// --------------------------------------------------------------------------
// 7. LOAD & RENDER RECORDINGS LIBRARY
// --------------------------------------------------------------------------

async function loadRecordings() {
  try {
    const resp = await fetch('/api/recordings');
    allRecordings = await resp.json();
    
    const badge = document.getElementById('badge-recordings-count');
    if (badge) badge.textContent = allRecordings.length;

    renderRecordingsList(allRecordings);
  } catch (err) {
    console.error('Error fetching recordings:', err);
  }
}

function filterRecordings(keyword) {
  const q = (keyword || '').toLowerCase().trim();
  if (!q) {
    renderRecordingsList(allRecordings);
    return;
  }
  const filtered = allRecordings.filter(r => 
    (r.title && r.title.toLowerCase().includes(q)) ||
    (r.transcript && r.transcript.toLowerCase().includes(q)) ||
    (r.originalName && r.originalName.toLowerCase().includes(q))
  );
  renderRecordingsList(filtered);
}

function renderRecordingsList(recordings) {
  const container = document.getElementById('recordingsList');
  if (!recordings || recordings.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 text-slate-500 bg-slate-950 rounded-2xl border border-slate-800">
        <i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2 opacity-50"></i>
        <p class="text-sm">មិនទាន់មានឯកសារថតសម្លេងនៅឡើយទេ</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = recordings.map(rec => {
    const isAudio = rec.mimeType?.startsWith('audio') || ['webm', 'mp3', 'wav', 'ogg', 'm4a', 'amr'].some(ext => rec.filename?.endsWith(ext));
    const sizeMb = (rec.size / (1024 * 1024)).toFixed(2);
    const dateFormatted = new Date(rec.createdAt).toLocaleString('km-KH');
    const hasTranscript = rec.transcript && rec.transcript.trim().length > 0;

    return `
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 sm:p-5 hover:border-slate-700 transition space-y-3">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-start gap-3">
            <div class="w-10 h-10 rounded-xl ${isAudio ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'} flex items-center justify-center flex-shrink-0 mt-0.5">
              <i data-lucide="${isAudio ? 'mic' : 'file'}" class="w-5 h-5"></i>
            </div>
            <div>
              <h4 class="text-sm font-bold text-white">${rec.title || rec.originalName}</h4>
              <div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                <span><i data-lucide="calendar" class="w-3 h-3 inline"></i> ${dateFormatted}</span>
                <span>•</span>
                <span class="font-mono">${sizeMb} MB</span>
                ${rec.duration ? `<span>•</span> <span class="font-mono">${Math.round(rec.duration)}s</span>` : ''}
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1.5 self-end sm:self-center">
            ${isAudio ? `
              <button onclick="playAudioFile('${rec.id}', '${encodeURIComponent(rec.title)}', '${rec.filename}')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium flex items-center gap-1 transition">
                <i data-lucide="play" class="w-3.5 h-3.5 fill-white"></i>
                <span>ចាក់ស្តាប់</span>
              </button>
            ` : ''}

            <!-- Load into unified box -->
            <button onclick="loadIntoUnifiedBox('${rec.id}')" title="ទាញយកអត្ថបទចូលប្រអប់" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-xs transition">
              <i data-lucide="edit-3" class="w-3.5 h-3.5 text-emerald-400"></i>
            </button>

            <!-- Refine or Transcribe with AI -->
            ${hasTranscript ? `
              <button onclick="refineRecordingTranscript('${rec.id}')" title="✨ កែសម្រួលអក្ខរាវិរុទ្ធ (AI Refine)" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-purple-400 border border-slate-800 rounded-lg text-xs transition">
                <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
              </button>
            ` : (isAudio ? `
              <button onclick="transcribeRecordingWithAI('${rec.id}')" title="🎙️ បម្លែងសម្លេងជាអក្សរ (AI Transcribe)" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-purple-400 border border-slate-800 rounded-lg text-xs transition">
                <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
              </button>
            ` : '')}

            <!-- Personal Telegram -->
            <button onclick="sendToPersonalTelegram('${rec.id}')" title="ផ្ញើទៅ Telegram បុគ្គល" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-medium flex items-center gap-1 transition shadow-sm">
              <i data-lucide="send" class="w-3.5 h-3.5"></i>
              <span>ផ្ញើ Telegram</span>
            </button>

            <!-- QR Share -->
            <button onclick="openShareForRecording('${rec.id}')" title="ចែករំលែក QR & Link" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-xs transition">
              <i data-lucide="qr-code" class="w-3.5 h-3.5 text-emerald-400"></i>
            </button>

            <!-- Minutes -->
            <button onclick="applyToMinutes('${rec.id}')" title="បម្លែងជាកំណត់ហេតុ" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-xs transition">
              <i data-lucide="file-text" class="w-3.5 h-3.5 text-amber-400"></i>
            </button>

            <!-- Download -->
            <a href="/uploads/${rec.filename}" download="${rec.originalName || rec.filename}" title="ទាញយក" class="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-xs transition">
              <i data-lucide="download" class="w-3.5 h-3.5"></i>
            </a>

            <!-- Delete -->
            <button onclick="deleteRecording('${rec.id}')" title="លុបចេញពីបញ្ជី" class="px-2 py-1.5 text-slate-500 hover:text-rose-400 transition">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        ${hasTranscript ? `
          <div class="bg-slate-900/80 rounded-lg p-3 text-xs text-slate-300 leading-relaxed font-khmer border border-slate-850">
            <span class="text-slate-500 font-semibold">ខ្លឹមសារបម្លែងសម្លេង៖</span> ${rec.transcript.substring(0, 160)}${rec.transcript.length > 160 ? '...' : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function loadIntoUnifiedBox(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec) return;

  const box = document.getElementById('unifiedTextBox');
  if (box) {
    box.value = rec.transcript || `[ឯកសារ៖ ${rec.title}]`;
    updateBoxCounts();
    switchTab('record');
    box.scrollIntoView({ behavior: 'smooth' });
    showToast(`បានទាញអត្ថបទពី "${rec.title}" ចូលប្រអប់រួចរាល់`, 'success');
  }
}

async function refineRecordingTranscript(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec || !rec.transcript) return;

  showToast('កំពុងកែសម្រួលអក្ខរាវិរុទ្ធឯកសារនេះ...', 'info');
  try {
    const resp = await fetch('/api/ai/refine-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: rec.transcript })
    });
    const data = await resp.json();
    if (data.success && data.refinedText) {
      rec.transcript = data.refinedText;
      // Save updated transcript on server
      await fetch(`/api/recordings/${recordingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: data.refinedText })
      });
      await loadRecordings();
      showToast('✨ បានកែសម្រួលអក្ខរាវិរុទ្ធជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បរាជ័យក្នុងការកែសម្រួល៖ ' + err.message, 'error');
  }
}

async function transcribeRecordingWithAI(recordingId) {
  showToast('កំពុងបម្លែងសម្លេងជាអក្សរតាម AI...', 'info');
  try {
    const transResp = await fetch('/api/ai/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId })
    });
    const transData = await transResp.json();
    if (transData.success && transData.transcript) {
      await loadRecordings();
      showToast('🎉 បានបម្លែងសម្លេងជាអក្សរខ្មែរជោគជ័យ!', 'success');
    } else {
      showToast(transData.error || 'បរាជ័យក្នុងការបម្លែង (សូមបញ្ចូល Gemini API Key ក្នុង Settings)', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// --------------------------------------------------------------------------
// 8. AUDIO PLAYER
// --------------------------------------------------------------------------

function playAudioFile(id, titleEncoded, filename) {
  const title = decodeURIComponent(titleEncoded);
  const audioUrl = `/uploads/${filename}`;
  const bar = document.getElementById('playerBar');
  const titleEl = document.getElementById('playerTitle');
  const playBtn = document.getElementById('playerPlayBtn');
  const seekSlider = document.getElementById('playerSeekSlider');
  const timeEl = document.getElementById('playerTime');

  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
  }

  currentPlayingAudio = new Audio(audioUrl);
  currentPlayingAudio.playbackRate = parseFloat(document.getElementById('playerSpeedSelect').value || '1');
  titleEl.textContent = title;
  bar.classList.remove('hidden');

  currentPlayingAudio.play().then(() => {
    playBtn.innerHTML = '<i data-lucide="pause" class="w-4 h-4 fill-slate-950"></i>';
    lucide.createIcons();
  }).catch(err => {
    console.warn('Audio play notice:', err);
    showToast('Browser មិនអាចចាក់ file នេះដោយផ្ទាល់បានទេ (សូមចុចប៊ូតុង "ទាញយក" ដើម្បីស្តាប់លើ Device របស់អ្នក)', 'info');
  });

  clearInterval(playerUpdateInterval);
  playerUpdateInterval = setInterval(() => {
    if (currentPlayingAudio && currentPlayingAudio.duration) {
      const cur = currentPlayingAudio.currentTime;
      const dur = currentPlayingAudio.duration;
      seekSlider.value = (cur / dur) * 100;
      timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
  }, 250);

  currentPlayingAudio.onended = () => {
    playBtn.innerHTML = '<i data-lucide="play" class="w-4 h-4 fill-slate-950 ml-0.5"></i>';
    lucide.createIcons();
  };
}

function togglePlayPauseAudio() {
  if (!currentPlayingAudio) return;
  const playBtn = document.getElementById('playerPlayBtn');
  if (currentPlayingAudio.paused) {
    currentPlayingAudio.play();
    playBtn.innerHTML = '<i data-lucide="pause" class="w-4 h-4 fill-slate-950"></i>';
  } else {
    currentPlayingAudio.pause();
    playBtn.innerHTML = '<i data-lucide="play" class="w-4 h-4 fill-slate-950 ml-0.5"></i>';
  }
  lucide.createIcons();
}

function seekPlayer(seconds) {
  if (!currentPlayingAudio) return;
  currentPlayingAudio.currentTime = Math.max(0, Math.min(currentPlayingAudio.currentTime + seconds, currentPlayingAudio.duration || 0));
}

function onSeekSliderChange(val) {
  if (!currentPlayingAudio || !currentPlayingAudio.duration) return;
  currentPlayingAudio.currentTime = (val / 100) * currentPlayingAudio.duration;
}

function changePlaybackSpeed(speed) {
  if (currentPlayingAudio) {
    currentPlayingAudio.playbackRate = parseFloat(speed);
  }
}

function closePlayer() {
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    currentPlayingAudio = null;
  }
  clearInterval(playerUpdateInterval);
  document.getElementById('playerBar').classList.add('hidden');
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------
// 9. CAMBODIAN ADMINISTRATIVE MINUTES (ក្រសួងមហាផ្ទៃ FORMAT)
// --------------------------------------------------------------------------

function initMinutesDate() {
  const today = new Date();
  const day = today.getDate();
  const khmerMonths = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
  const monthName = khmerMonths[today.getMonth()];
  const year = today.getFullYear();
  document.getElementById('minDatetime').value = `ថ្ងៃទី${day} ខែ${monthName} ឆ្នាំ${year}`;
}

// --------------------------------------------------------------------------
// DYNAMIC SECTIONS & CUSTOM TABLES / COLUMNS (បន្ថែម CULUME / ជួរឈរ & ផ្នែក)
// --------------------------------------------------------------------------

function addCustomSection(initialData = null) {
  const sectionId = 'sec_' + Date.now();
  const romanNumerals = ['V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
  const nextNum = romanNumerals[customMinutesSections.length] || `ចំណុចទី ${customMinutesSections.length + 5}`;
  
  const sec = initialData || {
    id: sectionId,
    title: `${nextNum}. បញ្ហាផ្សេងៗ`,
    content: ''
  };
  
  customMinutesSections.push(sec);
  renderCustomSectionsEditor();
  updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  showToast('បានបន្ថែមផ្នែក/ជំពូកថ្មី!', 'info');
}

function removeCustomSection(secId) {
  customMinutesSections = customMinutesSections.filter(s => s.id !== secId);
  renderCustomSectionsEditor();
  updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
}

function updateCustomSection(secId, field, val) {
  const target = customMinutesSections.find(s => s.id === secId);
  if (target) {
    target[field] = val;
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function renderCustomSectionsEditor() {
  const container = document.getElementById('dynamicSectionsContainer');
  if (!container) return;
  
  container.innerHTML = customMinutesSections.map(sec => `
    <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3 space-y-2 relative" data-sec-id="${sec.id}">
      <div class="flex items-center justify-between gap-2">
        <input type="text" value="${escapeHtml(sec.title)}" 
          oninput="updateCustomSection('${sec.id}', 'title', this.value)"
          placeholder="ចំណងជើងផ្នែក (ឧ. V. បញ្ហាផ្សេងៗ)"
          class="flex-1 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-emerald-400 font-bold focus:outline-none focus:border-emerald-500">
        <button type="button" onclick="removeCustomSection('${sec.id}')" 
          class="p-1.5 text-slate-500 hover:text-rose-400 transition" title="លុបផ្នែកនេះ">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <textarea rows="2" 
        oninput="updateCustomSection('${sec.id}', 'content', this.value)"
        placeholder="ខ្លឹមសារនៃផ្នែកនេះ..."
        class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 leading-relaxed">${escapeHtml(sec.content)}</textarea>
    </div>
  `).join('');
  
  if (window.lucide) lucide.createIcons();
}

// --------------------------------------------------------------------------
// CUSTOM TABLES WITH DYNAMIC COLUMNS (តារាង និងជួរឈរ CULUME)
// --------------------------------------------------------------------------

function addCustomTable(initialData = null) {
  const tableId = 'tbl_' + Date.now();
  const tbl = initialData || {
    id: tableId,
    title: 'តារាងបែងចែកភារកិច្ច និងទិសដៅអនុវត្ត',
    columns: ['ល.រ', 'ខ្លឹមសារការងារ', 'អ្នកទទួលបន្ទុក', 'កាលបរិច្ឆេទ', 'ស្ថានភាព'],
    rows: [
      ['១', 'រៀបចំផែនការលម្អិត', 'នាយកដ្ឋានកិច្ចការទូទៅ', 'សប្តាហ៍ទី២', 'កំពុងអនុវត្ត']
    ]
  };

  customMinutesTables.push(tbl);
  renderCustomTablesEditor();
  updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  showToast('បានបន្ថែមតារាង & Column/ជួរឈរថ្មី!', 'info');
}

function removeCustomTable(tblId) {
  customMinutesTables = customMinutesTables.filter(t => t.id !== tblId);
  renderCustomTablesEditor();
  updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
}

function updateTableTitle(tblId, val) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl) {
    tbl.title = val;
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function addTableColumn(tblId) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl) {
    const colNum = tbl.columns.length + 1;
    tbl.columns.push(`Column ${colNum}`);
    tbl.rows.forEach(r => r.push(''));
    renderCustomTablesEditor();
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
    showToast(`បានបន្ថែម Column ទី ${colNum}!`, 'info');
  }
}

function removeTableColumn(tblId) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl && tbl.columns.length > 1) {
    tbl.columns.pop();
    tbl.rows.forEach(r => r.pop());
    renderCustomTablesEditor();
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function updateTableColName(tblId, colIdx, val) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl) {
    tbl.columns[colIdx] = val;
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function addTableRow(tblId) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl) {
    const newRow = tbl.columns.map((_, i) => i === 0 ? String(tbl.rows.length + 1) : '');
    tbl.rows.push(newRow);
    renderCustomTablesEditor();
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function removeTableRow(tblId, rowIdx) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl) {
    tbl.rows.splice(rowIdx, 1);
    renderCustomTablesEditor();
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function updateTableCell(tblId, rowIdx, colIdx, val) {
  const tbl = customMinutesTables.find(t => t.id === tblId);
  if (tbl && tbl.rows[rowIdx]) {
    tbl.rows[rowIdx][colIdx] = val;
    updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
  }
}

function renderCustomTablesEditor() {
  const container = document.getElementById('dynamicTablesContainer');
  if (!container) return;

  container.innerHTML = customMinutesTables.map(tbl => `
    <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3 space-y-3" data-tbl-id="${tbl.id}">
      <div class="flex items-center justify-between gap-2">
        <input type="text" value="${escapeHtml(tbl.title)}"
          oninput="updateTableTitle('${tbl.id}', this.value)"
          placeholder="ចំណងជើងតារាង (ឧ. តារាងបែងចែកភារកិច្ច...)"
          class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-sky-400 font-bold focus:outline-none focus:border-sky-500">
        <button type="button" onclick="removeCustomTable('${tbl.id}')"
          class="p-1.5 text-slate-500 hover:text-rose-400 transition" title="លុបតារាងនេះ">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>

      <!-- Column Headers Config -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between text-[11px] text-slate-400">
          <span>ជួរឈរ (Columns - ចំនួន ${tbl.columns.length})៖</span>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="addTableColumn('${tbl.id}')" class="px-2 py-0.5 bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-700/60 rounded text-[10px] font-semibold flex items-center gap-1 transition">
              <i data-lucide="plus" class="w-3 h-3"></i> + Column
            </button>
            ${tbl.columns.length > 1 ? `
              <button type="button" onclick="removeTableColumn('${tbl.id}')" class="px-2 py-0.5 bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-700/60 rounded text-[10px] font-semibold flex items-center gap-1 transition">
                <i data-lucide="minus" class="w-3 h-3"></i> - Column
              </button>
            ` : ''}
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5">
          ${tbl.columns.map((col, cIdx) => `
            <input type="text" value="${escapeHtml(col)}"
              oninput="updateTableColName('${tbl.id}', ${cIdx}, this.value)"
              placeholder="Col ${cIdx + 1}"
              class="w-20 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-sky-500 font-semibold text-center">
          `).join('')}
        </div>
      </div>

      <!-- Table Rows Editor -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between text-[11px] text-slate-400">
          <span>ទិន្នន័យក្នុងតារាង (${tbl.rows.length} ជួរដេក)៖</span>
          <button type="button" onclick="addTableRow('${tbl.id}')" class="px-2 py-0.5 bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/60 rounded text-[10px] font-semibold flex items-center gap-1 transition">
            <i data-lucide="plus" class="w-3 h-3"></i> + ជួរដេក
          </button>
        </div>

        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          ${tbl.rows.map((row, rIdx) => `
            <div class="flex items-center gap-1 bg-slate-950/70 p-1.5 rounded border border-slate-850">
              <div class="flex-1 grid grid-cols-${Math.min(tbl.columns.length, 5)} gap-1">
                ${row.map((cell, cIdx) => `
                  <input type="text" value="${escapeHtml(cell)}"
                    oninput="updateTableCell('${tbl.id}', ${rIdx}, ${cIdx}, this.value)"
                    placeholder="${escapeHtml(tbl.columns[cIdx] || '')}"
                    class="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-sky-500">
                `).join('')}
              </div>
              <button type="button" onclick="removeTableRow('${tbl.id}', ${rIdx})" class="p-1 text-slate-500 hover:text-rose-400" title="លុបជួរដេក">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

function updateMinutesPreview() {
  const ministry = document.getElementById('minMinistry').value;
  const title = document.getElementById('minTitle').value;
  const datetime = document.getElementById('minDatetime').value;
  const location = document.getElementById('minLocation').value;
  const attendees = document.getElementById('minAttendees').value;
  const agenda = document.getElementById('minAgenda').value;
  const content = document.getElementById('minContent').value;
  const decisions = document.getElementById('minDecisions').value;
  const recorder = document.getElementById('minRecorder').value;
  const chair = document.getElementById('minChair').value;

  document.getElementById('pvMinistry').innerHTML = ministry.replace(/\n/g, '<br>');
  document.getElementById('pvTitle').textContent = title;
  document.getElementById('pvTitleInline').textContent = title;
  document.getElementById('pvDatetime').textContent = datetime;
  document.getElementById('pvLocation').textContent = location;
  document.getElementById('pvChairInline').textContent = chair;
  document.getElementById('pvAttendees').textContent = attendees;
  document.getElementById('pvAgenda').textContent = agenda;
  document.getElementById('pvContent').textContent = content;
  document.getElementById('pvDecisions').textContent = decisions;
  document.getElementById('pvRecorderSign').textContent = recorder;
  document.getElementById('pvChairSign').textContent = chair;
  document.getElementById('pvSignDate').textContent = datetime;

  // Render Dynamic Custom Sections in Preview
  const pvSections = document.getElementById('pvCustomSections');
  if (pvSections) {
    pvSections.innerHTML = customMinutesSections.map(sec => `
      <div>
        <h4 class="font-muol text-xs mb-1 text-slate-900">${escapeHtml(sec.title || '')}៖</h4>
        <div class="indent-6 whitespace-pre-line text-slate-800 text-justify">${escapeHtml(sec.content || '')}</div>
      </div>
    `).join('');
  }

  // Render Dynamic Custom Tables with Columns in Preview
  const pvTables = document.getElementById('pvCustomTables');
  if (pvTables) {
    pvTables.innerHTML = customMinutesTables.map(tbl => `
      <div class="my-3">
        ${tbl.title ? `<h4 class="font-muol text-xs mb-1.5 text-slate-900 text-center">${escapeHtml(tbl.title)}</h4>` : ''}
        <table class="w-full border-collapse border border-slate-900 text-[11px] my-2 text-slate-900">
          <thead>
            <tr class="bg-slate-100 font-muol text-center border-b border-slate-900">
              ${tbl.columns.map(c => `<th class="border border-slate-900 px-2 py-1 text-center font-bold">${escapeHtml(c)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${tbl.rows.map(row => `
              <tr class="border-b border-slate-900/50">
                ${row.map(cell => `<td class="border border-slate-900 px-2 py-1 align-top">${escapeHtml(cell || '')}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
  }
}

function getMinutesData() {
  return {
    ministry: document.getElementById('minMinistry').value,
    title: document.getElementById('minTitle').value,
    datetime: document.getElementById('minDatetime').value,
    location: document.getElementById('minLocation').value,
    attendees: document.getElementById('minAttendees').value,
    agenda: document.getElementById('minAgenda').value,
    content: document.getElementById('minContent').value,
    decisions: document.getElementById('minDecisions').value,
    customSections: customMinutesSections,
    customTables: customMinutesTables,
    closingNote: document.getElementById('pvClosingNote').textContent.trim(),
    signers: {
      recorder: document.getElementById('minRecorder').value,
      chair: document.getElementById('minChair').value
    }
  };
}

async function aiRefineMinutes() {
  showToast('AI កំពុងរៀបចំទម្រង់កំណត់ហេតុរដ្ឋបាល...', 'info');
  try {
    const currentTranscript = document.getElementById('minContent').value;
    const resp = await fetch('/api/ai/generate-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: currentTranscript,
        title: document.getElementById('minTitle').value,
        attendees: document.getElementById('minAttendees').value,
        location: document.getElementById('minLocation').value,
        ministry: document.getElementById('minMinistry').value
      })
    });
    const data = await resp.json();
    if (data.success && data.minutes) {
      const m = data.minutes;
      if (m.ministry) document.getElementById('minMinistry').value = m.ministry;
      if (m.title) document.getElementById('minTitle').value = m.title;
      if (m.datetime) document.getElementById('minDatetime').value = m.datetime;
      if (m.location) document.getElementById('minLocation').value = m.location;
      if (m.attendees) document.getElementById('minAttendees').value = m.attendees;
      if (m.agenda) document.getElementById('minAgenda').value = m.agenda;
      if (m.content) document.getElementById('minContent').value = m.content;
      if (m.decisions) document.getElementById('minDecisions').value = m.decisions;
      if (m.signers?.recorder) document.getElementById('minRecorder').value = m.signers.recorder;
      if (m.signers?.chair) document.getElementById('minChair').value = m.signers.chair;
      updateMinutesPreview();
  updateInvitationPreview();
  updateRoutingPreview();
      showToast('បានកែសម្រួលទម្រង់កំណត់ហេតុរដ្ឋបាលជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បញ្ហា AI៖ ' + err.message, 'error');
  }
}

function applyToMinutes(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec) return;

  switchTab('minutes');
  switchAdminDocType('minutes');
  if (rec.title) document.getElementById('minTitle').value = rec.title;
  if (rec.transcript) document.getElementById('minContent').value = rec.transcript;
  updateMinutesPreview();
  showToast(`បានបញ្ចូលខ្លឹមសារពី "${rec.title}" ចូលកំណត់ហេតុ`, 'info');
}

function applyToInvitation(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec) return;

  switchTab('minutes');
  switchAdminDocType('invitation');
  if (rec.transcript) document.getElementById('invPurpose').value = rec.transcript;
  updateInvitationPreview();
  showToast(`បានបញ្ចូលខ្លឹមសារពី "${rec.title}" ចូលលិខិតអញ្ជើញ`, 'info');
}

function applyToRouting(recordingId) {
  const rec = allRecordings.find(r => r.id === recordingId);
  if (!rec) return;

  switchTab('minutes');
  switchAdminDocType('routing');
  if (rec.title) document.getElementById('rtSubject').value = rec.title;
  if (rec.transcript) document.getElementById('rtBoxDeputyDept').value = rec.transcript;
  updateRoutingPreview();
  showToast(`បានបញ្ចូលខ្លឹមសារពី "${rec.title}" ចូលកំណត់បង្ហាញលិខិតចូល`, 'info');
}

async function exportWordMinutes() {
  const minutes = getMinutesData();
  showToast('កំពុងទាញយកឯកសារ Word (.doc)...', 'info');

  try {
    const response = await fetch('/api/export/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes })
    });

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `កំណត់ហេតុ_${minutes.title.replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('ទាញយក Word (.doc) ជោគជ័យ!', 'success');
  } catch (err) {
    showToast('បរាជ័យក្នុងការទាញយក Word៖ ' + err.message, 'error');
  }
}

function printMinutes() {
  window.print();
}

// --------------------------------------------------------------------------
// 9. ADMINISTRATIVE DOCUMENTS (MINUTES, INVITATION, ROUTING SLIP)
// --------------------------------------------------------------------------

let currentAdminDocType = 'minutes';

function switchAdminDocType(type) {
  currentAdminDocType = type;

  // 1. Update sub-tab button styles
  const btnMinutes = document.getElementById('subtab-minutes');
  const btnInv = document.getElementById('subtab-invitation');
  const btnRt = document.getElementById('subtab-routing');

  [btnMinutes, btnInv, btnRt].forEach(btn => {
    if (btn) {
      btn.className = 'subtab-doc-btn px-4 py-2.5 rounded-lg text-xs font-bold transition flex items-center gap-2 text-slate-400 hover:text-white hover:bg-slate-800';
    }
  });

  const activeBtn = document.getElementById(`subtab-${type}`);
  if (activeBtn) {
    activeBtn.className = 'subtab-doc-btn px-4 py-2.5 rounded-lg text-xs font-bold transition flex items-center gap-2 bg-emerald-600 text-white shadow-sm';
  }

  // 2. Toggle sections
  const secMinutes = document.getElementById('docSection-minutes');
  const secInv = document.getElementById('docSection-invitation');
  const secRt = document.getElementById('docSection-routing');

  if (secMinutes) secMinutes.classList.toggle('hidden', type !== 'minutes');
  if (secInv) secInv.classList.toggle('hidden', type !== 'invitation');
  if (secRt) secRt.classList.toggle('hidden', type !== 'routing');

  // 3. Update active print area
  const pvMinutes = document.getElementById('printArea');
  const pvInv = document.getElementById('printAreaInvitation');
  const pvRt = document.getElementById('printAreaRouting');

  if (pvMinutes) pvMinutes.classList.toggle('printable-active', type === 'minutes');
  if (pvInv) pvInv.classList.toggle('printable-active', type === 'invitation');
  if (pvRt) pvRt.classList.toggle('printable-active', type === 'routing');

  // 4. Update Header Title & Description
  const headerTitle = document.getElementById('adminDocHeaderTitle');
  const headerDesc = document.getElementById('adminDocHeaderDesc');

  if (type === 'minutes') {
    if (headerTitle) headerTitle.textContent = 'រៀបចំកំណត់ហេតុអង្គប្រជុំរដ្ឋបាល';
    if (headerDesc) headerDesc.textContent = 'បម្លែងទិន្នន័យពីការថតសម្លេងឱ្យទៅជាទម្រង់លិខិតផ្លូវការ អាចទាញយកជា Word (.doc) ឬបោះពុម្ពបានភ្លាមៗ';
    updateMinutesPreview();
  } else if (type === 'invitation') {
    if (headerTitle) headerTitle.textContent = 'រៀបចំលិខិតអញ្ជើញរដ្ឋបាល (Invitation Letter)';
    if (headerDesc) headerDesc.textContent = 'ទម្រង់លិខិតអញ្ជើញផ្លូវការរបស់សាលាជាតិរដ្ឋបាលមូលដ្ឋាន មានភ្ជាប់ QR Code និង Meeting Info';
    updateInvitationPreview();
  } else if (type === 'routing') {
    if (headerTitle) headerTitle.textContent = 'រៀបចំកំណត់បង្ហាញលិខិតចូល (Routing Slip)';
    if (headerDesc) headerDesc.textContent = 'ទម្រង់កំណត់បង្ហាញលិខិតចូលផ្លូវការ មាន ៤ ប្រអប់យោបល់ថ្នាក់ដឹកនាំតាមឋានានុក្រមរដ្ឋបាល';
    updateRoutingPreview();
  }

  if (window.lucide) lucide.createIcons();
}

// --- Electronic Signature & QR Code Management ---
let invSignatureBase64 = '';
let rtSignatureBase64 = '';
let activeSigTarget = 'inv'; // 'inv' or 'rt'
let isDrawingSig = false;
let sigCanvasInitialized = false;
let sigHasDrawn = false;

function toggleInvitationQr() {
  const checkbox = document.getElementById('invShowQr');
  const show = checkbox ? checkbox.checked : true;
  const fields = document.getElementById('invQrFieldsContainer');
  const qrCol = document.getElementById('pvInvQrCol');
  const qrBox = document.getElementById('pvInvQrBox');
  const signerCol = document.getElementById('pvInvSignerCol');

  if (fields) {
    fields.style.display = show ? 'block' : 'none';
  }
  if (qrBox) {
    qrBox.style.display = show ? 'inline-block' : 'none';
  }
  if (qrCol) {
    qrCol.style.display = show ? 'table-cell' : 'none';
  }
  if (signerCol) {
    signerCol.style.width = show ? '55%' : '100%';
  }
}

function handleSigUpload(event, type) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    applySignature(type, base64);
    showToast('បានបញ្ចូលរូបហត្ថលេខាជោគជ័យ!', 'success');
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function applySignature(type, base64) {
  if (type === 'inv') {
    invSignatureBase64 = base64;
    const thumb = document.getElementById('invSigPreviewThumb');
    const thumbImg = document.getElementById('invSigImgThumb');
    const pvImg = document.getElementById('pvInvSignatureImg');
    const removeBtn = document.getElementById('btnRemoveInvSig');

    if (thumbImg) thumbImg.src = base64;
    if (pvImg) {
      pvImg.src = base64;
      pvImg.classList.remove('hidden');
    }
    if (thumb) thumb.classList.remove('hidden');
    if (removeBtn) removeBtn.classList.remove('hidden');
  } else if (type === 'rt') {
    rtSignatureBase64 = base64;
    const thumb = document.getElementById('rtSigPreviewThumb');
    const thumbImg = document.getElementById('rtSigImgThumb');
    const pvImg = document.getElementById('pvRtAdminSignatureImg');
    const removeBtn = document.getElementById('btnRemoveRtSig');

    if (thumbImg) thumbImg.src = base64;
    if (pvImg) {
      pvImg.src = base64;
      pvImg.classList.remove('hidden');
    }
    if (thumb) thumb.classList.remove('hidden');
    if (removeBtn) removeBtn.classList.remove('hidden');
  }
}

function clearSignature(type) {
  if (type === 'inv') {
    invSignatureBase64 = '';
    const thumb = document.getElementById('invSigPreviewThumb');
    const thumbImg = document.getElementById('invSigImgThumb');
    const pvImg = document.getElementById('pvInvSignatureImg');
    const removeBtn = document.getElementById('btnRemoveInvSig');

    if (thumb) thumb.classList.add('hidden');
    if (thumbImg) thumbImg.src = '';
    if (pvImg) {
      pvImg.src = '';
      pvImg.classList.add('hidden');
    }
    if (removeBtn) removeBtn.classList.add('hidden');
    showToast('បានលុបហត្ថលេខាលិខិតអញ្ជើញ!', 'info');
  } else if (type === 'rt') {
    rtSignatureBase64 = '';
    const thumb = document.getElementById('rtSigPreviewThumb');
    const thumbImg = document.getElementById('rtSigImgThumb');
    const pvImg = document.getElementById('pvRtAdminSignatureImg');
    const removeBtn = document.getElementById('btnRemoveRtSig');

    if (thumb) thumb.classList.add('hidden');
    if (thumbImg) thumbImg.src = '';
    if (pvImg) {
      pvImg.src = '';
      pvImg.classList.add('hidden');
    }
    if (removeBtn) removeBtn.classList.add('hidden');
    showToast('បានលុបហត្ថលេខាកំណត់បង្ហាញលិខិតចូល!', 'info');
  }
}

function getCanvasCoords(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  let clientX = 0;
  let clientY = 0;

  if (evt.touches && evt.touches.length > 0) {
    clientX = evt.touches[0].clientX;
    clientY = evt.touches[0].clientY;
  } else {
    clientX = evt.clientX;
    clientY = evt.clientY;
  }

  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function initSignatureCanvas() {
  const canvas = document.getElementById('sigCanvas');
  if (!canvas || sigCanvasInitialized) return;
  sigCanvasInitialized = true;

  const ctx = canvas.getContext('2d');

  function startDraw(e) {
    e.preventDefault();
    isDrawingSig = true;
    sigHasDrawn = true;
    const { x, y } = getCanvasCoords(canvas, e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000000';
  }

  function moveDraw(e) {
    if (!isDrawingSig) return;
    e.preventDefault();
    const { x, y } = getCanvasCoords(canvas, e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function stopDraw(e) {
    if (isDrawingSig) {
      isDrawingSig = false;
      ctx.closePath();
    }
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseleave', stopDraw);

  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', stopDraw);
  canvas.addEventListener('touchcancel', stopDraw);
}

function openSignaturePadModal(target) {
  activeSigTarget = target || 'inv';
  const modal = document.getElementById('sigPadModal');
  if (modal) {
    modal.classList.remove('hidden');
    initSignatureCanvas();
    clearSigCanvas();
  }
}

function closeSignaturePadModal() {
  const modal = document.getElementById('sigPadModal');
  if (modal) modal.classList.add('hidden');
}

function clearSigCanvas() {
  const canvas = document.getElementById('sigCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sigHasDrawn = false;
}

function saveSignatureFromPad() {
  const canvas = document.getElementById('sigCanvas');
  if (!canvas || !sigHasDrawn) {
    showToast('សូមគូរហត្ថលេខាមុនពេលរក្សាទុក!', 'warning');
    return;
  }
  const dataUrl = canvas.toDataURL('image/png');
  applySignature(activeSigTarget, dataUrl);
  closeSignaturePadModal();
  showToast('បានរក្សាទុកហត្ថលេខាជោគជ័យ!', 'success');
}

function renderInvitationQR(text) {
  const container = document.getElementById('pvInvQrContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!text) text = 'https://meet.google.com/';
  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: text,
        width: 85,
        height: 85,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  } catch (e) {
    console.warn('QR render warning:', e);
  }
}

function updateInvitationPreview() {
  const ministry = document.getElementById('invMinistry')?.value || '';
  const number = document.getElementById('invNumber')?.value || '';
  const title = document.getElementById('invTitle')?.value || '';
  const invitees = document.getElementById('invInvitees')?.value || '';
  const purpose = document.getElementById('invPurpose')?.value || '';
  const chair = document.getElementById('invChair')?.value || '';
  const datetime = document.getElementById('invDateTime')?.value || '';
  const location = document.getElementById('invLocation')?.value || '';
  const dress = document.getElementById('invDress')?.value || '';
  const meetingId = document.getElementById('invMeetingId')?.value || '';
  const passcode = document.getElementById('invPasscode')?.value || '';
  const qrLink = document.getElementById('invQrLink')?.value || '';
  const contact = document.getElementById('invContact')?.value || '';
  const dateKhmer = document.getElementById('invDateKhmer')?.value || '';
  const dateSolar = document.getElementById('invDateSolar')?.value || '';
  const signerTitle = document.getElementById('invSignerTitle')?.value || '';
  const signerName = document.getElementById('invSignerName')?.value || '';

  const pvMinistry = document.getElementById('pvInvMinistry');
  if (pvMinistry) pvMinistry.innerHTML = ministry.replace(/\n/g, '<br>');

  const pvNumber = document.getElementById('pvInvNumber');
  if (pvNumber) pvNumber.textContent = number;

  const pvTitle = document.getElementById('pvInvTitle');
  if (pvTitle) pvTitle.textContent = title;

  const pvInvitees = document.getElementById('pvInvInvitees');
  if (pvInvitees) pvInvitees.innerHTML = invitees.replace(/\n/g, '<br>');

  const pvPurpose = document.getElementById('pvInvPurpose');
  if (pvPurpose) pvPurpose.innerHTML = purpose.replace(/\n/g, '<br>');

  const pvChair = document.getElementById('pvInvChair');
  if (pvChair) pvChair.textContent = chair;

  const pvDateTime = document.getElementById('pvInvDateTime');
  if (pvDateTime) pvDateTime.innerHTML = datetime.replace(/\n/g, '<br>');

  const pvLocation = document.getElementById('pvInvLocation');
  if (pvLocation) pvLocation.textContent = location;

  const pvDress = document.getElementById('pvInvDress');
  if (pvDress) pvDress.innerHTML = dress.replace(/\n/g, '<br>');

  const pvMeetingId = document.getElementById('pvInvMeetingId');
  if (pvMeetingId) pvMeetingId.textContent = meetingId;

  const pvPasscode = document.getElementById('pvInvPasscode');
  if (pvPasscode) pvPasscode.textContent = passcode;

  const pvContact = document.getElementById('pvInvContact');
  if (pvContact) pvContact.innerHTML = contact.replace(/\n/g, '<br>');

  const pvDateKhmer = document.getElementById('pvInvDateKhmer');
  if (pvDateKhmer) pvDateKhmer.textContent = dateKhmer;

  const pvDateSolar = document.getElementById('pvInvDateSolar');
  if (pvDateSolar) pvDateSolar.textContent = dateSolar;

  const pvSignerTitle = document.getElementById('pvInvSignerTitle');
  if (pvSignerTitle) pvSignerTitle.textContent = signerTitle;

  const pvSignerName = document.getElementById('pvInvSignerName');
  if (pvSignerName) pvSignerName.textContent = signerName;

  const pvInvSigImg = document.getElementById('pvInvSignatureImg');
  if (pvInvSigImg && invSignatureBase64) {
    pvInvSigImg.src = invSignatureBase64;
    pvInvSigImg.classList.remove('hidden');
  }

  toggleInvitationQr();
  if (document.getElementById('invShowQr')?.checked !== false) {
    renderInvitationQR(qrLink);
  }
}

function updateRoutingPreview() {
  const ministry = document.getElementById('rtMinistry')?.value || '';
  const number = document.getElementById('rtNumber')?.value || '';
  const institution = document.getElementById('rtInstitution')?.value || '';
  const subject = document.getElementById('rtSubject')?.value || '';
  const submissionTo = document.getElementById('rtSubmissionTo')?.value || '';
  const attachment = document.getElementById('rtAttachment')?.value || '';
  const date = document.getElementById('rtDate')?.value || '';
  const signerAdmin = document.getElementById('rtSignerAdmin')?.value || '';

  const boxDeputyDirector = document.getElementById('rtBoxDeputyDirector')?.value || '';
  const boxDeputyDept = document.getElementById('rtBoxDeputyDept')?.value || '';
  const boxDirector = document.getElementById('rtBoxDirector')?.value || '';
  const boxDeptHead = document.getElementById('rtBoxDeptHead')?.value || '';

  const pvMinistry = document.getElementById('pvRtMinistry');
  if (pvMinistry) pvMinistry.innerHTML = ministry.replace(/\n/g, '<br>');

  const pvNumber = document.getElementById('pvRtNumber');
  if (pvNumber) pvNumber.textContent = number;

  const pvInstitution = document.getElementById('pvRtInstitution');
  if (pvInstitution) pvInstitution.textContent = institution;

  const pvSubject = document.getElementById('pvRtSubject');
  if (pvSubject) pvSubject.innerHTML = subject.replace(/\n/g, '<br>');

  const pvSubmissionTo = document.getElementById('pvRtSubmissionTo');
  if (pvSubmissionTo) pvSubmissionTo.textContent = submissionTo;

  const pvAttachment = document.getElementById('pvRtAttachment');
  if (pvAttachment) pvAttachment.textContent = attachment;

  const pvDate = document.getElementById('pvRtDate');
  if (pvDate) pvDate.textContent = date;

  const pvSignerAdmin = document.getElementById('pvRtSignerAdmin');
  if (pvSignerAdmin) pvSignerAdmin.textContent = signerAdmin;

  const pvRtSigImg = document.getElementById('pvRtAdminSignatureImg');
  if (pvRtSigImg && rtSignatureBase64) {
    pvRtSigImg.src = rtSignatureBase64;
    pvRtSigImg.classList.remove('hidden');
  }

  const pvBoxDeputyDirector = document.getElementById('pvRtBoxDeputyDirector');
  if (pvBoxDeputyDirector) pvBoxDeputyDirector.innerHTML = boxDeputyDirector.replace(/\n/g, '<br>');

  const pvBoxDeputyDept = document.getElementById('pvRtBoxDeputyDept');
  if (pvBoxDeputyDept) pvBoxDeputyDept.innerHTML = boxDeputyDept.replace(/\n/g, '<br>');

  const pvBoxDirector = document.getElementById('pvRtBoxDirector');
  if (pvBoxDirector) pvBoxDirector.innerHTML = boxDirector.replace(/\n/g, '<br>');

  const pvBoxDeptHead = document.getElementById('pvRtBoxDeptHead');
  if (pvBoxDeptHead) pvBoxDeptHead.innerHTML = boxDeptHead.replace(/\n/g, '<br>');
}

function getInvitationData() {
  return {
    ministry: document.getElementById('invMinistry')?.value || '',
    number: document.getElementById('invNumber')?.value || '',
    title: document.getElementById('invTitle')?.value || 'លិខិតអញ្ជើញ',
    invitees: document.getElementById('invInvitees')?.value || '',
    purpose: document.getElementById('invPurpose')?.value || '',
    chair: document.getElementById('invChair')?.value || '',
    datetime: document.getElementById('invDateTime')?.value || '',
    location: document.getElementById('invLocation')?.value || '',
    dress: document.getElementById('invDress')?.value || '',
    meetingId: document.getElementById('invMeetingId')?.value || '',
    passcode: document.getElementById('invPasscode')?.value || '',
    qrLink: document.getElementById('invQrLink')?.value || '',
    contact: document.getElementById('invContact')?.value || '',
    dateKhmer: document.getElementById('invDateKhmer')?.value || '',
    dateSolar: document.getElementById('invDateSolar')?.value || '',
    signerTitle: document.getElementById('invSignerTitle')?.value || 'នាយកសាលា',
    signerName: document.getElementById('invSignerName')?.value || '',
    showQr: document.getElementById('invShowQr') ? document.getElementById('invShowQr').checked : true,
    signatureBase64: invSignatureBase64
  };
}

function getRoutingData() {
  return {
    ministry: document.getElementById('rtMinistry')?.value || '',
    number: document.getElementById('rtNumber')?.value || '',
    institution: document.getElementById('rtInstitution')?.value || '',
    subject: document.getElementById('rtSubject')?.value || '',
    submissionTo: document.getElementById('rtSubmissionTo')?.value || '',
    attachment: document.getElementById('rtAttachment')?.value || '',
    date: document.getElementById('rtDate')?.value || '',
    signerAdmin: document.getElementById('rtSignerAdmin')?.value || '',
    boxDeputyDirectorContent: document.getElementById('rtBoxDeputyDirector')?.value || '',
    boxDeputyDeptContent: document.getElementById('rtBoxDeputyDept')?.value || '',
    boxDirectorContent: document.getElementById('rtBoxDirector')?.value || '',
    boxDeptHeadContent: document.getElementById('rtBoxDeptHead')?.value || '',
    adminSignatureBase64: rtSignatureBase64
  };
}

async function exportWordCurrentDoc() {
  if (currentAdminDocType === 'invitation') {
    await exportWordInvitation();
  } else if (currentAdminDocType === 'routing') {
    await exportWordRouting();
  } else {
    await exportWordMinutes();
  }
}

function printCurrentDoc() {
  window.print();
}

async function sendCurrentDocToPersonalTelegram() {
  if (currentAdminDocType === 'invitation') {
    await sendInvitationTelegram();
  } else if (currentAdminDocType === 'routing') {
    await sendRoutingTelegram();
  } else {
    await sendMinutesToPersonalTelegram();
  }
}

async function exportWordInvitation() {
  const inv = getInvitationData();
  showToast('កំពុងទាញយកលិខិតអញ្ជើញជា Word (.doc)...', 'info');

  const qrCanvas = document.querySelector('#pvInvQrContainer canvas');
  if (qrCanvas && inv.showQr) {
    try {
      inv.qrBase64 = qrCanvas.toDataURL('image/png');
    } catch (e) {}
  } else {
    inv.qrBase64 = '';
  }

  try {
    const response = await fetch('/api/export/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: 'invitation', invitation: inv })
    });

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `លិខិតអញ្ជើញ_${(inv.title || 'Official').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('ទាញយកលិខិតអញ្ជើញជា Word (.doc) ជោគជ័យ!', 'success');
  } catch (err) {
    showToast('បរាជ័យក្នុងការទាញយក Word៖ ' + err.message, 'error');
  }
}

async function exportWordRouting() {
  const rt = getRoutingData();
  showToast('កំពុងទាញយកកំណត់បង្ហាញលិខិតចូលជា Word (.doc)...', 'info');

  try {
    const response = await fetch('/api/export/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: 'routing', routing: rt })
    });

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `កំណត់បង្ហាញលិខិតចូល_${(rt.subject || 'Official').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('ទាញយកកំណត់បង្ហាញលិខិតចូលជា Word (.doc) ជោគជ័យ!', 'success');
  } catch (err) {
    showToast('បរាជ័យក្នុងការទាញយក Word៖ ' + err.message, 'error');
  }
}

async function sendInvitationTelegram() {
  const inv = getInvitationData();
  const text = `✉️ លិខិតអញ្ជើញ៖ ${inv.title}\n` +
    `• ស្ថាប័ន៖ ${inv.ministry.replace(/\n/g, ' - ')}\n` +
    `• លេខ៖ ${inv.number}\n` +
    `• សូមអញ្ជើញ៖ ${inv.invitees}\n` +
    `• ដើម្បីចូលរួម៖ ${inv.purpose}\n` +
    `• ក្រោមអធិបតីភាព៖ ${inv.chair}\n` +
    `• កាលបរិច្ឆេទ៖ ${inv.datetime}\n` +
    `• ទីកន្លែង៖ ${inv.location}\n` +
    `• សម្លៀកបំពាក់៖ ${inv.dress}\n` +
    `• Meeting ID: ${inv.meetingId} | Passcode: ${inv.passcode}\n` +
    `• ទំនាក់ទំនង៖ ${inv.contact.replace(/\n/g, ' ')}\n` +
    `• ${inv.dateSolar} - ${inv.signerTitle}`;
  await openPersonalTelegram({
    title: `លិខិតអញ្ជើញ៖ ${inv.purpose.substring(0, 50)}...`,
    transcript: text
  });
}

async function sendRoutingTelegram() {
  const rt = getRoutingData();
  const text = `📑 កំណត់បង្ហាញលិខិតចូល\n` +
    `• ស្ថាប័ន៖ ${rt.ministry.replace(/\n/g, ' - ')}\n` +
    `• ក្រសួង-ស្ថាប័ន៖ ${rt.institution}\n` +
    `• កម្មវត្ថុ៖ ${rt.subject}\n` +
    `• គោរពជូន៖ ${rt.submissionTo}\n` +
    `• ឯកសារភ្ជាប់៖ ${rt.attachment}\n` +
    `• កាលបរិច្ឆេទ៖ ${rt.date}\n` +
    `• ហត្ថលេខី៖ ${rt.signerAdmin}`;
  await openPersonalTelegram({
    title: `កំណត់បង្ហាញលិខិតចូល៖ ${rt.subject.substring(0, 50)}...`,
    transcript: text
  });
}

async function aiRefineInvitation() {
  showToast('AI កំពុងកែសម្រួលលិខិតអញ្ជើញ...', 'info');
  const inv = getInvitationData();
  const transcriptToUse = currentTranscript || inv.purpose;
  if (!transcriptToUse || transcriptToUse.trim().length === 0) {
    showToast('សូមថតសម្លេង ឬសរសេរកម្មវត្ថុដើម្បីឱ្យ AI ដំណើរការ', 'warning');
    return;
  }
  try {
    const resp = await fetch('/api/refine-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcriptToUse,
        title: inv.title,
        attendees: inv.invitees,
        location: inv.location,
        ministry: inv.ministry
      })
    });
    const data = await resp.json();
    if (data.success && data.minutes) {
      const m = data.minutes;
      if (m.title) document.getElementById('invTitle').value = m.title;
      if (m.attendees) document.getElementById('invInvitees').value = m.attendees;
      if (m.content) document.getElementById('invPurpose').value = m.content;
      if (m.datetime) document.getElementById('invDateTime').value = m.datetime;
      if (m.location) document.getElementById('invLocation').value = m.location;
      if (m.signers?.chair) document.getElementById('invChair').value = m.signers.chair;
      updateInvitationPreview();
      showToast('បានកែសម្រួលលិខិតអញ្ជើញតាម AI ជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បញ្ហា AI៖ ' + err.message, 'error');
  }
}

async function aiRefineRouting() {
  showToast('AI កំពុងកែសម្រួលកំណត់បង្ហាញលិខិតចូល...', 'info');
  const rt = getRoutingData();
  const transcriptToUse = currentTranscript || rt.subject;
  if (!transcriptToUse || transcriptToUse.trim().length === 0) {
    showToast('សូមថតសម្លេង ឬសរសេរកម្មវត្ថុដើម្បីឱ្យ AI ដំណើរការ', 'warning');
    return;
  }
  try {
    const resp = await fetch('/api/refine-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcriptToUse,
        title: rt.subject,
        ministry: rt.ministry
      })
    });
    const data = await resp.json();
    if (data.success && data.minutes) {
      const m = data.minutes;
      if (m.title) document.getElementById('rtSubject').value = m.title;
      if (m.content) document.getElementById('rtBoxDeputyDept').value = m.content;
      updateRoutingPreview();
      showToast('បានកែសម្រួលកំណត់បង្ហាញលិខិតចូលតាម AI ជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បញ្ហា AI៖ ' + err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// 10. GUARANTEED OFFLINE QR CODE & CLOUDFLARE HTTPS TUNNEL SHARE
// --------------------------------------------------------------------------

let currentShareUrl = '';
let currentShareInfo = null;
let currentShareTab = 'tunnel'; // 'tunnel' or 'wifi'
let activeShareRecId = null;

async function openShareModal() {
  activeShareRecId = null;
  await refreshShareModalDisplay();
  document.getElementById('shareModal').classList.remove('hidden');
}

async function openShareForRecording(recordingId) {
  activeShareRecId = recordingId;
  await refreshShareModalDisplay();
  document.getElementById('shareModal').classList.remove('hidden');
}

async function refreshShareModalDisplay() {
  try {
    const resp = await fetch('/api/network-info');
    currentShareInfo = await resp.json();
  } catch (err) {
    currentShareInfo = {
      localIp: 'localhost',
      hostUrl: window.location.origin,
      tunnelUrl: '',
      wifiUrl: window.location.origin
    };
  }

  // Auto-switch to tunnel tab if available
  if (currentShareTab === 'tunnel' && !currentShareInfo.tunnelUrl && currentShareInfo.wifiUrl) {
    currentShareTab = 'wifi';
  } else if (currentShareInfo.tunnelUrl && currentShareTab === 'wifi' && !currentShareInfo.wifiUrl) {
    currentShareTab = 'tunnel';
  }

  let baseUrl = '';
  if (currentShareTab === 'tunnel') {
    baseUrl = currentShareInfo.tunnelUrl || currentShareInfo.hostUrl || window.location.origin;
  } else {
    baseUrl = currentShareInfo.wifiUrl || currentShareInfo.hostUrl || window.location.origin;
  }

  if (activeShareRecId) {
    currentShareUrl = `${baseUrl}/share?id=${activeShareRecId}`;
  } else {
    currentShareUrl = baseUrl;
  }

  const urlInput = document.getElementById('shareUrlInput');
  if (urlInput) urlInput.value = currentShareUrl;

  const btnTunnel = document.getElementById('tabShareTunnel');
  const btnWifi = document.getElementById('tabShareWifi');
  if (btnTunnel && btnWifi) {
    if (currentShareTab === 'tunnel') {
      btnTunnel.className = 'flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-emerald-600 text-white shadow transition flex items-center justify-center gap-1.5';
      btnWifi.className = 'flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 hover:text-white transition flex items-center justify-center gap-1.5';
    } else {
      btnWifi.className = 'flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-emerald-600 text-white shadow transition flex items-center justify-center gap-1.5';
      btnTunnel.className = 'flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 hover:text-white transition flex items-center justify-center gap-1.5';
    }
  }

  renderQRCode(currentShareUrl);
}

function switchShareType(type) {
  currentShareTab = type;
  refreshShareModalDisplay();
}

function openCurrentShareUrl() {
  if (currentShareUrl) {
    window.open(currentShareUrl, '_blank');
  }
}

function renderQRCode(text) {
  const container = document.getElementById('qrCodeContainer');
  if (!container) return;

  container.innerHTML = '';

  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: text,
        width: 180,
        height: 180,
        colorDark: '#020617',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      throw new Error('Local QRCode engine not loaded');
    }
  } catch (err) {
    console.warn('QRCode fallback triggered:', err);
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(text)}`;
    img.alt = 'QR Code';
    img.className = 'w-[180px] h-[180px] rounded-lg shadow';
    container.appendChild(img);
  }
}

function copyShareUrl() {
  const input = document.getElementById('shareUrlInput');
  input.select();
  navigator.clipboard.writeText(input.value);
  showToast('បានចម្លងតំណភ្ជាប់ (Share Link) រួចរាល់!', 'success');
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

// --------------------------------------------------------------------------
// 11. APP CONFIGURATION (SETTINGS)
// --------------------------------------------------------------------------

async function loadConfig() {
  try {
    const resp = await fetch('/api/config');
    appConfig = await resp.json();

    if (appConfig.personalTelegramUsername) {
      document.getElementById('cfgPersonalUsername').value = appConfig.personalTelegramUsername;
    }
    if (appConfig.telegramBotToken) {
      document.getElementById('cfgTelegramToken').value = appConfig.telegramBotToken;
    }
    if (appConfig.telegramChatId) {
      document.getElementById('cfgTelegramChatId').value = appConfig.telegramChatId;
    }
    if (appConfig.geminiApiKey) {
      document.getElementById('cfgGeminiKey').value = appConfig.geminiApiKey;
    }
  } catch (err) {
    console.error('Config load error:', err);
  }
}

async function saveAppSettings() {
  const personalUsername = document.getElementById('cfgPersonalUsername').value.trim();
  const token = document.getElementById('cfgTelegramToken').value.trim();
  const chatId = document.getElementById('cfgTelegramChatId').value.trim();
  const gemini = document.getElementById('cfgGeminiKey').value.trim();

  const payload = {
    personalTelegramUsername: personalUsername,
    telegramBotToken: token,
    telegramChatId: chatId,
    geminiApiKey: gemini
  };

  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (data.success) {
      appConfig = { ...appConfig, ...payload };
      showToast('បានរក្សាទុកការកំណត់ជោគជ័យ!', 'success');
    }
  } catch (err) {
    showToast('បរាជ័យក្នុងការរក្សាទុក៖ ' + err.message, 'error');
  }
}

async function testGeminiConnection() {
  const keyInput = document.getElementById('cfgGeminiKey');
  const apiKey = keyInput ? keyInput.value.trim() : (appConfig.geminiApiKey || '');

  if (!apiKey) {
    showToast('សូមបញ្ចូល Google Gemini API Key ក្នុងប្រអប់ខាងលើជាមុនសិន', 'error');
    if (keyInput) keyInput.focus();
    return;
  }

  showToast('កំពុងសាកល្បងតភ្ជាប់ Google Gemini AI...', 'info');
  try {
    const resp = await fetch('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(data.message || '🎉 តភ្ជាប់ជាមួយ Gemini AI ជោគជ័យ!', 'success');
    } else {
      showToast(data.error || 'Gemini Key មិនត្រឹមត្រូវ', 'error');
    }
  } catch (err) {
    showToast('មិនអាចតភ្ជាប់ Gemini AI៖ ' + err.message, 'error');
  }
}

async function testBotTelegramConnection() {
  const token = document.getElementById('cfgTelegramToken')?.value.trim();
  const chatId = document.getElementById('cfgTelegramChatId')?.value.trim();

  if (!token || !chatId) {
    showToast('សូមបញ្ចូល Bot Token និង Chat ID ជាមុនសិន', 'error');
    return;
  }

  showToast('កំពុងផ្ញើសារសាកល្បងទៅ Telegram Bot...', 'info');
  try {
    const resp = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    const data = await resp.json();
    if (data.success) {
      showToast('🎉 បានផ្ញើសារទៅ Telegram Bot ជោគជ័យ!', 'success');
    } else {
      showToast(data.error || 'Telegram Bot Error', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function deleteRecording(id) {
  if (!confirm('តើអ្នកពិតជាចង់លុបទិន្នន័យនេះចេញពីបញ្ជីមែនទេ?')) return;
  try {
    await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
    showToast('បានលុបទិន្នន័យចេញពីបញ្ជី', 'info');
    await loadRecordings();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  
  const bgColors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    info: 'bg-slate-800 text-slate-100 border border-slate-700'
  };

  toast.className = `${bgColors[type] || bgColors.info} px-4 py-2.5 rounded-xl shadow-xl text-xs font-medium flex items-center gap-2 transform transition-all duration-300 translate-x-10 opacity-0 pointer-events-auto`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-x-10', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('translate-x-10', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
