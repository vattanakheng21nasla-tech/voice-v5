/**
 * Voice-V5 Pro Server
 * A high-performance, zero-dependency Node.js server for:
 * 1. High-fidelity Opus audio recording & Speech-to-Text
 * 2. Real-time Live Translation
 * 3. File drag-and-drop, interactive player, & local network sharing
 * 4. Automatic & instant Telegram Bot dispatch
 * 5. Cambodian Administrative Minutes (កំណត់ហេតុ) Generation (Ministry of Interior format)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
let actualPort = DEFAULT_PORT;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Initialize data files if not present
if (!fs.existsSync(RECORDINGS_FILE)) {
  fs.writeFileSync(RECORDINGS_FILE, JSON.stringify([], null, 2), 'utf8');
}
if (!fs.existsSync(CONFIG_FILE)) {
  const defaultConfig = {
    telegramBotToken: '',
    telegramChatId: '',
    autoSendTelegram: false,
    geminiApiKey: '',
    defaultLanguage: 'km-KH',
    targetLanguage: 'en'
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
}

// Helpers & Dual-Storage Google Drive Cloud Backup
const GDRIVE_BACKUP_DIR = 'H:\\My Drive\\Voice-V5';

function backupFileToGDrive(subDir, filename, contentOrPath) {
  try {
    if (fs.existsSync(GDRIVE_BACKUP_DIR)) {
      const targetDir = path.join(GDRIVE_BACKUP_DIR, subDir);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const destPath = path.join(targetDir, filename);
      if (typeof contentOrPath === 'string' && fs.existsSync(contentOrPath)) {
        fs.copyFileSync(contentOrPath, destPath);
      } else {
        fs.writeFileSync(destPath, contentOrPath);
      }
    }
  } catch (e) {
    // Non-blocking background backup
  }
}

function getRecordings() {
  try {
    const raw = fs.readFileSync(RECORDINGS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch (err) {
    console.error('Error reading recordings:', err);
    return [];
  }
}

function saveRecordings(list) {
  fs.writeFileSync(RECORDINGS_FILE, JSON.stringify(list, null, 2), 'utf8');
  backupFileToGDrive('data', 'recordings.json', JSON.stringify(list, null, 2));
}

function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch (err) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  backupFileToGDrive('data', 'config.json', JSON.stringify(cfg, null, 2));
}

function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// Cloudflare Tunnel Management
let cloudflareProcess = null;
let cloudflareTunnelUrl = '';

function startCloudflareTunnel(portToTunnel) {
  const targetPort = portToTunnel || actualPort || 3000;
  const exePath = path.join(__dirname, 'cloudflared.exe');
  if (!fs.existsSync(exePath)) {
    console.log('ℹ️ cloudflared.exe មិនមានក្នុងថតគម្រោងទេ។ Cloudflare tunnel ត្រូវបានរំលង។');
    return;
  }

  console.log(`🌐 កំពុងបើកដំណើរការ Cloudflare HTTPS Tunnel សម្រាប់ port ${targetPort}...`);
  try {
    cloudflareProcess = spawn(exePath, ['tunnel', '--url', `http://localhost:${targetPort}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i);
      if (match && !cloudflareTunnelUrl) {
        cloudflareTunnelUrl = match[0];
        console.log(`=======================================================`);
        console.log(`🌐 Cloudflare HTTPS Tunnel ដំណើរការជោគជ័យ!`);
        console.log(`👉 Link សាធារណៈ (HTTPS): ${cloudflareTunnelUrl}`);
        console.log(`📱 អាចប្រើនៅលើទូរស័ព្ទដៃ (iOS & Android) ដើម្បីថតសម្លេងដោយមានសិទ្ធិ Mic!`);
        console.log(`=======================================================`);

        try {
          fs.writeFileSync(path.join(DATA_DIR, 'active_url.txt'), `http://localhost:${targetPort}\n${cloudflareTunnelUrl}`, 'utf8');
        } catch (e) {}
      }
    };

    cloudflareProcess.stdout.on('data', onData);
    cloudflareProcess.stderr.on('data', onData);

    cloudflareProcess.on('exit', (code) => {
      console.log(`ℹ️ Cloudflare tunnel បានបិទ (code ${code})`);
      cloudflareProcess = null;
      cloudflareTunnelUrl = '';
    });

    cloudflareProcess.on('error', (err) => {
      console.warn('⚠️ Cloudflare process error:', err.message);
    });
  } catch (err) {
    console.warn('⚠️ មិនអាចបើកដំណើរការ Cloudflare tunnel បានទេ:', err.message);
  }
}

function stopCloudflareTunnel() {
  if (cloudflareProcess) {
    try {
      cloudflareProcess.kill();
    } catch (e) {}
    cloudflareProcess = null;
    cloudflareTunnelUrl = '';
  }
}

// Graceful cleanup on process exit
['SIGINT', 'SIGTERM', 'exit'].forEach(sig => {
  process.on(sig, stopCloudflareTunnel);
});

// Send JSON response
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-file-title, x-file-duration, x-original-name, x-mime-type, x-transcript, x-translation'
  });
  res.end(JSON.stringify(data));
}

// Read body stream as Buffer
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Read body as JSON
async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf || buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return {};
  }
}

// MIME types table
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8'
};

// Handle Static Files (with HTTP Range request support for audio seeking)
function serveStaticFile(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return serveStaticFile(req, res, path.join(filePath, 'index.html'));
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const chunksize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// Translate via Google Translate Web API
async function translateText(text, sl = 'km', tl = 'en') {
  if (!text || !text.trim()) return '';
  const apiUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      throw new Error(`Translation API error: ${resp.status}`);
    }
    const data = await resp.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map(item => item[0]).join('');
    }
    return '';
  } catch (err) {
    console.error('Translation error:', err);
    return text;
  }
}

// Telegram Service: send text or media
async function sendToTelegram({ token, chatId, text, audioFilePath, docFilePath, docName }) {
  if (!token || !chatId) {
    throw new Error('Telegram Bot Token ឬ Chat ID មិនទាន់បានកំណត់');
  }

  const results = {};

  // 1. Send Audio File if provided
  if (audioFilePath && fs.existsSync(audioFilePath)) {
    const fileStat = fs.statSync(audioFilePath);
    if (fileStat.size > 0) {
      try {
        const fileBuffer = fs.readFileSync(audioFilePath);
        const fileName = path.basename(audioFilePath);
        const mimeType = MIME_TYPES[path.extname(audioFilePath).toLowerCase()] || 'audio/webm';
        const blob = new Blob([fileBuffer], { type: mimeType });

        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('audio', blob, fileName);
        if (text) {
          const shortCaption = text.length > 900 ? text.substring(0, 900) + '...' : text;
          formData.append('caption', shortCaption);
        }

        const audioResp = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
          method: 'POST',
          body: formData
        });
        const audioJson = await audioResp.json();
        results.audio = audioJson;
      } catch (err) {
        console.error('Telegram Audio Upload failed, trying voice or fallback:', err);
        results.audioError = err.message;
      }
    }
  }

  // 2. Send Document if provided
  if (docFilePath && fs.existsSync(docFilePath)) {
    try {
      const docBuffer = fs.readFileSync(docFilePath);
      const fileName = docName || path.basename(docFilePath);
      const mimeType = MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
      const blob = new Blob([docBuffer], { type: mimeType });

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', blob, fileName);
      formData.append('caption', '📄 កំណត់ហេតុរដ្ឋបាល (Minutes of Meeting)');

      const docResp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });
      results.document = await docResp.json();
    } catch (err) {
      results.docError = err.message;
    }
  }

  // 3. Send Message Text if not already sent with audio or if text is long
  if (text && (!audioFilePath || text.length > 900)) {
    try {
      const msgResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'HTML'
        })
      });
      results.message = await msgResp.json();
    } catch (err) {
      results.messageError = err.message;
    }
  }

  return results;
}

// Built-in intelligent Khmer Linguistic & Phonetic Correction Engine
function cleanKhmerTranscriptOffline(rawText) {
  if (!rawText) return '';
  let cleaned = String(rawText);

  // 1. Spoken speech patterns & introductory redundancies
  cleaned = cleaned.replace(/បានជាបឋមខ្ញុំបានសូម/g, 'ជាបឋម ខ្ញុំសូម');
  cleaned = cleaned.replace(/បានជាបឋម/g, 'ជាបឋម');
  cleaned = cleaned.replace(/ខ្ញុំបានសូមធ្វើការគោរពដល់/g, 'ខ្ញុំសូមគោរពដល់');
  cleaned = cleaned.replace(/ខ្ញុំបានសូមធ្វើការគោរព/g, 'ខ្ញុំសូមគោរព');
  cleaned = cleaned.replace(/ខ្ញុំបានសូមគោរពដល់/g, 'ខ្ញុំសូមគោរពដល់');
  cleaned = cleaned.replace(/ខ្ញុំបានសូមគោរព/g, 'ខ្ញុំសូមគោរព');
  cleaned = cleaned.replace(/ខ្ញុំបានសូម/g, 'ខ្ញុំសូម');
  cleaned = cleaned.replace(/ខ្ញុំបានធ្វើការសូម/g, 'ខ្ញុំសូម');
  cleaned = cleaned.replace(/សូមធ្វើការគោរពដល់/g, 'សូមគោរពដល់');
  cleaned = cleaned.replace(/សូមធ្វើការគោរព/g, 'សូមគោរព');
  cleaned = cleaned.replace(/និងសូមធ្វើការ/g, 'និងសូមគោរព');
  cleaned = cleaned.replace(/សូមធ្វើការ/g, 'សូម');
  cleaned = cleaned.replace(/ខ្ញុំបានស្នើសុំ/g, 'ខ្ញុំស្នើសុំ');

  // 2. Administrative Titles & Honorifics
  cleaned = cleaned.replace(/ទ្រង់ឯកឧត្តម/g, 'ឯកឧត្តម');
  cleaned = cleaned.replace(/លោកលោកស្រី/g, 'លោក លោកស្រី');
  cleaned = cleaned.replace(/លោករស្រី/g, 'លោកស្រី');
  cleaned = cleaned.replace(/ឯកឧត្តមលោកជំទាវ/g, 'ឯកឧត្តម លោកជំទាវ');
  cleaned = cleaned.replace(/លោកជំទាវលោក/g, 'លោកជំទាវ លោក');
  cleaned = cleaned.replace(/លោក។\s*នាយកដ្ឋាន/g, 'លោកប្រធាននាយកដ្ឋាន');
  cleaned = cleaned.replace(/លោក។\s*/g, 'លោក ');
  cleaned = cleaned.replace(/លោក\s*។\s*/g, 'លោក ');
  cleaned = cleaned.replace(/លោកស្រី\s*។\s*/g, 'លោកស្រី ');
  cleaned = cleaned.replace(/ប្រធាននាយកដ្ឋាន\s*។\s*/g, 'ប្រធាននាយកដ្ឋាន ');
  cleaned = cleaned.replace(/ឯកឧត្តម\s*។\s*/g, 'ឯកឧត្តម ');

  // 3. Spacing for common names / roles
  cleaned = cleaned.replace(/លោកស្រីម៉ៅ/g, 'លោកស្រី ម៉ៅ');
  cleaned = cleaned.replace(/លោកសុខ/g, 'លោក សុខ');
  cleaned = cleaned.replace(/លោកអែន/g, 'លោក អែន');
  cleaned = cleaned.replace(/លោកស្រីច្រេច/g, 'លោកស្រី ច្រេច');
  cleaned = cleaned.replace(/លោកម៉ៅ/g, 'លោក ម៉ៅ');
  cleaned = cleaned.replace(/លោកចាន់/g, 'លោក ចាន់');

  // 4. Stutter repeats
  cleaned = cleaned.replace(/សួរសួ/g, 'សួរ');
  cleaned = cleaned.replace(/បាទបាទ/g, 'បាទ');
  cleaned = cleaned.replace(/ចាសចាស/g, 'ចាស');
  cleaned = cleaned.replace(/សួរសួរ/g, 'សួរ');
  cleaned = cleaned.replace(/សូមសូម/g, 'សូម');

  // 5. English hallucinations / phonetic noise from Web Speech
  cleaned = cleaned.replace(/\b[a-zA-Z]+\b/g, '');

  // 6. Misplaced punctuation before conjunctions & spacing
  cleaned = cleaned.replace(/។\s*(និង|ហើយ|ប៉ុន្តែ|ព្រមទាំង|ឬ|ដើម្បី)/g, ' $1');
  cleaned = cleaned.replace(/[ \t]+/g, ' ').trim();
  if (cleaned && !cleaned.endsWith('។') && !cleaned.endsWith('!') && !cleaned.endsWith('?')) {
    cleaned += '។';
  }

  return cleaned;
}

// Reliable Gemini API caller with automatic model fallback
async function callGeminiApi(apiKey, method, payload) {
  const models = ['gemini-3.5-flash', 'gemini-flash-latest'];
  let lastError = null;
  for (const m of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:${method}?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        return await resp.json();
      }
      const errJson = await resp.json().catch(() => null);
      lastError = errJson?.error?.message || `HTTP ${resp.status}`;
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(lastError || 'Gemini API call failed');
}

// Rule-based Cambodian Administrative Minutes Generator (Ministry of Interior Standard)
function generateKhmerMinutes({ title, date, location, attendees, agenda, content, decisions, signers, ministry, customSections, customTables }) {
  const today = new Date();
  const day = today.getDate();
  const khmerMonths = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
  const monthName = khmerMonths[today.getMonth()];
  const year = today.getFullYear();

  const formattedDate = date || `ថ្ងៃទី${day} ខែ${monthName} ឆ្នាំ${year}`;
  const formattedMinistry = ministry || 'ក្រសួងមហាផ្ទៃ\nអគ្គនាយកដ្ឋានរដ្ឋបាល';
  const formattedTitle = title || 'កិច្ចប្រជុំពិភាក្សាការងារទូទៅ';
  const formattedLocation = location || 'សាលប្រជុំទីស្តីការក្រសួង';
  const formattedAttendees = attendees || 'ឯកឧត្តម លោកជំទាវ លោក លោកស្រី ប្រធាន អនុប្រធាននាយកដ្ឋាន និងមន្ត្រីជំនាញពាក់ព័ន្ធ';
  const formattedAgenda = agenda || '១. ត្រួតពិនិត្យវឌ្ឍនភាពការងារ\n២. លើកទិសដៅ និងដំណោះស្រាយបញ្ហាប្រឈម';
  const formattedContent = content || 'ប្រធានអង្គប្រជុំបានបើកកិច្ចប្រជុំ និងផ្តល់ឱកាសឱ្យសមាជិកទាំងអស់ចូលរួមផ្តល់យោបល់យ៉ាងផុលផុសលើរបៀបវារៈនីមួយៗ។';
  const formattedDecisions = decisions || 'អង្គប្រជុំបានឯកភាពទាំងស្រុងលើរបាយការណ៍ និងទិសដៅការងារដែលបានដាក់ចេញ។';
  const recorderName = (signers && signers.recorder) || 'អ្នកធ្វើកំណត់ហេតុ';
  const chairName = (signers && signers.chair) || 'ប្រធានអង្គប្រជុំ';

  return {
    ministry: formattedMinistry,
    kingdomHeader: 'ព្រះរាជាណាចក្រកម្ពុជា\nជាតិ សាសនា ព្រះមហាក្សត្រ',
    type: 'កំណត់ហេតុ',
    title: formattedTitle,
    datetime: formattedDate,
    location: formattedLocation,
    attendees: formattedAttendees,
    agenda: formattedAgenda,
    content: formattedContent,
    decisions: formattedDecisions,
    customSections: Array.isArray(customSections) ? customSections : [],
    customTables: Array.isArray(customTables) ? customTables : [],
    signers: {
      recorder: recorderName,
      chair: chairName
    },
    closingNote: 'អង្គប្រជុំត្រូវបានបិទបញ្ចប់នៅវេលាម៉ោង ... នាទី ថ្ងៃខែឆ្នាំដដែល ប្រកបដោយបរិយាកាសរីករាយ និងស្និទ្ធស្នាលជាទីបំផុត។'
  };
}

// Generate Word-Compatible HTML (.doc) that opens directly in Microsoft Word with official styling
function generateWordDoc(minutes) {
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" 
      xmlns:w="urn:schemas-microsoft-com:office:word" 
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${minutes.title}</title>
<!--[if gte mso 9]>
<xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page {
    size: A4 portrait;
    margin: 2.0cm 1.5cm 1.5cm 3.0cm;
  }
  body {
    font-family: "Khmer OS Siemreap", "Kantumruy Pro", "Khmer OS", Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.6;
    color: #000;
  }
  .muol {
    font-family: "Khmer OS Muol Light", "Khmer OS Muol", Arial, sans-serif;
    font-weight: bold;
  }
  .header-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 25px;
  }
  .header-table td {
    vertical-align: top;
    padding: 0;
  }
  .kingdom-title {
    font-size: 14pt;
    text-align: center;
  }
  .motto {
    font-size: 13pt;
    text-align: center;
    letter-spacing: 1px;
  }
  .divider {
    text-align: center;
    font-size: 14pt;
    margin-top: -5px;
  }
  .ministry-title {
    font-size: 12pt;
    line-height: 1.4;
  }
  .main-title {
    text-align: center;
    font-size: 16pt;
    margin-top: 15px;
    margin-bottom: 5px;
  }
  .sub-title {
    text-align: center;
    font-size: 13pt;
    margin-bottom: 25px;
  }
  .section-title {
    font-size: 12pt;
    margin-top: 15px;
    margin-bottom: 5px;
  }
  .content-block {
    text-indent: 1.5cm;
    text-align: justify;
    margin-bottom: 12px;
  }
  .sign-table {
    width: 100%;
    margin-top: 40px;
    border-collapse: collapse;
  }
  .sign-table td {
    width: 50%;
    text-align: center;
    vertical-align: top;
  }
</style>
</head>
<body>

<table class="header-table">
  <tr>
    <td style="width: 50%;">
      <div class="muol ministry-title">${minutes.ministry.replace(/\n/g, '<br>')}</div>
      <div>លេខ៖ .................... / ...........</div>
    </td>
    <td style="width: 50%;">
      <div class="muol kingdom-title">ព្រះរាជាណាចក្រកម្ពុជា</div>
      <div class="muol motto">ជាតិ សាសនា ព្រះមហាក្សត្រ</div>
      <div class="divider">~~~ 🙡 🙣 ~~~</div>
    </td>
  </tr>
</table>

<div class="muol main-title">កំណត់ហេតុ</div>
<div class="muol sub-title">ស្តីពី<br>${minutes.title}</div>

<div class="content-block">
  នៅ${minutes.datetime} វេលាម៉ោង ........... នៅ${minutes.location} បានរៀបចំកិច្ចប្រជុំស្តីពី «${minutes.title}» ក្រោមអធិបតីភាពដ៏ខ្ពង់ខ្ពស់របស់ ${minutes.signers.chair}។
</div>

<div class="muol section-title">I. សមាសភាពចូលរួម៖</div>
<div class="content-block">
  ${minutes.attendees.replace(/\n/g, '<br>')}
</div>

<div class="muol section-title">II. របៀបវារៈនៃអង្គប្រជុំ៖</div>
<div class="content-block">
  ${minutes.agenda.replace(/\n/g, '<br>')}
</div>

<div class="muol section-title">III. ដំណើរការនៃអង្គប្រជុំ និងការពិភាក្សា៖</div>
<div class="content-block">
  ${minutes.content.replace(/\n/g, '<br><br>')}
</div>

<div class="muol section-title">IV. សេចក្តីសម្រេច និងទិសដៅបន្ត៖</div>
<div class="content-block">
  ${(minutes.decisions || '').replace(/\n/g, '<br>')}
</div>

<!-- Dynamic Custom Sections (ជំពូកបន្ថែម V, VI...) -->
${(minutes.customSections || []).map(sec => `
<div class="muol section-title">${sec.title || ''}៖</div>
<div class="content-block">
  ${(sec.content || '').replace(/\n/g, '<br>')}
</div>
`).join('')}

<!-- Dynamic Custom Tables (តារាង & ជួរឈរ Columns) -->
${(minutes.customTables || []).map(tbl => `
${tbl.title ? `<div class="muol section-title" style="margin-top: 18px; margin-bottom: 8px; text-align: center;">${tbl.title}</div>` : ''}
<table style="width: 100%; border-collapse: collapse; margin-top: 8px; margin-bottom: 16px; font-size: 11pt;" border="1" cellpadding="6">
  <thead>
    <tr style="background-color: #f1f5f9; text-align: center; font-weight: bold;">
      ${(tbl.columns || []).map(c => `<th style="border: 1px solid #000; padding: 6px 8px; text-align: center;">${c}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${(tbl.rows || []).map(row => `
      <tr>
        ${row.map(cell => `<td style="border: 1px solid #000; padding: 6px 8px; vertical-align: top;">${(cell || '').replace(/\n/g, '<br>')}</td>`).join('')}
      </tr>
    `).join('')}
  </tbody>
</table>
`).join('')}

<div class="content-block" style="margin-top: 20px;">
  ${minutes.closingNote}
</div>

<table class="sign-table">
  <tr>
    <td>
      <div class="muol">អ្នកធ្វើកំណត់ហេតុ</div>
      ${minutes.recorderSignatureBase64 ? `<div style="text-align: center; margin: 8px 0;"><img src="${minutes.recorderSignatureBase64}" style="max-height: 70px; max-width: 170px;" alt="Signature" /></div>` : '<div style="height: 70px;"></div>'}
      <div class="muol">${minutes.signers.recorder}</div>
    </td>
    <td>
      <div>${minutes.datetime}</div>
      <div class="muol">ប្រធានអង្គប្រជុំ</div>
      ${minutes.chairSignatureBase64 ? `<div style="text-align: center; margin: 8px 0;"><img src="${minutes.chairSignatureBase64}" style="max-height: 70px; max-width: 170px;" alt="Signature" /></div>` : '<div style="height: 70px;"></div>'}
      <div class="muol">${minutes.signers.chair}</div>
    </td>
  </tr>
</table>

</body>
</html>`;
}

function escapeDocHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// Generate Word (.doc) for Invitation Letter (លិខិតអញ្ជើញ)
function generateWordDocInvitation(inv) {
  const ministry = escapeDocHtml(inv.ministry || 'ក្រសួងមហាផ្ទៃ\nសាលាជាតិរដ្ឋបាលមូលដ្ឋាន');
  const number = escapeDocHtml(inv.number || 'លេខ៖ .................. / .........');
  const title = escapeDocHtml(inv.title || 'លិខិតអញ្ជើញ');
  const invitees = escapeDocHtml(inv.invitees || '- លោក លោកស្រីនាយករងសាលាជាតិរដ្ឋបាលមូលដ្ឋាន\n- លោក លោកស្រីប្រធាននាយកដ្ឋាន អនុប្រធាននាយកដ្ឋាន ប្រធានការិយាល័យ ចំណុះសាលាជាតិរដ្ឋបាលមូលដ្ឋាន');
  const purpose = escapeDocHtml(inv.purpose || 'កិច្ចប្រជុំពិនិត្យវឌ្ឍនភាពការងារប្រចាំខែតុលា និងទិសដៅការងារខែវិច្ឆិកា ឆ្នាំ២០២៦ របស់សាលាជាតិរដ្ឋបាលមូលដ្ឋាន ក្រសួងមហាផ្ទៃ');
  const chair = escapeDocHtml(inv.chair || 'ឯកឧត្តម សូ មុនីរក្សា នាយកសាលាជាតិរដ្ឋបាលមូលដ្ឋាន ក្រសួងមហាផ្ទៃ');
  const datetime = escapeDocHtml(inv.datetime || 'ថ្ងៃព្រហស្បតិ៍ ១០រោច ខែអស្សុជ ឆ្នាំមមី អដ្ឋស័ក ព.ស.២៥៧០ ត្រូវនឹងថ្ងៃទី៥ ខែវិច្ឆិកា ឆ្នាំ២០២៦ វេលាម៉ោង១៤:០០នាទីរសៀល');
  const location = escapeDocHtml(inv.location || 'សាលាជាតិរដ្ឋបាលមូលដ្ឋាន ស្ថិតនៅសង្កាត់គោករកា ខណ្ឌព្រែកព្នៅ រាជធានីភ្នំពេញ');
  const dress = escapeDocHtml(inv.dress || '- ថ្នាក់ដឹកនាំ : បុរស(អាវធំ) ស្ត្រី(ប្រពៃណី ឬសមរម្យ)\n- អនុប្រធាននាយកដ្ឋាន និងប្រធានការិយាល័យ (សមរម្យ)៕');
  const meetingId = escapeDocHtml(inv.meetingId || '856 3990 5098');
  const passcode = escapeDocHtml(inv.passcode || '123456');
  const contact = escapeDocHtml(inv.contact || 'លោក ហេង វឌ្ឍនៈ\n០១០ ៨០៨ ១៨៨\n០៧៦ ២៧៧ ៨៨៩៨');
  const dateKhmer = escapeDocHtml(inv.dateKhmer || 'ថ្ងៃ                           ខែប             ឆ្នាំមមី អដ្ឋស័ក ព.ស.២៥៧០');
  const dateSolar = escapeDocHtml(inv.dateSolar || 'រាជធានីភ្នំពេញ ថ្ងៃទី               ខែ                 ឆ្នាំ២០២៦');
  const signerTitle = escapeDocHtml(inv.signerTitle || 'នាយកសាលា');
  const signerName = escapeDocHtml(inv.signerName || '');
  const showQr = inv.showQr !== false && inv.showQr !== 'false';
  const qrImageTag = (showQr && inv.qrBase64) ? `<img src="${inv.qrBase64}" width="105" height="105" style="display:block;margin:0 auto 6px auto;" alt="QR Code" />` : '';
  const signatureBase64 = inv.signatureBase64 || '';
  const signatureTag = signatureBase64 ? 
    `<div style="text-align: center; margin: 6px 0;"><img src="${signatureBase64}" style="max-height: 70px; max-width: 180px;" alt="Signature" /></div>` :
    `<div style="height: 70px;"></div>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" 
      xmlns:w="urn:schemas-microsoft-com:office:word" 
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${title}</title>
<!--[if gte mso 9]>
<xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page {
    size: A4 portrait;
    margin: 2.0cm 1.5cm 1.5cm 3.0cm;
  }
  body {
    font-family: "Khmer OS Siemreap", "Kantumruy Pro", "Khmer OS", Arial, sans-serif;
    font-size: 11.5pt;
    line-height: 1.6;
    color: #000;
  }
  .muol {
    font-family: "Khmer OS Muol Light", "Khmer OS Muol", Arial, sans-serif;
    font-weight: bold;
  }
  .header-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }
  .header-table td {
    vertical-align: top;
    padding: 0;
  }
  .kingdom-title {
    font-size: 13.5pt;
    text-align: center;
  }
  .motto {
    font-size: 12.5pt;
    text-align: center;
    letter-spacing: 0.5px;
  }
  .divider {
    text-align: center;
    font-size: 13pt;
    margin-top: -4px;
  }
  .main-title {
    text-align: center;
    font-size: 17pt;
    margin-top: 15px;
    margin-bottom: 25px;
    letter-spacing: 1px;
  }
  .item-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  .item-table td {
    vertical-align: top;
    padding: 4px 0;
  }
  .item-label {
    width: 135px;
    font-family: "Khmer OS Muol Light", "Khmer OS Muol", Arial, sans-serif;
    white-space: nowrap;
    padding-right: 8px;
  }
  .item-value {
    text-align: justify;
  }
  .bottom-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 25px;
  }
  .bottom-table td {
    vertical-align: top;
    padding: 0;
  }
  .online-box {
    width: 200px;
    border: 1.5pt solid #000;
    padding: 8px 12px;
    text-align: center;
    font-size: 10pt;
    line-height: 1.45;
  }
</style>
</head>
<body>
  <table class="header-table">
    <tr>
      <td style="width: 45%; text-align: left;">
        <div class="muol" style="font-size: 12pt; line-height: 1.4;">${ministry}</div>
        <div style="font-size: 11pt; margin-top: 4px;">${number}</div>
      </td>
      <td style="width: 55%; text-align: center;">
        <div class="muol kingdom-title">ព្រះរាជាណាចក្រកម្ពុជា</div>
        <div class="muol motto">ជាតិ សាសនា ព្រះមហាក្សត្រ</div>
        <div class="divider">~~~ 🙡 🙣 ~~~</div>
      </td>
    </tr>
  </table>

  <div class="muol main-title">${title}</div>

  <table class="item-table">
    <tr>
      <td class="item-label">សូមអញ្ជើញ៖</td>
      <td class="item-value">${invitees}</td>
    </tr>
  </table>

  <table class="item-table">
    <tr>
      <td class="item-label">ដើម្បីចូលរួម៖</td>
      <td class="item-value">${purpose}</td>
    </tr>
  </table>

  <table class="item-table">
    <tr>
      <td class="item-label">ក្រោមអធិបតីភាព៖</td>
      <td class="item-value">${chair}</td>
    </tr>
  </table>

  <table class="item-table">
    <tr>
      <td class="item-label">កាលបរិច្ឆេទ៖</td>
      <td class="item-value">${datetime}</td>
    </tr>
  </table>

  <table class="item-table">
    <tr>
      <td class="item-label">ទីកន្លែង៖</td>
      <td class="item-value">${location}</td>
    </tr>
  </table>

  <table class="item-table">
    <tr>
      <td class="item-label">សម្លៀកបំពាក់៖</td>
      <td class="item-value">${dress}</td>
    </tr>
  </table>

  <table class="bottom-table">
    <tr>
      ${showQr ? `
      <td style="width: 45%; text-align: left;">
        <div class="online-box">
          ${qrImageTag}
          <div style="font-weight: bold; margin-top: 4px;">Meeting ID ${meetingId}</div>
          <div style="font-weight: bold;">Passcode ${passcode}</div>
          <div style="margin-top: 6px; font-weight: bold;">សូមទំនាក់ទំនង</div>
          <div>${contact}</div>
        </div>
      </td>` : `<td style="width: 45%;"></td>`}
      <td style="width: 55%; text-align: center;">
        <div style="font-size: 11pt;">${dateKhmer}</div>
        <div style="font-size: 11pt; margin-top: 2px;">${dateSolar}</div>
        <div class="muol" style="font-size: 12pt; margin-top: 8px;">${signerTitle}</div>
        ${signatureTag}
        <div class="muol" style="font-size: 12pt;">${signerName}</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Generate Word (.doc) for Incoming Document Routing Slip (កំណត់បង្ហាញលិខិតចូល)
function generateWordDocRouting(rt) {
  const ministry = escapeDocHtml(rt.ministry || 'ក្រសួងមហាផ្ទៃ\nសាលាជាតិរដ្ឋបាលមូលដ្ឋាន\nនាយកដ្ឋានកិច្ចការទូទៅ');
  const number = escapeDocHtml(rt.number || 'លេខ៖ ............ / ........');
  const institution = escapeDocHtml(rt.institution || 'ក្រសួងមហាផ្ទៃ');
  const subject = escapeDocHtml(rt.subject || 'ស្នើសុំការពិនិត្យ និងសម្រេចលើរបាយការណ៍');
  const submissionTo = escapeDocHtml(rt.submissionTo || 'សូមគោរពជូន លោកស្រីប្រធាននាយកដ្ឋាន');
  const attachment = escapeDocHtml(rt.attachment || '(សូមគោរពជូនភ្ជាប់នូវឯកសារពាក់ព័ន្ធចំនួន     ច្បាប់)។');
  const date = escapeDocHtml(rt.date || 'រាជធានីភ្នំពេញ ថ្ងៃទី       ខែ          ឆ្នាំ២០២៦');
  const signerAdmin = escapeDocHtml(rt.signerAdmin || 'ប្រធានការិយាល័យរដ្ឋបាល និងបុគ្គលិក');

  const boxDeputyDirectorTitle = escapeDocHtml(rt.boxDeputyDirectorTitle || 'យោបល់ ឯកឧត្តមនាយករងសាលា');
  const boxDeputyDirectorContent = escapeDocHtml(rt.boxDeputyDirectorContent || '');
  const boxDeputyDirectorClosing = escapeDocHtml(rt.boxDeputyDirectorClosing || '');
  const boxDeputyDirectorSigner = escapeDocHtml(rt.boxDeputyDirectorSigner || '');

  const boxDeputyDeptTitle = escapeDocHtml(rt.boxDeputyDeptTitle || 'យោបល់ អនុប្រធាននាយកដ្ឋាន');
  const boxDeputyDeptContent = escapeDocHtml(rt.boxDeputyDeptContent || '.....គោរពជូន........................................................');
  const boxDeputyDeptClosing = escapeDocHtml(rt.boxDeputyDeptClosing || 'ដោយសេចក្តីគោរពដ៏ខ្ពង់ខ្ពស់!');
  const boxDeputyDeptSigner = escapeDocHtml(rt.boxDeputyDeptSigner || 'អនុប្រធាននាយកដ្ឋានទទួលបន្ទុក');

  const boxDirectorTitle = escapeDocHtml(rt.boxDirectorTitle || 'យោបល់ ឯកឧត្តមនាយកសាលា');
  const boxDirectorContent = escapeDocHtml(rt.boxDirectorContent || '');
  const boxDirectorSigner = escapeDocHtml(rt.boxDirectorSigner || '');

  const boxDeptHeadTitle = escapeDocHtml(rt.boxDeptHeadTitle || 'យោបល់ ប្រធាននាយកដ្ឋាន');
  const boxDeptHeadContent = escapeDocHtml(rt.boxDeptHeadContent || 'សូមគោរពជូន ឯកឧត្តមនាយករងសាលា\nដើម្បីជូន................................................................\n..........................................................................។');
  const boxDeptHeadClosing = escapeDocHtml(rt.boxDeptHeadClosing || 'ដោយសេចក្តីគោរពដ៏ខ្ពង់ខ្ពស់!');
  const boxDeptHeadSigner = escapeDocHtml(rt.boxDeptHeadSigner || 'ប្រធាននាយកដ្ឋាន');
  const adminSignatureBase64 = rt.adminSignatureBase64 || '';
  const adminSignatureTag = adminSignatureBase64 ?
    `<div style="text-align: center; margin: 4px 0;"><img src="${adminSignatureBase64}" style="max-height: 50px; max-width: 160px;" alt="Signature" /></div>` :
    `<div style="height: 50px;"></div>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" 
      xmlns:w="urn:schemas-microsoft-com:office:word" 
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>កំណត់បង្ហាញលិខិតចូល</title>
<!--[if gte mso 9]>
<xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page {
    size: A4 portrait;
    margin: 2.0cm 1.5cm 1.5cm 3.0cm;
  }
  body {
    font-family: "Khmer OS Siemreap", "Kantumruy Pro", "Khmer OS", Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #000;
  }
  .muol {
    font-family: "Khmer OS Muol Light", "Khmer OS Muol", Arial, sans-serif;
    font-weight: bold;
  }
  .header-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 15px;
  }
  .header-table td {
    vertical-align: top;
    padding: 0;
  }
  .kingdom-title {
    font-size: 13.5pt;
    text-align: center;
  }
  .motto {
    font-size: 12.5pt;
    text-align: center;
    letter-spacing: 0.5px;
  }
  .divider {
    text-align: center;
    font-size: 13pt;
    margin-top: -4px;
  }
  .main-title {
    text-align: center;
    font-size: 17pt;
    margin-top: 10px;
    margin-bottom: 20px;
    letter-spacing: 1px;
  }
  .meta-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 15px;
    table-layout: fixed;
  }
  .meta-table td {
    vertical-align: top;
    padding: 3px 0;
  }
  .submission-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
    table-layout: fixed;
  }
  .submission-table td {
    vertical-align: top;
    padding: 0;
  }
  .grid-boxes {
    width: 100%;
    border-collapse: collapse;
    margin-top: 5px;
    table-layout: fixed;
  }
  .grid-boxes td {
    width: 50%;
    border: 1.5pt solid #000;
    vertical-align: top;
    padding: 10px 12px;
    height: 190px;
  }
  .box-title {
    text-align: center;
    font-family: "Khmer OS Muol Light", "Khmer OS Muol", Arial, sans-serif;
    font-size: 10.5pt;
    text-decoration: underline;
    margin-bottom: 10px;
  }
  .box-body {
    font-size: 10.5pt;
    line-height: 1.5;
    min-height: 90px;
  }
  .box-footer {
    text-align: right;
    margin-top: 15px;
    font-size: 10.5pt;
  }
</style>
</head>
<body>
  <table class="header-table">
    <tr>
      <td style="width: 45%; text-align: left;">
        <div class="muol" style="font-size: 12pt; line-height: 1.4;">${ministry}</div>
        <div style="font-size: 11pt; margin-top: 4px;">${number}</div>
      </td>
      <td style="width: 55%; text-align: center;">
        <div class="muol kingdom-title">ព្រះរាជាណាចក្រកម្ពុជា</div>
        <div class="muol motto">ជាតិ សាសនា ព្រះមហាក្សត្រ</div>
        <div class="divider">~~~ 🙡 🙣 ~~~</div>
      </td>
    </tr>
  </table>

  <div class="muol main-title">កំណត់បង្ហាញលិខិតចូល</div>

  <table class="meta-table">
    <tr>
      <td style="width: 140px; font-weight: bold; white-space: nowrap; font-family: 'Khmer OS Muol Light';">ក្រសួង-ស្ថាប័ន៖</td>
      <td style="word-break: break-word;">${institution}</td>
    </tr>
    <tr>
      <td style="width: 140px; font-weight: bold; white-space: nowrap; font-family: 'Khmer OS Muol Light';">កម្មវត្ថុ៖</td>
      <td style="word-break: break-word; text-align: justify;">${subject}</td>
    </tr>
  </table>

  <table class="submission-table">
    <tr>
      <td style="width: 50%;">
        <div style="font-size: 11pt; font-weight: bold;">${submissionTo}</div>
        <div style="font-size: 10.5pt; margin-top: 4px;">${attachment}</div>
      </td>
      <td style="width: 50%; text-align: center;">
        <div style="font-size: 10.5pt;">${date}</div>
        <div class="muol" style="font-size: 11pt; margin-top: 4px;">${signerAdmin}</div>
        ${adminSignatureTag}
      </td>
    </tr>
  </table>

  <table class="grid-boxes">
    <!-- Row 1: Deputy School Director (Left) & Deputy Dept Director (Right) -->
    <tr>
      <td>
        <div class="box-title">${boxDeputyDirectorTitle}</div>
        <div class="box-body">${boxDeputyDirectorContent}</div>
        ${boxDeputyDirectorClosing ? `<div class="box-footer"><div>${boxDeputyDirectorClosing}</div><div class="muol" style="margin-top: 25px;">${boxDeputyDirectorSigner}</div></div>` : ''}
      </td>
      <td>
        <div class="box-title">${boxDeputyDeptTitle}</div>
        <div class="box-body">${boxDeputyDeptContent}</div>
        <div class="box-footer">
          <div>${boxDeputyDeptClosing}</div>
          <div class="muol" style="margin-top: 25px;">${boxDeputyDeptSigner}</div>
        </div>
      </td>
    </tr>

    <!-- Row 2: School Director (Left) & Dept Director (Right) -->
    <tr>
      <td>
        <div class="box-title">${boxDirectorTitle}</div>
        <div class="box-body">${boxDirectorContent}</div>
        ${boxDirectorSigner ? `<div class="box-footer"><div class="muol" style="margin-top: 40px;">${boxDirectorSigner}</div></div>` : ''}
      </td>
      <td>
        <div class="box-title">${boxDeptHeadTitle}</div>
        <div class="box-body">${boxDeptHeadContent}</div>
        <div class="box-footer">
          <div>${boxDeptHeadClosing}</div>
          <div class="muol" style="margin-top: 25px;">${boxDeptHeadSigner}</div>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Request Router
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-file-title, x-file-duration, x-original-name, x-mime-type, x-transcript, x-translation'
    });
    res.end();
    return;
  }

  try {
    // 1. API: Network info (Local IP for Wi-Fi sharing & QR Code + Cloudflare Tunnel)
    if (pathname === '/api/network-info' && method === 'GET') {
      const ips = getLocalIpAddresses();
      const localIp = ips[0] || 'localhost';
      const wifiUrl = `http://${localIp}:${actualPort}`;
      const bestHostUrl = cloudflareTunnelUrl || wifiUrl;
      sendJSON(res, 200, {
        port: actualPort,
        ips,
        localIp,
        hostUrl: bestHostUrl,
        tunnelUrl: cloudflareTunnelUrl,
        wifiUrl: wifiUrl,
        localUrl: `http://localhost:${actualPort}`,
        customName: 'Voice-V5-Vat1anak68'
      });
      return;
    }

    // 2. API: Config (Get & Save)
    if (pathname === '/api/config' && method === 'GET') {
      sendJSON(res, 200, getConfig());
      return;
    }
    if (pathname === '/api/config' && method === 'POST') {
      const body = await readJSON(req);
      const current = getConfig();
      const updated = { ...current, ...body };
      saveConfig(updated);
      sendJSON(res, 200, { success: true, config: updated });
      return;
    }

    // 3. API: Telegram Test Ping
    if (pathname === '/api/telegram/test' && method === 'POST') {
      const body = await readJSON(req);
      const token = body.token || getConfig().telegramBotToken;
      const chatId = body.chatId || getConfig().telegramChatId;

      if (!token || !chatId) {
        sendJSON(res, 400, { error: 'សូមបញ្ចូល Telegram Bot Token និង Chat ID ជាមុនសិន!' });
        return;
      }

      try {
        const testResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🎉 <b>សួស្តីពី Voice-V5 Pro!</b>\nការតភ្ជាប់ជាមួយ Telegram Bot របស់អ្នកបានជោគជ័យ ១០០%។ រាល់ការថតសម្លេង និងកំណត់ហេតុនឹងអាចផ្ញើមកទីនេះភ្លាមៗ។',
            parse_mode: 'HTML'
          })
        });
        const data = await testResp.json();
        if (data.ok) {
          sendJSON(res, 200, { success: true, message: 'បានផ្ញើសារសាកល្បងទៅ Telegram ជោគជ័យ!', data });
        } else {
          sendJSON(res, 400, { error: `Telegram Error: ${data.description}` });
        }
      } catch (err) {
        sendJSON(res, 500, { error: `មិនអាចតភ្ជាប់ទៅ Telegram: ${err.message}` });
      }
      return;
    }

    // 4. API: Telegram Send (Audio, Message, Minutes)
    if (pathname === '/api/telegram/send' && method === 'POST') {
      const body = await readJSON(req);
      const config = getConfig();
      const token = body.token || config.telegramBotToken;
      const chatId = body.chatId || config.telegramChatId;

      if (!token || !chatId) {
        sendJSON(res, 400, { error: 'Telegram Bot Token ឬ Chat ID មិនទាន់បានកំណត់' });
        return;
      }

      let audioFilePath = null;
      if (body.recordingId) {
        const recordings = getRecordings();
        const rec = recordings.find(r => r.id === body.recordingId);
        if (rec && rec.filename) {
          audioFilePath = path.join(UPLOADS_DIR, rec.filename);
        }
      }

      let docFilePath = null;
      let docName = null;
      if (body.minutes) {
        const docHtml = generateWordDoc(body.minutes);
        docName = `កំណត់ហេតុ_${(body.minutes.title || 'កិច្ចប្រជុំ').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
        docFilePath = path.join(DATA_DIR, `temp_${Date.now()}.doc`);
        fs.writeFileSync(docFilePath, docHtml, 'utf8');
      }

      const captionText = body.text || '🎙️ <b>ឯកសារថតសម្លេងថ្មីពី Voice-V5 Pro</b>';

      try {
        const result = await sendToTelegram({
          token,
          chatId,
          text: captionText,
          audioFilePath,
          docFilePath,
          docName
        });

        // Clean temp doc file if created
        if (docFilePath && fs.existsSync(docFilePath)) {
          fs.unlinkSync(docFilePath);
        }

        sendJSON(res, 200, { success: true, result });
      } catch (err) {
        if (docFilePath && fs.existsSync(docFilePath)) {
          fs.unlinkSync(docFilePath);
        }
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // 5. API: Live Translation
    if (pathname === '/api/translate' && method === 'POST') {
      const body = await readJSON(req);
      const text = body.text || '';
      const sl = body.sl || 'km';
      const tl = body.tl || 'en';

      if (!text.trim()) {
        sendJSON(res, 200, { translatedText: '' });
        return;
      }

      const translated = await translateText(text, sl, tl);
      sendJSON(res, 200, { translatedText: translated });
      return;
    }

    // 5.5 API: Transcribe Audio File using Gemini Multimodal Audio
    if (pathname === '/api/ai/transcribe' && method === 'POST') {
      const body = await readJSON(req);
      const recordingId = body.recordingId;
      const config = getConfig();
      const apiKey = body.apiKey || config.geminiApiKey;

      if (!apiKey) {
        sendJSON(res, 400, { error: 'សូមបញ្ចូល Google Gemini API Key ក្នុងផ្ទាំងការកំណត់ ដើម្បីដំណើរការបម្លែងសម្លេងឯកសារជាអក្សរស្វ័យប្រវត្ត' });
        return;
      }

      const recordings = getRecordings();
      const rec = recordings.find(r => r.id === recordingId);
      if (!rec || !rec.filename) {
        sendJSON(res, 404, { error: 'រកមិនឃើញឯកសារថតសម្លេង' });
        return;
      }

      const audioFilePath = path.join(UPLOADS_DIR, rec.filename);
      if (!fs.existsSync(audioFilePath)) {
        sendJSON(res, 404, { error: 'រកមិនឃើញ File សម្លេងលើ server' });
        return;
      }

      try {
        const audioBuffer = fs.readFileSync(audioFilePath);
        const base64Audio = audioBuffer.toString('base64');
        let mime = rec.mimeType || 'audio/webm';
        if (rec.filename.endsWith('.m4a') || rec.filename.endsWith('.mp4')) mime = 'audio/mp4';
        if (rec.filename.endsWith('.mp3')) mime = 'audio/mp3';
        if (rec.filename.endsWith('.wav')) mime = 'audio/wav';
        if (rec.filename.endsWith('.ogg')) mime = 'audio/ogg';

        const prompt = "សូមជួយបម្លែងសម្លេងនេះឱ្យទៅជាអត្ថបទអក្សរខ្មែរ (Khmer Speech-to-Text) ឱ្យបានត្រឹមត្រូវ ១០០% តាមវេយ្យាករណ៍ខ្មែរ ច្បាស់លាស់ ដោយដាក់សញ្ញាក្បៀស ចុច និងកថាខណ្ឌឱ្យបានស្អាត។ សូមផ្តល់តែអត្ថបទបម្លែងសុទ្ធប៉ុណ្ណោះ ដោយកុំបន្ថែមពាក្យពន្យល់ផ្សេងៗឡើយ។";

        const data = await callGeminiApi(apiKey, 'generateContent', {
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: mime,
                    data: base64Audio
                  }
                },
                { text: prompt }
              ]
            }
          ]
        });

        const transcribed = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        rec.transcript = transcribed;
        saveRecordings(recordings);
        sendJSON(res, 200, { success: true, transcript: transcribed });
        return;
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
        return;
      }
    }

    // 5.6 API: AI Refine Transcript (Deep Khmer Grammar, Spelling & Phonetic Fixer)
    if (pathname === '/api/ai/refine-transcript' && method === 'POST') {
      const body = await readJSON(req);
      const rawText = body.text || '';
      const config = getConfig();
      const apiKey = body.apiKey || config.geminiApiKey;

      if (!rawText.trim()) {
        sendJSON(res, 200, { success: true, refinedText: '' });
        return;
      }

      // If Gemini Key is available, perform deep LLM Khmer refinement
      if (apiKey) {
        try {
          const prompt = `អ្នកគឺជាអ្នកជំនាញអក្សរសាស្ត្រខ្មែរ និងរដ្ឋបាលសាធារណៈនៃប្រទេសកម្ពុជា។ ខាងក្រោមនេះជាអត្ថបទដែលបានបម្លែងចេញពីសម្លេងនិយាយ (Speech-to-Text) ដែលមានកំហុសអក្ខរាវិរុទ្ធ ពាក្យនិយាយជាន់គ្នា និងកំហុសការស្តាប់ (Phonetic errors):
"""
${rawText}
"""

សូមជួយកែសម្រួលអត្ថបទនេះឱ្យក្លាយជាភាសាខ្មែររដ្ឋបាលត្រឹមត្រូវ ១០០% ដោយ៖
១. កែកំហុសអក្ខរាវិរុទ្ធ និងពាក្យស្តាប់ច្រឡំ (ជាពិសេស ឈ្មោះបុគ្គល នាយកដ្ឋាន តួនាទី ស្ថាប័ន)។
២. លុបពាក្យនិយាយត្រួតគ្នា ស្ទាក់ស្ទើរ ឬពាក្យឥតន័យដែលម៉ាស៊ីនស្តាប់ច្រឡំ (ដូចជា canage, rea, ah, um...)។
៣. រៀបចំចន្លោះឃ្លា (Spacing) និងសញ្ញាខណ្ឌ (។) ឱ្យបានត្រឹមត្រូវតាមក្បួនខ្នាតអក្សរសាស្ត្រខ្មែរ។
៤. រក្សាខ្លឹមសារដើមនៃសេចក្តីថ្លែងឱ្យបានពេញលេញ។
សូមបញ្ជូនតែអត្ថបទដែលបានកែសម្រួលរួចសុទ្ធសាធ ដោយមិនចាំបាច់មានពាក្យពន្យល់ឡើយ។`;

          const data = await callGeminiApi(apiKey, 'generateContent', {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1
            }
          });

          const refined = data.candidates?.[0]?.content?.parts?.[0]?.text || rawText;
          sendJSON(res, 200, { success: true, refinedText: refined.trim(), aiRefined: true });
          return;
        } catch (e) {
          console.warn('Gemini refine error:', e);
        }
      }

      // Built-in rule-based linguistic cleaner fallback (Zero-dependency & Offline)
      const cleaned = cleanKhmerTranscriptOffline(rawText);

      sendJSON(res, 200, {
        success: true,
        refinedText: cleaned,
        aiRefined: false,
        needsApiKey: !apiKey
      });
      return;
    }

    // 5.7 API: Test Gemini AI API Key Connection
    if (pathname === '/api/ai/test' && method === 'POST') {
      const body = await readJSON(req);
      const config = getConfig();
      const apiKey = body.apiKey || config.geminiApiKey;

      if (!apiKey) {
        sendJSON(res, 400, { error: 'សូមបញ្ចូល Google Gemini API Key ជាមុនសិន!' });
        return;
      }

      try {
        const data = await callGeminiApi(apiKey, 'generateContent', {
          contents: [{ parts: [{ text: "សូមឆ្លើយពាក្យ 'OK' មួយម៉ាត់ខ្លី។" }] }]
        });

        if (data && data.candidates) {
          sendJSON(res, 200, { success: true, message: '🎉 តភ្ជាប់ជាមួយ Google Gemini AI ជោគជ័យ ១០០%!' });
        } else {
          sendJSON(res, 400, { error: 'Gemini API មិនបានឆ្លើយតប' });
        }
      } catch (err) {
        sendJSON(res, 500, { error: `បរាជ័យក្នុងការតភ្ជាប់ Gemini AI: ${err.message}` });
      }
      return;
    }

    // 6. API: AI Minutes Generator (Using Gemini API if provided, or intelligent Khmer rule-based engine)
    if (pathname === '/api/ai/generate-minutes' && method === 'POST') {
      const body = await readJSON(req);
      const transcript = body.transcript || '';
      const config = getConfig();
      const apiKey = body.apiKey || config.geminiApiKey;

      if (apiKey && transcript.trim().length > 30) {
        try {
          const prompt = `អ្នកគឺជាអ្នកជំនាញរដ្ឋបាលសាធារណៈនៃក្រសួងមហាផ្ទៃ និងរាជរដ្ឋាភិបាលកម្ពុជា។ សូមយករៀបរាប់ ឬខ្លឹមសារនៃកិច្ចប្រជុំ/ការថតសម្លេងខាងក្រោមនេះ មកកែសម្រួល និងរៀបចំជាទម្រង់កំណត់ហេតុរដ្ឋបាលផ្លូវការ តាមរចនាសម្ព័ន្ធលិខិតរដ្ឋបាលខ្មែរ។
ខ្លឹមសារកិច្ចប្រជុំ៖
"""
${transcript}
"""

សូមបញ្ជូនចម្លើយមកវិញជាទម្រង់ JSON សុទ្ធ (Strict JSON) ដោយគ្មាន \`\`\`json ឬ markdown ឡើយ ដែលមានរចនាសម្ព័ន្ធដូចខាងក្រោម៖
{
  "ministry": "ក្រសួងមហាផ្ទៃ\\nអគ្គនាយកដ្ឋានរដ្ឋបាល",
  "title": "ចំណងជើងកម្មវត្ថុនៃកិច្ចប្រជុំ",
  "datetime": "កាលបរិច្ឆេទនៃកិច្ចប្រជុំ (ឧទាហរណ៍ ថ្ងៃទី... ខែ... ឆ្នាំ...)",
  "location": "ទីកន្លែងកិច្ចប្រជុំ (ឧទាហរណ៍ សាលប្រជុំ...)",
  "attendees": "សមាសភាពចូលរួម (រាយនាម និងតួនាទី)",
  "agenda": "របៀបវារៈនៃអង្គប្រជុំ (១. ... ២. ...)",
  "content": "ដំណើរការនៃអង្គប្រជុំ និងការពិភាក្សា (លម្អិតត្រឹមត្រូវតាមស្មារតីអង្គប្រជុំ)",
  "decisions": "សេចក្តីសម្រេច និងទិសដៅអនុវត្តបន្ត (១. ... ២. ...)",
  "signers": {
    "recorder": "ឈ្មោះអ្នកធ្វើកំណត់ហេតុ",
    "chair": "ឈ្មោះប្រធានអង្គប្រជុំ"
  }
}`;

          const data = await callGeminiApi(apiKey, 'generateContent', {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2
            }
          });

          const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (textResponse) {
            const parsed = JSON.parse(textResponse);
            const minutes = generateKhmerMinutes({
              ...parsed,
              content: parsed.content || transcript
            });
            sendJSON(res, 200, { success: true, minutes, aiGenerated: true });
            return;
          }
        } catch (aiErr) {
          console.error('Gemini Minutes error, falling back to rule-based engine:', aiErr);
        }
      }

      // Intelligent rule-based fallback
      const minutes = generateKhmerMinutes({
        title: body.title || 'កិច្ចប្រជុំស្តីពីការងារ និងទិសដៅអនុវត្ត',
        content: transcript || 'អង្គប្រជុំបានពិភាក្សាយ៉ាងលម្អិតលើរបៀបវារៈដែលបានលើកឡើង។',
        attendees: body.attendees,
        location: body.location,
        ministry: body.ministry,
        agenda: body.agenda,
        decisions: body.decisions
      });
      sendJSON(res, 200, { success: true, minutes, aiGenerated: false });
      return;
    }

    // 7. API: Export Word Document (.doc) (Minutes, Invitation, Routing Slip)
    if (pathname === '/api/export/word' && method === 'POST') {
      const body = await readJSON(req);
      const docType = body.docType || 'minutes';
      let docHtml = '';
      let filename = 'Official_Document.doc';

      if (docType === 'invitation') {
        const inv = body.invitation || {};
        docHtml = generateWordDocInvitation(inv);
        filename = `លិខិតអញ្ជើញ_${(inv.title || 'Official').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
      } else if (docType === 'routing') {
        const rt = body.routing || {};
        docHtml = generateWordDocRouting(rt);
        filename = `កំណត់បង្ហាញលិខិតចូល_${(rt.subject || 'Official').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
      } else {
        const minutes = body.minutes || generateKhmerMinutes({});
        docHtml = generateWordDoc(minutes);
        filename = `កំណត់ហេតុ_${(minutes.title || 'Official').replace(/[/\\?%*:|"<>]/g, '_')}.doc`;
      }

      res.writeHead(200, {
        'Content-Type': 'application/msword; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(docHtml);
      return;
    }

    // 8. API: Upload Audio / Drag-and-Drop File Streaming
    if (pathname === '/api/recordings/upload' && method === 'POST') {
      const title = decodeURIComponent(req.headers['x-file-title'] || 'ការថតសម្លេងថ្មី');
      const duration = parseFloat(req.headers['x-file-duration'] || '0');
      const originalName = decodeURIComponent(req.headers['x-original-name'] || 'recording.webm');
      const mimeType = req.headers['x-mime-type'] || 'audio/webm';
      const transcript = decodeURIComponent(req.headers['x-transcript'] || '');
      const liveTranslation = decodeURIComponent(req.headers['x-translation'] || '');

      const ext = path.extname(originalName) || (mimeType.includes('ogg') ? '.ogg' : mimeType.includes('mp3') ? '.mp3' : '.webm');
      const id = crypto.randomUUID();
      const filename = `${id}${ext}`;
      const destPath = path.join(UPLOADS_DIR, filename);

      const writeStream = fs.createWriteStream(destPath);
      req.pipe(writeStream);

      writeStream.on('finish', async () => {
        const stats = fs.statSync(destPath);
        backupFileToGDrive('uploads', filename, destPath);

        const newRecording = {
          id,
          title,
          filename,
          originalName,
          mimeType,
          size: stats.size,
          duration,
          createdAt: new Date().toISOString(),
          transcript,
          liveTranslation,
          administrativeMinutes: null,
          telegramStatus: 'pending'
        };

        const list = getRecordings();
        list.unshift(newRecording);
        saveRecordings(list);

        // Auto-send to Telegram if enabled
        const config = getConfig();
        if (config.autoSendTelegram && config.telegramBotToken && config.telegramChatId) {
          sendToTelegram({
            token: config.telegramBotToken,
            chatId: config.telegramChatId,
            text: `🎙️ <b>ការថតសម្លេងថ្មីត្រូវបានបញ្ចប់៖</b> ${title}\n⏱️ រយៈពេល៖ ${Math.round(duration)} វិនាទី\n\n📝 <b>ខ្លឹមសារបម្លែងជាអក្សរ៖</b>\n${transcript || '(គ្មាន)'}\n\n🌐 <b>បកប្រែផ្ទាល់៖</b>\n${liveTranslation || '(គ្មាន)'}`,
            audioFilePath: destPath
          }).then(resTg => {
            const currentList = getRecordings();
            const target = currentList.find(r => r.id === id);
            if (target) {
              target.telegramStatus = resTg.audio?.ok ? 'sent' : 'failed';
              saveRecordings(currentList);
            }
          }).catch(err => {
            console.error('Auto Telegram error:', err);
          });
        }

        sendJSON(res, 201, { success: true, recording: newRecording });
      });

      writeStream.on('error', err => {
        console.error('File save error:', err);
        sendJSON(res, 500, { error: 'បរាជ័យក្នុងការរក្សាទុកឯកសារ' });
      });
      return;
    }

    // 9. API: List Recordings
    if (pathname === '/api/recordings' && method === 'GET') {
      const list = getRecordings();
      sendJSON(res, 200, list);
      return;
    }

    // 10. API: Get Single Recording
    if (pathname.startsWith('/api/recordings/') && method === 'GET') {
      const id = pathname.split('/')[3];
      const list = getRecordings();
      const rec = list.find(r => r.id === id);
      if (rec) {
        sendJSON(res, 200, rec);
      } else {
        sendJSON(res, 404, { error: 'រកមិនឃើញទិន្នន័យ' });
      }
      return;
    }

    // 11. API: Update Recording (Transcript, Translation, Minutes)
    if (pathname.startsWith('/api/recordings/') && method === 'PUT') {
      const id = pathname.split('/')[3];
      const body = await readJSON(req);
      const list = getRecordings();
      const index = list.findIndex(r => r.id === id);
      if (index !== -1) {
        list[index] = { ...list[index], ...body };
        saveRecordings(list);
        sendJSON(res, 200, { success: true, recording: list[index] });
      } else {
        sendJSON(res, 404, { error: 'រកមិនឃើញទិន្នន័យ' });
      }
      return;
    }

    // 12. API: Delete Recording Metadata from list
    if (pathname.startsWith('/api/recordings/') && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const list = getRecordings();
      const filtered = list.filter(r => r.id !== id);
      saveRecordings(filtered);
      sendJSON(res, 200, { success: true, message: 'បានលុបទិន្នន័យចេញពីបញ្ជី' });
      return;
    }

    // 13. Serve Uploaded Audio Files: /uploads/*
    if (pathname.startsWith('/uploads/')) {
      const filename = path.basename(pathname);
      const filePath = path.join(UPLOADS_DIR, filename);
      serveStaticFile(req, res, filePath);
      return;
    }

    // 14. Dedicated Share Page: /share
    if (pathname === '/share') {
      serveStaticFile(req, res, path.join(PUBLIC_DIR, 'share.html'));
      return;
    }

    // 15. Serve Static Assets from /public
    let relativePath = pathname === '/' ? 'index.html' : pathname;
    const staticFilePath = path.join(PUBLIC_DIR, relativePath);
    serveStaticFile(req, res, staticFilePath);

  } catch (err) {
    console.error('Server unhandled error:', err);
    sendJSON(res, 500, { error: 'Internal Server Error', message: err.message });
  }
});

// High-capacity socket settings for large & long continuous recordings (>5 hours)
server.timeout = 0; // Disable socket timeout
server.keepAliveTimeout = 300000; // 5 minutes keep-alive
server.headersTimeout = 305000;
server.requestTimeout = 0;

function listenWithFallback(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port === 3000 ? 3005 : port + 1;
      console.warn(`⚠️ Port ${port} ជាប់រវល់ (កំពុងប្រើប្រាស់ដោយកម្មវិធីផ្សេង)។ កំពុងប្តូរទៅកាន់ Port ${nextPort}...`);
      listenWithFallback(nextPort);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    actualPort = port;
    const ips = getLocalIpAddresses();
    console.log(`=======================================================`);
    console.log(`🎙️ Voice-V5-Vat1anak68 Server is running on port ${actualPort}!`);
    console.log(`👉 Local:   http://localhost:${actualPort}`);
    ips.forEach(ip => {
      console.log(`👉 Network: http://${ip}:${actualPort} (សម្រាប់ទូរស័ព្ទ ឬកុំព្យូទ័ររួម Wi-Fi)`);
    });
    console.log(`=======================================================`);

    try {
      fs.writeFileSync(path.join(DATA_DIR, 'active_url.txt'), `http://localhost:${actualPort}`, 'utf8');
    } catch (e) {}

    // Start Cloudflare HTTPS Tunnel automatically for mobile mic & custom domain
    startCloudflareTunnel(actualPort);
  });
}

listenWithFallback(DEFAULT_PORT);
