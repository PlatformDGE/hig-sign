/**
 * HiG Sign — система электронной подписи Homes in Georgia (бэкенд, Google Apps Script).
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 *
 * Версия 2: несколько подписантов в одном договоре.
 *   • NDA агента (шаблон) — подписывают агент, затем компания (Давид Тибелашвили).
 *   • Договор аренды (ваш готовый PDF) — подписывают арендатор и собственник.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   SIGN_BOT_TOKEN, BOT_USERNAME, APP_SHORT_NAME, ADMIN_KEY, ADMIN_CHAT_IDS — как раньше
 *   COMPANY_SIGNER_TG — @username подписанта от компании (по умолчанию davidtibelashvili)
 *   SHEET_ID, FOLDER_ID — создаются функцией setup(); COMPANY_SIGNER_CHAT_ID — запоминается сам
 *
 * Все запросы — POST с JSON (text/plain):
 *   {action:'adminInfo'|'create'|'list'|'cancel', key, ...}   — админ-панель
 *   {action:'open'|'sign'|'finalize', token, initData, ...}   — Mini App подписанта
 */

var TZ = 'Asia/Tbilisi';
var INIT_DATA_MAX_AGE_SEC = 24 * 3600;
var COMPANY = {
  name: 'Homes in Georgia',
  rep: { ka: 'დამფუძნებელი დავით ტიბელაშვილი', ru: 'основатель Давид Тибелашвили' },
  signer: { ka: 'დავით ტიბელაშვილი', ru: 'Давид Тибелашвили', tg: 'davidtibelashvili' },
  site: 'hge.ge',
  crm: 'CRM Homes in Georgia (Rent in Tbilisi CRM)'
};
var ROLES = {
  agent: { ka: 'აგენტი', ru: 'Агент' },
  company: { ka: 'კომპანია', ru: 'Компания' },
  tenant: { ka: 'დამქირავებელი', ru: 'Арендатор' },
  owner: { ka: 'მესაკუთრე', ru: 'Собственник' }
};
var LEASE = { prefix: 'RENT', title: { ka: 'ქირავნობის ხელშეკრულება', ru: 'Договор аренды' } };
var ENV_COLS = ['id', 'number', 'kind', 'template', 'version', 'createdAt', 'status', 'note', 'meta',
  'docHash', 'contentFileId', 'sourceFileId', 'pagesFileId', 'pageCount', 'pdfFileId', 'pdfHash',
  'deliveredAdmin', 'completedAt'];
var SIG_COLS = ['token', 'envelopeId', 'role', 'order', 'name', 'phone', 'personalId', 'channel',
  'tgExpected', 'tgId', 'tgUsername', 'tgName', 'status', 'openedAt', 'signedAt',
  'ip', 'userAgent', 'timezone', 'signatureFileId', 'deliveredTg'];

/* ───────────────────────── entry points ───────────────────────── */

function doGet() {
  return json_({ ok: true, service: 'HiG Sign', version: 2 });
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

/** Запустить один раз вручную: создаёт реестр, папку на Диске и пароль админ-панели. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder('HiG Sign — подписанные договоры').getId());
  }
  if (!props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create('HiG Sign — реестр договоров');
    ss.getSheets()[0].setName('Envelopes');
    props.setProperty('SHEET_ID', ss.getId());
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(props.getProperty('FOLDER_ID')));
  }
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  envTable_(); sigTable_();
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
    roles: ROLES,
    company: { name: COMPANY.name, signer: COMPANY.signer.ru, signerTg: companyTg_() },
    configured: {
      bot: !!prop_('SIGN_BOT_TOKEN') && !!prop_('BOT_USERNAME') && !!prop_('APP_SHORT_NAME'),
      adminChats: adminChats_().length > 0,
      storage: !!prop_('SHEET_ID') && !!prop_('FOLDER_ID'),
      whatsapp: false
    },
    registryUrl: prop_('SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + prop_('SHEET_ID') : ''
  };
}

function create_(p) {
  requireAdmin_(p);
  var kind = p.kind === 'pdf' ? 'pdf' : 'template';
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var env = envTable_(), sig = sigTable_();
    var now = new Date();
    var rec = { id: newToken_('e'), kind: kind, createdAt: iso_(now), status: 'sent', note: clean_(p.note, 300) };
    var signers;

    if (kind === 'template') {
      var tpl = TEMPLATES[p.template];
      if (!tpl) throw userError_('unknown_template');
      var agent = person_(p, 'agent');
      signers = [
        signerRec_(agent, 'agent', 1),
        signerRec_({ name: COMPANY.signer.ru, phone: '', personalId: '', telegram: companyTg_() }, 'company', 2)
      ];
      rec.number = nextNumber_(env, tpl.prefix, now);
      rec.template = tpl.id; rec.version = tpl.version;
      var content = render_(tpl, agent, { number: rec.number, date: Utilities.formatDate(now, TZ, 'dd.MM.yyyy') });
      var contentJson = JSON.stringify(content);
      rec.docHash = sha256Hex_(contentJson);
      rec.contentFileId = folder_('content').createFile(rec.number + '.json', contentJson, 'application/json').getId();
    } else {
      var pdfB64 = String(p.pdf || '');
      if (!pdfB64 || pdfB64.length > 14 * 1024 * 1024) throw userError_('bad_pdf');
      var bytes = Utilities.base64Decode(pdfB64);
      if (!isPdf_(bytes)) throw userError_('bad_pdf');
      var pages = Array.isArray(p.pages) ? p.pages : [];
      if (!pages.length || pages.length > 40) throw userError_('bad_pages');
      pages.forEach(function (pg) { if (!/^data:image\/jpeg;base64,/.test(String(pg))) throw userError_('bad_pages'); });
      var list = Array.isArray(p.signers) ? p.signers : [];
      signers = list.map(function (s, i) {
        var role = ROLES[s.role] && s.role !== 'company' && s.role !== 'agent' ? s.role : null;
        if (!role) throw userError_('bad_role');
        return signerRec_(person_(s, role), role, 1);
      });
      if (signers.length < 2) throw userError_('two_signers_required');
      rec.number = nextNumber_(env, LEASE.prefix, now);
      rec.template = 'lease-pdf'; rec.version = '';
      rec.meta = JSON.stringify({ title: clean_(p.title, 160) || LEASE.title.ru, address: clean_(p.address, 200), cadastral: clean_(p.cadastral, 60), fileName: clean_(p.fileName, 160) });
      rec.docHash = sha256Hex_(bytes);
      rec.pageCount = pages.length;
      rec.sourceFileId = folder_('source').createFile(Utilities.newBlob(bytes, 'application/pdf', rec.number + ' — оригинал.pdf')).getId();
      rec.pagesFileId = folder_('pages').createFile(rec.number + '-pages.json', JSON.stringify(pages), 'application/json').getId();
    }

    append_(env, ENV_COLS, rec);
    signers.forEach(function (s) { s.envelopeId = rec.id; append_(sig, SIG_COLS, s); });
    return { envelope: envelopeOut_(rec, signers) };
  } finally {
    lock.releaseLock();
  }
}

function list_(p) {
  requireAdmin_(p);
  var signers = rows_(sigTable_());
  var items = rows_(envTable_()).filter(function (r) { return r.id; }).map(function (r) {
    return envelopeOut_(r, signers.filter(function (s) { return s.envelopeId === r.id; }));
  }).reverse().slice(0, 300);
  return { items: items };
}

function cancel_(p) {
  requireAdmin_(p);
  var env = envTable_();
  var found = find_(env, 'id', p.id);
  if (!found) throw userError_('not_found');
  if (found.rec.status === 'completed') throw userError_('already_signed');
  update_(env, found.index, { status: 'cancelled' });
  return {};
}

/* ───────────────────────── signer (Telegram Mini App) ───────────────────────── */

function open_(p) {
  var user = verifyInitData_(p.initData);
  var ctx = load_(p.token);
  if (ctx.env.rec.status === 'cancelled') throw userError_('cancelled');
  var me = ctx.me.rec;
  checkSigner_(me, user);

  if (!me.tgId) {
    var patch = {
      tgId: String(user.id), tgUsername: user.username || '',
      tgName: [user.first_name, user.last_name].filter(Boolean).join(' '),
      openedAt: iso_(new Date()), status: me.status === 'sent' ? 'opened' : me.status
    };
    update_(ctx.sig, ctx.me.index, patch);
    for (var k in patch) me[k] = patch[k];
    if (me.role === 'company') PropertiesService.getScriptProperties().setProperty('COMPANY_SIGNER_CHAT_ID', String(user.id));
    notifyAdmins_('👀 ' + ctx.env.rec.number + ' — ' + me.name + ' (' + ROLES[me.role].ru + ') открыл(а) договор' +
      (user.username ? ' (@' + user.username + ')' : '') + '.');
  }

  var env = ctx.env.rec;
  var out = {
    envelope: { id: env.id, number: env.number, kind: env.kind, status: env.status, docHash: env.docHash,
      meta: env.meta ? JSON.parse(env.meta) : null, pdfHash: env.pdfHash },
    me: signerOut_(me),
    signers: ctx.all.map(signerOut_)
  };
  var waiting = waitingFor_(ctx.all, me);
  if (waiting.length && me.status !== 'signed') {
    out.waitingFor = waiting.map(signerOut_);
    return out;
  }
  if (env.status === 'completed') return out;
  if (env.kind === 'template') {
    out.content = JSON.parse(DriveApp.getFileById(env.contentFileId).getBlob().getDataAsString('UTF-8'));
  } else {
    out.pages = JSON.parse(DriveApp.getFileById(env.pagesFileId).getBlob().getDataAsString('UTF-8'));
  }
  if (env.status === 'ready' && me.status === 'signed') out.final = finalData_(env, ctx.all);
  return out;
}

function sign_(p) {
  var user = verifyInitData_(p.initData);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ctx = load_(p.token);
    var env = ctx.env.rec, me = ctx.me.rec;
    checkSigner_(me, user);
    if (String(me.tgId) !== String(user.id)) throw userError_('wrong_user');
    if (env.status === 'cancelled') throw userError_('cancelled');
    if (env.status === 'completed') throw userError_('bad_status');
    if (waitingFor_(ctx.all, me).length) throw userError_('not_your_turn');
    if (p.consent !== true) throw userError_('consent_required');
    if (p.docHash !== env.docHash) throw userError_('doc_changed');
    var m = /^data:image\/png;base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.signature || ''));
    if (!m || m[1].length > 400000) throw userError_('bad_signature');

    var now = new Date();
    var file = folder_('signatures').createFile(
      Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/png', env.number + '-' + me.role + '.png'));
    var info = p.client || {};
    var patch = {
      status: 'signed', signedAt: iso_(now), signatureFileId: file.getId(),
      ip: clean_(info.ip, 64), userAgent: clean_(info.userAgent, 300), timezone: clean_(info.timezone, 64)
    };
    update_(ctx.sig, ctx.me.index, patch);
    for (var k in patch) me[k] = patch[k];

    var allSigned = ctx.all.every(function (s) { return s.status === 'signed'; });
    update_(ctx.env.table, ctx.env.index, { status: allSigned ? 'ready' : 'signing' });
    env.status = allSigned ? 'ready' : 'signing';
    notifyAdmins_('✍️ ' + env.number + ' — подписал(а) ' + me.name + ' (' + ROLES[me.role].ru + ').' +
      (allSigned ? ' Все подписали, собираем PDF.' : ''));
    if (!allSigned) notifyNext_(env, ctx.all);

    var out = { signedAt: iso_(now), signedAtText: fmt_(now), signers: ctx.all.map(signerOut_) };
    if (allSigned) out.final = finalData_(env, ctx.all);
    return out;
  } finally {
    lock.releaseLock();
  }
}

function finalize_(p) {
  var user = verifyInitData_(p.initData);
  var ctx = load_(p.token);
  var env = ctx.env.rec, me = ctx.me.rec;
  if (String(me.tgId) !== String(user.id)) throw userError_('wrong_user');
  if (env.status === 'completed') return { pdfHash: env.pdfHash, already: true };
  if (env.status !== 'ready') throw userError_('bad_status');

  var b64 = String(p.pdf || '');
  if (!b64 || b64.length > 30 * 1024 * 1024) throw userError_('bad_pdf');
  var bytes = Utilities.base64Decode(b64);
  if (!isPdf_(bytes)) throw userError_('bad_pdf');
  var pdfHash = sha256Hex_(bytes);
  var names = ctx.all.map(function (s) { return s.name; }).join(', ');
  var pdf = Utilities.newBlob(bytes, 'application/pdf', env.number + ' — ' + names + '.pdf');
  var pdfFile = folder_('pdf').createFile(pdf);

  var caption = '✅ Подписан договор ' + env.number + '\n' +
    ctx.all.map(function (s) { return ROLES[s.role].ru + ': ' + s.name + ' — ' + fmt_(new Date(s.signedAt)); }).join('\n') +
    '\nSHA-256 PDF: ' + pdfHash.slice(0, 16) + '…';
  var deliveredAdmin = 0;
  adminChats_().forEach(function (id) { if (sendDocument_(id, pdf, caption)) deliveredAdmin++; });

  var mine = false;
  ctx.all.forEach(function (s, i) {
    if (!s.tgId) return;
    var ok = sendDocument_(s.tgId, pdf, '✅ ხელშეკრულება ხელმოწერილია / Договор подписан\n' + env.number +
      ' · Homes in Georgia\nშეინახეთ ეს ფაილი / Сохраните этот файл.');
    update_(ctx.sig, ctx.allIdx[i], { deliveredTg: ok ? 'yes' : 'no' });
    if (String(s.tgId) === String(user.id)) mine = ok;
  });

  update_(ctx.env.table, ctx.env.index, {
    status: 'completed', pdfFileId: pdfFile.getId(), pdfHash: pdfHash,
    deliveredAdmin: deliveredAdmin, completedAt: iso_(new Date())
  });
  return { pdfHash: pdfHash, deliveredAgent: mine };
}

/* ───────────────────────── helpers: envelopes & signers ───────────────────────── */

function load_(token) {
  var sig = sigTable_();
  var me = find_(sig, 'token', token);
  if (!me) throw userError_('not_found');
  var env = envTable_();
  var e = find_(env, 'id', me.rec.envelopeId);
  if (!e) throw userError_('not_found');
  var pairs = [];
  rows_(sig).forEach(function (r, i) { if (r.envelopeId === e.rec.id) pairs.push({ r: r, idx: i + 2 }); });
  pairs.sort(function (a, b) { return Number(a.r.order) - Number(b.r.order); });
  var all = pairs.map(function (x) { return x.r; });
  // своя запись — тот же объект, что и в all, чтобы правки были видны везде
  var mine = all.filter(function (r) { return r.token === token; })[0];
  return {
    sig: sig, env: { table: env, index: e.index, rec: e.rec }, me: { index: me.index, rec: mine },
    all: all, allIdx: pairs.map(function (x) { return x.idx; })
  };
}

function waitingFor_(all, me) {
  return all.filter(function (s) { return Number(s.order) < Number(me.order) && s.status !== 'signed'; });
}

/** Следующим по очереди (подписант компании) — уведомление со ссылкой. */
function notifyNext_(env, all) {
  all.forEach(function (s) {
    if (s.status === 'signed' || waitingFor_(all, s).length) return;
    var prior = all.filter(function (x) { return Number(x.order) < Number(s.order); });
    if (!prior.length) return;  // этот подписант и так получил ссылку при создании
    var text = '🖊 ' + env.number + ': ' + prior.map(function (x) { return x.name; }).join(', ') +
      ' подписал(а). Теперь подпись: ' + s.name + ' (' + ROLES[s.role].ru + ').';
    var chat = s.tgId || (s.role === 'company' ? prop_('COMPANY_SIGNER_CHAT_ID') : '');
    if (chat) {
      tg_('sendMessage', { chat_id: String(chat), text: text,
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Подписать / ხელმოწერა', url: signLink_(s.token) }]] }) });
    }
    notifyAdmins_(text + '\nСсылка: ' + signLink_(s.token));
  });
}

function finalData_(env, all) {
  var data = {
    signers: all.map(function (s) {
      var o = signerOut_(s);
      o.ip = s.ip; o.userAgent = s.userAgent; o.timezone = s.timezone;
      o.signature = 'data:image/png;base64,' + Utilities.base64Encode(DriveApp.getFileById(s.signatureFileId).getBlob().getBytes());
      return o;
    })
  };
  if (env.kind === 'pdf') data.source = Utilities.base64Encode(DriveApp.getFileById(env.sourceFileId).getBlob().getBytes());
  return data;
}

function signerRec_(person, role, order) {
  return {
    token: newToken_('s'), role: role, order: order, name: person.name, phone: person.phone,
    personalId: person.personalId, channel: 'telegram', tgExpected: person.telegram, status: 'sent'
  };
}

function person_(p, role) {
  var o = {
    name: clean_(p.name !== undefined ? p.name : p.agentName, 120),
    phone: clean_(p.phone, 40),
    personalId: clean_(p.personalId, 40),
    telegram: clean_(p.telegram, 64).replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '')
  };
  if (!o.name) throw userError_('name_required');
  if (!o.phone) throw userError_('phone_required');
  if (!o.personalId) throw userError_('personal_id_required');
  if (o.telegram && !/^[A-Za-z0-9_]{4,32}$/.test(o.telegram)) throw userError_('bad_telegram');
  return o;
}

function signerOut_(s) {
  return {
    token: s.token, role: s.role, roleLabel: ROLES[s.role], order: Number(s.order), name: s.name,
    phone: s.phone, personalId: s.personalId, tgExpected: s.tgExpected, tgUsername: s.tgUsername, tgId: s.tgId,
    status: s.status, signedAt: s.signedAt, signedAtText: s.signedAt ? fmt_(new Date(s.signedAt)) : ''
  };
}

function envelopeOut_(r, signers) {
  var url = function (id) { return id ? 'https://drive.google.com/file/d/' + id + '/view' : ''; };
  var closed = r.status === 'completed' || r.status === 'cancelled';
  return {
    id: r.id, number: r.number, kind: r.kind, template: r.template, version: r.version,
    createdAt: r.createdAt, status: r.status, note: r.note, meta: r.meta ? JSON.parse(r.meta) : null,
    pdfUrl: url(r.pdfFileId), sourceUrl: url(r.sourceFileId), pdfHash: r.pdfHash,
    signers: signers.slice().sort(function (a, b) { return Number(a.order) - Number(b.order); }).map(function (s) {
      var o = signerOut_(s);
      o.link = closed || s.status === 'signed' ? '' : signLink_(s.token);
      return o;
    })
  };
}

function nextNumber_(env, prefix, now) {
  var p = prefix + '-' + Utilities.formatDate(now, TZ, 'yyyy') + '-';
  var n = 0;
  rows_(env).forEach(function (r) { if (String(r.number).indexOf(p) === 0) n++; });
  return p + ('000' + (n + 1)).slice(-4);
}

function companyTg_() {
  return String(prop_('COMPANY_SIGNER_TG') || COMPANY.signer.tg).replace(/^@/, '');
}

/* ───────────────────────── rendering (NDA) ───────────────────────── */

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
    head: { label: { ka: '', ru: '' }, company: ROLES.company, agent: ROLES.agent },
    rows: [
      { label: { ka: 'დასახელება / სახელი, გვარი', ru: 'Наименование / ФИО' }, company: COMPANY.name, agent: agent.name },
      { label: { ka: 'წარმომადგენელი', ru: 'Представитель' }, company: COMPANY.rep.ka + ' / ' + COMPANY.rep.ru, agent: dash },
      { label: { ka: 'ვებგვერდი / CRM', ru: 'Сайт / CRM' }, company: COMPANY.site + ' · ' + COMPANY.crm, agent: dash },
      { label: { ka: 'პირადი ნომერი', ru: 'Личный номер' }, company: dash, agent: agent.personalId },
      { label: { ka: 'ტელეფონი / Telegram', ru: 'Телефон / Telegram' }, company: dash,
        agent: agent.phone + (agent.telegram ? ' · @' + agent.telegram : '') },
      { label: { ka: 'ხელმოწერა', ru: 'Подпись' }, company: '{{signature:company}}', agent: '{{signature:agent}}' },
      { label: { ka: 'ხელმოწერის თარიღი და დრო', ru: 'Дата и время подписания' }, company: '{{signedAt:company}}', agent: '{{signedAt:agent}}' }
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

function envTable_() { return table_('Envelopes', ENV_COLS); }
function sigTable_() { return table_('Signers', SIG_COLS); }

/** Лист с нужными колонками; недостающие колонки и лист создаются сами (обновление со старой версии). */
function table_(name, cols) {
  var id = prop_('SHEET_ID');
  if (!id) throw userError_('storage_not_configured');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  }
  var lastCol = sh.getLastColumn();
  var head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  if (head.length && head.every(function (h) { return !h; })) head = [];
  var missing = cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, head.length + 1, sh.getMaxRows(), missing.length).setNumberFormat('@');
    head = head.concat(missing);
  }
  return { sh: sh, head: head };
}

function rows_(t) {
  var values = t.sh.getDataRange().getValues();
  return values.slice(1).map(function (r) {
    var o = {};
    t.head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? iso_(r[i]) : (r[i] === undefined ? '' : r[i]); });
    return o;
  });
}

function find_(t, col, value) {
  if (!value || !/^[es][a-f0-9]{20,64}$/.test(String(value))) return null;
  var all = rows_(t);
  for (var i = 0; i < all.length; i++) if (all[i][col] === value) return { index: i + 2, rec: all[i] };
  return null;
}

function append_(t, cols, rec) {
  t.sh.appendRow(t.head.map(function (h) { return cell_(rec[h]); }));
}

function update_(t, rowIndex, patch) {
  Object.keys(patch).forEach(function (k) {
    var c = t.head.indexOf(k);
    if (c >= 0) t.sh.getRange(rowIndex, c + 1).setValue(cell_(patch[k]));
  });
}

function folder_(sub) {
  var root = DriveApp.getFolderById(prop_('FOLDER_ID'));
  var it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
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

function newToken_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function isPdf_(b) {
  return b && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
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
