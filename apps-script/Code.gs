/**
 * HiG Sign — система электронной подписи Homes in Georgia (бэкенд, Google Apps Script).
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 *
 * Отдельный проект Apps Script. Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   SIGN_BOT_TOKEN — токен бота подписи из @BotFather
 *   BOT_USERNAME   — username бота без @ (например homesingeorgia_sign_bot)
 *   APP_SHORT_NAME — короткое имя Mini App из /newapp (например sign)
 *   ADMIN_KEY      — пароль админ-панели (длинная случайная строка)
 *   ADMIN_CHAT_IDS — куда присылать уведомления и подписанные PDF (chat id через запятую)
 *   SHEET_ID, FOLDER_ID — создаются сами функцией setup()
 *
 * Все запросы — POST с JSON в теле (text/plain, чтобы не было CORS preflight):
 *   {action:'adminInfo'|'create'|'list'|'cancel', key, ...}   — админ-панель
 *   {action:'open'|'sign'|'finalize', token, initData, ...}   — Mini App подписанта
 */

var TZ = 'Asia/Tbilisi';
var INIT_DATA_MAX_AGE_SEC = 24 * 3600;
var COMPANY = {
  name: 'Homes in Georgia',
  rep: { ka: 'დამფუძნებელი დავით ტიბელაშვილი', ru: 'основатель Давид Тибелашвили' },
  site: 'hge.ge',
  crm: 'CRM Homes in Georgia (Rent in Tbilisi CRM)'
};
var COLS = ['token', 'number', 'template', 'version', 'createdAt', 'status',
  'agentName', 'phone', 'personalId', 'tgExpected', 'note',
  'tgId', 'tgUsername', 'tgName', 'openedAt', 'signedAt', 'ip', 'userAgent', 'timezone',
  'docHash', 'contentFileId', 'signatureFileId', 'pdfFileId', 'pdfHash',
  'deliveredAgent', 'deliveredAdmin', 'completedAt'];

/* ───────────────────────── entry points ───────────────────────── */

function doGet() {
  return json_({ ok: true, service: 'HiG Sign' });
}

function doPost(e) {
  var p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  try {
    var handlers = {
      adminInfo: adminInfo_, create: create_, list: list_, cancel: cancel_,
      open: open_, sign: sign_, finalize: finalize_
    };
    var h = handlers[p.action];
    if (!h) throw userError_('unknown_action');
    var result = h(p);
    result.ok = true;
    return json_(result);
  } catch (err) {
    if (err && err.userError) return json_({ ok: false, error: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server_error', detail: String(err && err.message || err) });
  }
}

/** Запустить один раз вручную из редактора: создаёт таблицу-реестр и папку на Google Диске. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) {
    var folder = DriveApp.createFolder('HiG Sign — подписанные договоры');
    props.setProperty('FOLDER_ID', folder.getId());
  }
  if (!props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create('HiG Sign — реестр договоров');
    var sh = ss.getSheets()[0];
    sh.setName('Envelopes');
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), COLS.length).setNumberFormat('@');
    props.setProperty('SHEET_ID', ss.getId());
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(props.getProperty('FOLDER_ID')));
  }
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  console.log('Готово. Реестр: https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID'));
  console.log('Пароль админ-панели (ADMIN_KEY): ' + props.getProperty('ADMIN_KEY'));
}

/** Проверка: бот пришлёт сообщение во все ADMIN_CHAT_IDS. */
function testTelegram() {
  adminChats_().forEach(function (id) {
    tg_('sendMessage', { chat_id: id, text: 'HiG Sign: связь с ботом работает ✅' });
  });
}

/* ───────────────────────── admin ───────────────────────── */

function adminInfo_(p) {
  requireAdmin_(p);
  var templates = Object.keys(TEMPLATES).map(function (k) {
    var t = TEMPLATES[k];
    return { id: t.id, version: t.version, title: t.title, short: t.short };
  });
  return {
    templates: templates,
    company: COMPANY,
    configured: {
      bot: !!prop_('SIGN_BOT_TOKEN') && !!prop_('BOT_USERNAME') && !!prop_('APP_SHORT_NAME'),
      adminChats: adminChats_().length > 0,
      storage: !!prop_('SHEET_ID') && !!prop_('FOLDER_ID')
    },
    registryUrl: prop_('SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + prop_('SHEET_ID') : ''
  };
}

function create_(p) {
  requireAdmin_(p);
  var tpl = TEMPLATES[p.template];
  if (!tpl) throw userError_('unknown_template');
  var agent = {
    name: clean_(p.agentName, 120),
    phone: clean_(p.phone, 40),
    personalId: clean_(p.personalId, 40),
    telegram: clean_(p.telegram, 64).replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '')
  };
  if (!agent.name) throw userError_('name_required');
  if (!agent.phone) throw userError_('phone_required');
  if (!agent.personalId) throw userError_('personal_id_required');
  if (agent.telegram && !/^[A-Za-z0-9_]{4,32}$/.test(agent.telegram)) throw userError_('bad_telegram');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var now = new Date();
    var year = Utilities.formatDate(now, TZ, 'yyyy');
    var prefix = tpl.prefix + '-' + year + '-';
    var count = 0;
    rows_(sh).forEach(function (r) { if (String(r.number).indexOf(prefix) === 0) count++; });
    var number = prefix + ('000' + (count + 1)).slice(-4);
    var token = 's' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);

    var content = render_(tpl, agent, { number: number, date: Utilities.formatDate(now, TZ, 'dd.MM.yyyy') });
    var contentJson = JSON.stringify(content);
    var docHash = sha256Hex_(contentJson);
    var file = folder_('content').createFile(number + '.json', contentJson, 'application/json');

    var rec = {
      token: token, number: number, template: tpl.id, version: tpl.version,
      createdAt: iso_(now), status: 'sent',
      agentName: agent.name, phone: agent.phone, personalId: agent.personalId,
      tgExpected: agent.telegram, note: clean_(p.note, 300),
      docHash: docHash, contentFileId: file.getId()
    };
    sh.appendRow(COLS.map(function (c) { return cell_(rec[c]); }));
    return { envelope: publicRow_(rec), link: signLink_(token) };
  } finally {
    lock.releaseLock();
  }
}

function list_(p) {
  requireAdmin_(p);
  var items = rows_(sheet_()).map(publicRow_).reverse().slice(0, 300);
  return { items: items };
}

function cancel_(p) {
  requireAdmin_(p);
  var sh = sheet_();
  var found = findRow_(sh, p.token);
  if (!found) throw userError_('not_found');
  if (found.rec.status === 'completed') throw userError_('already_signed');
  update_(sh, found.index, { status: 'cancelled' });
  return {};
}

/* ───────────────────────── signer (Telegram Mini App) ───────────────────────── */

function open_(p) {
  var user = verifyInitData_(p.initData);
  var sh = sheet_();
  var found = findRow_(sh, p.token);
  if (!found) throw userError_('not_found');
  var rec = found.rec;
  if (rec.status === 'cancelled') throw userError_('cancelled');
  checkSigner_(rec, user);

  if (!rec.tgId) {
    var patch = {
      tgId: String(user.id),
      tgUsername: user.username || '',
      tgName: [user.first_name, user.last_name].filter(Boolean).join(' '),
      openedAt: iso_(new Date()),
      status: rec.status === 'sent' ? 'opened' : rec.status
    };
    update_(sh, found.index, patch);
    for (var k in patch) rec[k] = patch[k];
    notifyAdmins_('👀 ' + rec.number + ' — ' + rec.agentName + ' открыл(а) договор' +
      (user.username ? ' (@' + user.username + ')' : '') + '.');
  }

  var content = JSON.parse(DriveApp.getFileById(rec.contentFileId).getBlob().getDataAsString('UTF-8'));
  return {
    envelope: {
      number: rec.number, status: rec.status, docHash: rec.docHash,
      agentName: rec.agentName, phone: rec.phone, personalId: rec.personalId,
      tgUsername: rec.tgUsername, tgId: rec.tgId,
      signedAt: rec.signedAt, signedAtText: rec.signedAt ? fmt_(new Date(rec.signedAt)) : '',
      pdfHash: rec.pdfHash
    },
    content: content
  };
}

function sign_(p) {
  var user = verifyInitData_(p.initData);
  var sh = sheet_();
  var found = findRow_(sh, p.token);
  if (!found) throw userError_('not_found');
  var rec = found.rec;
  checkSigner_(rec, user);
  if (String(rec.tgId) !== String(user.id)) throw userError_('wrong_user');
  if (rec.status === 'completed') throw userError_('bad_status');
  // 'signed' без PDF = прошлая попытка оборвалась (связь) — разрешаем подписать заново
  if (rec.status !== 'opened' && rec.status !== 'signed') throw userError_('bad_status');
  if (p.consent !== true) throw userError_('consent_required');
  if (p.docHash !== rec.docHash) throw userError_('doc_changed');
  var m = /^data:image\/png;base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.signature || ''));
  if (!m || m[1].length > 400000) throw userError_('bad_signature');

  var now = new Date();
  var sig = Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/png', rec.number + '-signature.png');
  var sigFile = folder_('signatures').createFile(sig);
  var info = p.client || {};
  update_(sh, found.index, {
    status: 'signed', signedAt: iso_(now), signatureFileId: sigFile.getId(),
    ip: clean_(info.ip, 64), userAgent: clean_(info.userAgent, 300), timezone: clean_(info.timezone, 64)
  });
  return { signedAt: iso_(now), signedAtText: fmt_(now) };
}

function finalize_(p) {
  var user = verifyInitData_(p.initData);
  var sh = sheet_();
  var found = findRow_(sh, p.token);
  if (!found) throw userError_('not_found');
  var rec = found.rec;
  if (String(rec.tgId) !== String(user.id)) throw userError_('wrong_user');
  if (rec.status === 'completed') return { pdfHash: rec.pdfHash, already: true };
  if (rec.status !== 'signed') throw userError_('bad_status');

  var b64 = String(p.pdf || '');
  if (!b64 || b64.length > 20 * 1024 * 1024) throw userError_('bad_pdf');
  var bytes = Utilities.base64Decode(b64);
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw userError_('bad_pdf');
  var pdfHash = sha256Hex_(bytes);
  var fileName = rec.number + ' — ' + rec.agentName + '.pdf';
  var pdf = Utilities.newBlob(bytes, 'application/pdf', fileName);
  var pdfFile = folder_('pdf').createFile(pdf);

  var caption = '✅ Подписан договор ' + rec.number + '\n' +
    rec.agentName + (rec.tgUsername ? ' (@' + rec.tgUsername + ')' : '') + '\n' +
    'Подписано: ' + fmt_(new Date(rec.signedAt)) + ' (Тбилиси)\n' +
    'SHA-256 PDF: ' + pdfHash.slice(0, 16) + '…';

  var deliveredAdmin = 0;
  adminChats_().forEach(function (id) {
    if (sendDocument_(id, pdf, caption)) deliveredAdmin++;
  });
  var deliveredAgent = sendDocument_(user.id, pdf,
    '✅ ხელშეკრულება ხელმოწერილია / Договор подписан\n' + rec.number + ' · Homes in Georgia\n' +
    'შეინახეთ ეს ფაილი / Сохраните этот файл.');

  update_(sh, found.index, {
    status: 'completed', pdfFileId: pdfFile.getId(), pdfHash: pdfHash,
    deliveredAgent: deliveredAgent ? 'yes' : 'no', deliveredAdmin: deliveredAdmin,
    completedAt: iso_(new Date())
  });
  return { pdfHash: pdfHash, deliveredAgent: deliveredAgent };
}

/* ───────────────────────── rendering ───────────────────────── */

function render_(tpl, agent, doc) {
  var vars = {
    'agent.name': agent.name, 'agent.phone': agent.phone, 'agent.personalId': agent.personalId,
    'agent.telegram': agent.telegram ? '@' + agent.telegram : '',
    'doc.number': doc.number, 'doc.date': doc.date
  };
  var sub = function (s) {
    return String(s || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_, k) {
      return vars[k] !== undefined ? vars[k] : '';
    });
  };
  var blocks = tpl.blocks.map(function (b) {
    if (b.t === 'requisites') return requisites_(agent);
    var o = { t: b.t, ka: sub(b.ka), ru: sub(b.ru) };
    if (b.n) o.n = b.n;
    return o;
  });
  return {
    template: tpl.id, version: tpl.version, number: doc.number, date: doc.date,
    title: { ka: tpl.title.ka, ru: tpl.title.ru },
    blocks: blocks
  };
}

function requisites_(agent) {
  var dash = '—';
  return {
    t: 'table',
    head: { label: { ka: '', ru: '' }, company: { ka: 'კომპანია', ru: 'Компания' }, agent: { ka: 'აგენტი', ru: 'Агент' } },
    rows: [
      { label: { ka: 'დასახელება / სახელი, გვარი', ru: 'Наименование / ФИО' }, company: COMPANY.name, agent: agent.name },
      { label: { ka: 'წარმომადგენელი', ru: 'Представитель' }, company: COMPANY.rep.ka + ' / ' + COMPANY.rep.ru, agent: dash },
      { label: { ka: 'ვებგვერდი / CRM', ru: 'Сайт / CRM' }, company: COMPANY.site + ' · ' + COMPANY.crm, agent: dash },
      { label: { ka: 'პირადი ნომერი', ru: 'Личный номер' }, company: dash, agent: agent.personalId },
      { label: { ka: 'ტელეფონი / Telegram', ru: 'Телефон / Telegram' }, company: dash,
        agent: agent.phone + (agent.telegram ? ' · @' + agent.telegram : '') },
      { label: { ka: 'ხელმოწერა', ru: 'Подпись' },
        company: 'ოფერტა დამტკიცებულია გამოქვეყნებისას / оферта утверждена при публикации',
        agent: '{{signature}}' },
      { label: { ka: 'ხელმოწერის თარიღი და დრო', ru: 'Дата и время подписания' }, company: dash, agent: '{{signedAt}}' }
    ]
  };
}

/* ───────────────────────── Telegram ───────────────────────── */

function verifyInitData_(initData) {
  var token = prop_('SIGN_BOT_TOKEN');
  if (!token) throw userError_('bot_not_configured');
  var raw = String(initData || '');
  if (!raw) throw userError_('no_init_data');
  var fields = {};
  raw.split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    var k = decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '));
    fields[k] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  });
  var hash = fields.hash;
  if (!hash) throw userError_('bad_init_data');
  var dcs = Object.keys(fields).filter(function (k) { return k !== 'hash'; }).sort()
    .map(function (k) { return k + '=' + fields[k]; }).join('\n');
  var secret = Utilities.computeHmacSha256Signature(token, 'WebAppData');
  var check = hex_(Utilities.computeHmacSha256Signature(Utilities.newBlob(dcs).getBytes(), secret));
  if (!safeEqual_(check, String(hash).toLowerCase())) throw userError_('bad_init_data');
  var age = Date.now() / 1000 - Number(fields.auth_date || 0);
  if (!(age < INIT_DATA_MAX_AGE_SEC)) throw userError_('init_data_expired');
  var user = JSON.parse(fields.user || 'null');
  if (!user || !user.id) throw userError_('bad_init_data');
  return user;
}

function checkSigner_(rec, user) {
  if (rec.tgId && String(rec.tgId) !== String(user.id)) throw userError_('wrong_user');
  if (rec.tgExpected) {
    var u = String(user.username || '').toLowerCase();
    if (u !== String(rec.tgExpected).toLowerCase()) throw userError_('wrong_user');
  }
}

function tg_(method, payload) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('SIGN_BOT_TOKEN') + '/' + method, {
    method: 'post', payload: payload, muteHttpExceptions: true
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* ignore */ }
  if (!body.ok) console.warn('Telegram ' + method + ' failed: ' + res.getContentText());
  return body;
}

function sendDocument_(chatId, blob, caption) {
  try {
    return !!tg_('sendDocument', { chat_id: String(chatId), document: blob.copyBlob(), caption: caption }).ok;
  } catch (e) {
    console.warn(e);
    return false;
  }
}

function notifyAdmins_(text) {
  adminChats_().forEach(function (id) {
    try { tg_('sendMessage', { chat_id: id, text: text }); } catch (e) { console.warn(e); }
  });
}

function adminChats_() {
  return String(prop_('ADMIN_CHAT_IDS') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function signLink_(token) {
  return 'https://t.me/' + prop_('BOT_USERNAME') + '/' + prop_('APP_SHORT_NAME') + '?startapp=' + token;
}

/* ───────────────────────── storage ───────────────────────── */

function sheet_() {
  var id = prop_('SHEET_ID');
  if (!id) throw userError_('storage_not_configured');
  return SpreadsheetApp.openById(id).getSheetByName('Envelopes');
}

function folder_(sub) {
  var root = DriveApp.getFolderById(prop_('FOLDER_ID'));
  var it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
}

function rows_(sh) {
  var values = sh.getDataRange().getValues();
  var head = values[0];
  return values.slice(1).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? iso_(r[i]) : r[i]; });
    return o;
  });
}

function findRow_(sh, token) {
  if (!token || !/^s[a-f0-9]{20,64}$/.test(String(token))) return null;
  var all = rows_(sh);
  for (var i = 0; i < all.length; i++) {
    if (all[i].token === token) return { index: i + 2, rec: all[i] };
  }
  return null;
}

function update_(sh, rowIndex, patch) {
  Object.keys(patch).forEach(function (k) {
    var c = COLS.indexOf(k);
    if (c >= 0) sh.getRange(rowIndex, c + 1).setValue(cell_(patch[k]));
  });
}

function publicRow_(r) {
  var url = function (id) { return id ? 'https://drive.google.com/file/d/' + id + '/view' : ''; };
  return {
    token: r.token, number: r.number, template: r.template, version: r.version,
    createdAt: r.createdAt, status: r.status, agentName: r.agentName, phone: r.phone,
    personalId: r.personalId, tgExpected: r.tgExpected, tgUsername: r.tgUsername,
    openedAt: r.openedAt, signedAt: r.signedAt, pdfUrl: url(r.pdfFileId), pdfHash: r.pdfHash,
    deliveredAgent: r.deliveredAgent, link: r.status === 'completed' || r.status === 'cancelled' ? '' : signLink_(r.token)
  };
}

/* ───────────────────────── helpers ───────────────────────── */

function requireAdmin_(p) {
  var key = prop_('ADMIN_KEY');
  if (!key || !safeEqual_(String(p.key || ''), key)) throw userError_('forbidden');
}

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(code) {
  var e = new Error(code);
  e.userError = true;
  return e;
}

/** Строки пишем как текст: иначе Таблица съест ведущие нули личного номера и «+» у телефона. */
function cell_(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' && v !== '' ? "'" + v : v;
}

function clean_(s, max) {
  return String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function iso_(d) { return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); }

function fmt_(d) { return Utilities.formatDate(d, TZ, 'dd.MM.yyyy HH:mm:ss'); }

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function sha256Hex_(data) {
  var d = typeof data === 'string'
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data, Utilities.Charset.UTF_8)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data);
  return hex_(d);
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
