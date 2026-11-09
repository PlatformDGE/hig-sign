/*
 * Тесты бэкенда HiG Sign: node tests/backend.test.js
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 */
'use strict';
const assert = require('assert');
const { createGas, makeInitData } = require('./gas-harness');

const BOT = '123456:TEST-token_abc';
const gas = createGas({ SIGN_BOT_TOKEN: BOT, BOT_USERNAME: 'homesingeorgia_sign_bot', APP_SHORT_NAME: 'sign', ADMIN_CHAT_IDS: '111, -100222' });
gas.ctx.setup();
const KEY = gas.state.props.ADMIN_KEY;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const agentUser = { id: 777001, first_name: 'Нино', last_name: 'Беридзе', username: 'Nino_Agent', language_code: 'ka', allows_write_to_pm: true };
const strangerUser = { id: 999, first_name: 'X', username: 'someone_else' };
const PNG = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64');
const PDF = Buffer.from('%PDF-1.4\n%test\n%%EOF\n').toString('base64');

test('setup создаёт реестр, папку и пароль', () => {
  assert.ok(gas.state.props.SHEET_ID && gas.state.props.FOLDER_ID && KEY.length >= 64);
});

test('админ: неверный пароль → forbidden', () => {
  assert.deepStrictEqual(gas.post({ action: 'adminInfo', key: 'nope' }), { ok: false, error: 'forbidden' });
});

test('админ: adminInfo видит шаблон NDA и настройки', () => {
  const r = gas.post({ action: 'adminInfo', key: KEY });
  assert.ok(r.ok); assert.strictEqual(r.templates[0].id, 'nda-agent');
  assert.deepStrictEqual(r.configured, { bot: true, adminChats: true, storage: true });
});

test('создание: проверка обязательных полей', () => {
  assert.strictEqual(gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'A' }).error, 'phone_required');
  assert.strictEqual(gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'A', phone: '1', personalId: '1', telegram: '@a b' }).error, 'bad_telegram');
});

let env1;
test('создание договора: номер, ссылка Mini App, текст сохранён', () => {
  const r = gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'Нино Беридзе',
    personalId: '01001012345', phone: '+995 555 12 34 56', telegram: '@Nino_Agent' });
  assert.ok(r.ok, JSON.stringify(r));
  env1 = r.envelope;
  assert.match(env1.number, /^NDA-\d{4}-0001$/);
  assert.match(r.link, /^https:\/\/t\.me\/homesingeorgia_sign_bot\/sign\?startapp=s[a-f0-9]{40}$/);
  assert.strictEqual(env1.personalId, '01001012345', 'ведущий ноль сохранён');
  assert.strictEqual(env1.phone, '+995 555 12 34 56');
  const r2 = gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'B', personalId: '2', phone: '3' });
  assert.match(r2.envelope.number, /-0002$/);
});

test('открытие: поддельный initData отклоняется', () => {
  const bad = makeInitData('999:other-bot', agentUser, env1.token);
  assert.strictEqual(gas.post({ action: 'open', token: env1.token, initData: bad }).error, 'bad_init_data');
  const tampered = makeInitData(BOT, agentUser, env1.token).replace('Nino_Agent', 'Hacker');
  assert.strictEqual(gas.post({ action: 'open', token: env1.token, initData: tampered }).error, 'bad_init_data');
});

test('открытие: устаревший initData отклоняется', () => {
  const old = makeInitData(BOT, agentUser, env1.token, Math.floor(Date.now() / 1000) - 2 * 86400);
  assert.strictEqual(gas.post({ action: 'open', token: env1.token, initData: old }).error, 'init_data_expired');
});

test('открытие: чужой Telegram не может открыть договор для @Nino_Agent', () => {
  const r = gas.post({ action: 'open', token: env1.token, initData: makeInitData(BOT, strangerUser, env1.token) });
  assert.strictEqual(r.error, 'wrong_user');
});

let opened;
test('открытие агентом: текст на двух языках, реквизиты Homes in Georgia, уведомление админам', () => {
  const before = gas.state.fetches.length;
  opened = gas.post({ action: 'open', token: env1.token, initData: makeInitData(BOT, agentUser, env1.token) });
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.strictEqual(opened.envelope.status, 'opened');
  assert.strictEqual(String(opened.envelope.tgId), '777001');
  const c = opened.content;
  assert.ok(c.title.ka.includes('ხელშეკრულება') && c.title.ru.includes('Договор-оферта'));
  const all = JSON.stringify(c);
  assert.ok(all.includes('დავით ტიბელაშვილი') && all.includes('Давида Тибелашвили') && all.includes('hge.ge'));
  assert.ok(!/\{\{(agent|doc)\./.test(all), 'все переменные подставлены');
  assert.ok(!/ID-код|юридический адрес/.test(all), 'нет ID-кода и адреса компании');
  const table = c.blocks.find((b) => b.t === 'table');
  assert.strictEqual(table.rows[0].agent, 'Нино Беридзе');
  assert.strictEqual(gas.state.fetches.length - before, 2, 'два админ-чата уведомлены');
});

test('подпись: нужен docHash, согласие и картинка', () => {
  const init = makeInitData(BOT, agentUser, env1.token);
  const base = { action: 'sign', token: env1.token, initData: init, signature: PNG, consent: true, docHash: opened.envelope.docHash };
  assert.strictEqual(gas.post(Object.assign({}, base, { consent: false })).error, 'consent_required');
  assert.strictEqual(gas.post(Object.assign({}, base, { docHash: 'x' })).error, 'doc_changed');
  assert.strictEqual(gas.post(Object.assign({}, base, { signature: 'data:image/jpeg;base64,AAAA' })).error, 'bad_signature');
  assert.strictEqual(gas.post(Object.assign({}, base, { initData: makeInitData(BOT, strangerUser, env1.token) })).error, 'wrong_user');
});

let signed;
test('подпись агентом: время сервера по Тбилиси', () => {
  signed = gas.post({ action: 'sign', token: env1.token, initData: makeInitData(BOT, agentUser, env1.token),
    signature: PNG, consent: true, docHash: opened.envelope.docHash, client: { ip: '203.0.113.7', userAgent: 'UA', timezone: 'Asia/Tbilisi' } });
  assert.ok(signed.ok, JSON.stringify(signed));
  assert.match(signed.signedAtText, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
});

test('финализация: PDF проверяется, сохраняется и уходит админам и агенту', () => {
  const init = makeInitData(BOT, agentUser, env1.token);
  assert.strictEqual(gas.post({ action: 'finalize', token: env1.token, initData: init, pdf: Buffer.from('not a pdf').toString('base64') }).error, 'bad_pdf');
  const before = gas.state.fetches.length;
  const r = gas.post({ action: 'finalize', token: env1.token, initData: init, pdf: PDF });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.pdfHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(r.deliveredAgent, true);
  const sent = gas.state.fetches.slice(before);
  assert.strictEqual(sent.length, 3);
  assert.ok(sent.every((f) => f.url.endsWith('/sendDocument')));
  assert.deepStrictEqual(sent.map((f) => f.opts.payload.chat_id), ['111', '-100222', '777001']);
  const again = gas.post({ action: 'finalize', token: env1.token, initData: init, pdf: PDF });
  assert.ok(again.already);
});

test('после подписания: повторная подпись и отмена невозможны, список показывает PDF', () => {
  const init = makeInitData(BOT, agentUser, env1.token);
  assert.strictEqual(gas.post({ action: 'sign', token: env1.token, initData: init, signature: PNG, consent: true, docHash: opened.envelope.docHash }).error, 'bad_status');
  assert.strictEqual(gas.post({ action: 'cancel', key: KEY, token: env1.token }).error, 'already_signed');
  const list = gas.post({ action: 'list', key: KEY });
  const row = list.items.find((i) => i.token === env1.token);
  assert.strictEqual(row.status, 'completed');
  assert.match(row.pdfUrl, /^https:\/\/drive\.google\.com\/file\/d\//);
  assert.strictEqual(row.link, '');
});

test('отменённый договор не открывается', () => {
  const r = gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'C', personalId: '5', phone: '6' });
  assert.ok(gas.post({ action: 'cancel', key: KEY, token: r.envelope.token }).ok);
  assert.strictEqual(gas.post({ action: 'open', token: r.envelope.token, initData: makeInitData(BOT, strangerUser) }).error, 'cancelled');
});

test('без username: договор привязывается к первому открывшему', () => {
  const r = gas.post({ action: 'create', key: KEY, template: 'nda-agent', agentName: 'D', personalId: '7', phone: '8' });
  const t = r.envelope.token;
  assert.ok(gas.post({ action: 'open', token: t, initData: makeInitData(BOT, strangerUser) }).ok);
  assert.strictEqual(gas.post({ action: 'open', token: t, initData: makeInitData(BOT, agentUser) }).error, 'wrong_user');
});

test('мусор на входе не роняет сервер', () => {
  assert.strictEqual(gas.postRaw('{oops').error, 'bad_json');
  assert.strictEqual(gas.post({ action: 'drop' }).error, 'unknown_action');
  assert.strictEqual(gas.post({ action: 'open', token: '../x', initData: makeInitData(BOT, agentUser) }).error, 'not_found');
});

console.log('\nbackend: ' + passed + ' tests passed');
