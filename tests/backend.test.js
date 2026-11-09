/*
 * Тесты бэкенда HiG Sign v2: node tests/backend.test.js
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
const init = (user, token) => makeInitData(BOT, user, token);

const agentUser = { id: 777001, first_name: 'Нино', username: 'Nino_Agent', language_code: 'ka' };
const david = { id: 500500, first_name: 'David', username: 'davidtibelashvili' };
const tenantUser = { id: 300001, first_name: 'Anna', username: 'anna_tenant' };
const ownerUser = { id: 300002, first_name: 'Giorgi' };
const stranger = { id: 999, first_name: 'X', username: 'someone_else' };
const PNG = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64');
const PDF = Buffer.from('%PDF-1.4\n%test\n%%EOF\n').toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.from('jpegdata').toString('base64');

test('setup: реестр, листы Envelopes и Signers, пароль', () => {
  const book = gas.state.sheets[gas.state.props.SHEET_ID];
  assert.ok(book.tabs.Envelopes[0].includes('kind') && book.tabs.Signers[0].includes('envelopeId'));
  assert.ok(KEY.length >= 64);
});

test('админ: неверный пароль → forbidden; adminInfo знает подписанта компании', () => {
  assert.strictEqual(gas.post({ action: 'adminInfo', key: 'nope' }).error, 'forbidden');
  const r = gas.post({ action: 'adminInfo', key: KEY });
  assert.strictEqual(r.company.signerTg, 'davidtibelashvili');
  assert.strictEqual(r.configured.whatsapp, false);
});

/* ───── NDA: агент → компания ───── */
let nda, agentTok, davidTok;
test('NDA: создаётся с двумя подписантами по очереди', () => {
  const r = gas.post({ action: 'create', key: KEY, kind: 'template', template: 'nda-agent',
    agentName: 'Нино Беридзе', personalId: '01001012345', phone: '+995 555 12 34 56', telegram: '@Nino_Agent' });
  assert.ok(r.ok, JSON.stringify(r));
  nda = r.envelope;
  assert.match(nda.number, /^NDA-\d{4}-0001$/);
  assert.deepStrictEqual(nda.signers.map((s) => [s.role, s.order, s.tgExpected]), [['agent', 1, 'Nino_Agent'], ['company', 2, 'davidtibelashvili']]);
  assert.match(nda.signers[0].link, /startapp=s[a-f0-9]{40}$/);
  assert.strictEqual(nda.signers[0].personalId, '01001012345');
  agentTok = nda.signers[0].token; davidTok = nda.signers[1].token;
});

test('NDA: компания не может подписать раньше агента', () => {
  const o = gas.post({ action: 'open', token: davidTok, initData: init(david, davidTok) });
  assert.ok(o.ok);
  assert.strictEqual(o.waitingFor[0].name, 'Нино Беридзе');
  assert.ok(!o.content, 'текст не отдаём, пока не очередь');
  const s = gas.post({ action: 'sign', token: davidTok, initData: init(david, davidTok), signature: PNG, consent: true, docHash: 'x' });
  assert.strictEqual(s.error, 'not_your_turn');
  assert.strictEqual(gas.state.props.COMPANY_SIGNER_CHAT_ID, '500500', 'chat id Давида запомнен');
});

test('NDA: чужой и поддельный Telegram не проходят', () => {
  assert.strictEqual(gas.post({ action: 'open', token: agentTok, initData: init(stranger, agentTok) }).error, 'wrong_user');
  assert.strictEqual(gas.post({ action: 'open', token: agentTok, initData: makeInitData('9:x', agentUser, agentTok) }).error, 'bad_init_data');
  const old = makeInitData(BOT, agentUser, agentTok, Math.floor(Date.now() / 1000) - 2 * 86400);
  assert.strictEqual(gas.post({ action: 'open', token: agentTok, initData: old }).error, 'init_data_expired');
});

let openedAgent;
test('NDA: агент открывает — текст на двух языках, в реквизитах две подписи', () => {
  openedAgent = gas.post({ action: 'open', token: agentTok, initData: init(agentUser, agentTok) });
  assert.ok(openedAgent.ok, JSON.stringify(openedAgent));
  const all = JSON.stringify(openedAgent.content);
  assert.ok(all.includes('დავით ტიბელაშვილი') && all.includes('Давида Тибелашвили'));
  assert.ok(all.includes('{{signature:company}}') && all.includes('{{signature:agent}}'));
  assert.strictEqual(openedAgent.content.version, '1.1');
});

test('NDA: проверки при подписи', () => {
  const b = { action: 'sign', token: agentTok, initData: init(agentUser, agentTok), signature: PNG, consent: true, docHash: openedAgent.envelope.docHash };
  assert.strictEqual(gas.post(Object.assign({}, b, { consent: false })).error, 'consent_required');
  assert.strictEqual(gas.post(Object.assign({}, b, { docHash: 'x' })).error, 'doc_changed');
  assert.strictEqual(gas.post(Object.assign({}, b, { signature: 'data:image/jpeg;base64,AA' })).error, 'bad_signature');
});

test('NDA: агент подписал → ждём компанию, Давиду пришла кнопка «Подписать»', () => {
  const before = gas.state.fetches.length;
  const r = gas.post({ action: 'sign', token: agentTok, initData: init(agentUser, agentTok), signature: PNG, consent: true,
    docHash: openedAgent.envelope.docHash, client: { ip: '203.0.113.7', userAgent: 'UA', timezone: 'Asia/Tbilisi' } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!r.final, 'PDF ещё рано');
  const msgs = gas.state.fetches.slice(before).map((f) => f.opts.payload);
  const toDavid = msgs.find((m) => m.chat_id === '500500');
  assert.ok(toDavid && JSON.parse(toDavid.reply_markup).inline_keyboard[0][0].url.endsWith(davidTok));
  assert.ok(msgs.some((m) => m.chat_id === '111' && m.text.includes(davidTok)), 'админам тоже ссылка');
});

let davidFinal;
test('NDA: Давид подписывает последним → получает данные для PDF (обе подписи)', () => {
  const o = gas.post({ action: 'open', token: davidTok, initData: init(david, davidTok) });
  assert.ok(!o.waitingFor && o.content);
  const r = gas.post({ action: 'sign', token: davidTok, initData: init(david, davidTok), signature: PNG, consent: true, docHash: o.envelope.docHash });
  assert.ok(r.ok && r.final, JSON.stringify(r));
  assert.deepStrictEqual(r.final.signers.map((s) => s.role), ['agent', 'company']);
  assert.ok(r.final.signers.every((s) => s.signature.startsWith('data:image/png;base64,')));
  assert.strictEqual(r.final.signers[0].ip, '203.0.113.7');
  davidFinal = r.final;
});

test('NDA: если PDF не дошёл — повторное открытие снова отдаёт данные для PDF', () => {
  const o = gas.post({ action: 'open', token: davidTok, initData: init(david, davidTok) });
  assert.ok(o.final && o.final.signers.length === 2);
});

test('NDA: финализация — PDF админам, агенту и Давиду', () => {
  const before = gas.state.fetches.length;
  assert.strictEqual(gas.post({ action: 'finalize', token: davidTok, initData: init(david, davidTok), pdf: Buffer.from('nope').toString('base64') }).error, 'bad_pdf');
  const r = gas.post({ action: 'finalize', token: davidTok, initData: init(david, davidTok), pdf: PDF });
  assert.ok(r.ok && /^[a-f0-9]{64}$/.test(r.pdfHash));
  const docs = gas.state.fetches.slice(before).filter((f) => f.url.endsWith('/sendDocument')).map((f) => f.opts.payload.chat_id);
  assert.deepStrictEqual(docs, ['111', '-100222', '777001', '500500']);
  assert.ok(gas.post({ action: 'finalize', token: agentTok, initData: init(agentUser, agentTok), pdf: PDF }).already);
  const row = gas.post({ action: 'list', key: KEY }).items.find((i) => i.id === nda.id);
  assert.strictEqual(row.status, 'completed');
  assert.ok(row.signers.every((s) => s.status === 'signed' && !s.link));
  assert.strictEqual(gas.post({ action: 'cancel', key: KEY, id: nda.id }).error, 'already_signed');
});

/* ───── Аренда: ваш PDF, арендатор + собственник ───── */
let lease, tenTok, ownTok;
test('аренда: проверки при создании', () => {
  const base = { action: 'create', key: KEY, kind: 'pdf', pdf: PDF, pages: [JPG, JPG],
    signers: [{ role: 'tenant', name: 'Anna', personalId: 'P123', phone: '+995 599 000 001', telegram: 'anna_tenant' },
      { role: 'owner', name: 'Гиорги', personalId: '01001000001', phone: '+995 599 000 002' }] };
  assert.strictEqual(gas.post(Object.assign({}, base, { pdf: Buffer.from('x').toString('base64') })).error, 'bad_pdf');
  assert.strictEqual(gas.post(Object.assign({}, base, { pages: [] })).error, 'bad_pages');
  assert.strictEqual(gas.post(Object.assign({}, base, { signers: [base.signers[0]] })).error, 'two_signers_required');
  assert.strictEqual(gas.post(Object.assign({}, base, { signers: [{ role: 'company', name: 'x', phone: '1', personalId: '1' }, base.signers[1]] })).error, 'bad_role');
  const r = gas.post(Object.assign({}, base, { address: 'Тбилиси, Ваке', cadastral: '01.14.12.001.001', fileName: 'lease.pdf' }));
  assert.ok(r.ok, JSON.stringify(r));
  lease = r.envelope;
  assert.match(lease.number, /^RENT-\d{4}-0001$/);
  assert.strictEqual(lease.meta.cadastral, '01.14.12.001.001');
  assert.ok(lease.signers.every((s) => s.order === 1 && s.link));
  [tenTok, ownTok] = lease.signers.map((s) => s.token);
});

test('аренда: оба подписывают в любом порядке; страницы оригинала показываются', () => {
  const o = gas.post({ action: 'open', token: ownTok, initData: init(ownerUser, ownTok) });
  assert.ok(o.ok && o.pages.length === 2 && !o.content && !o.waitingFor);
  const s1 = gas.post({ action: 'sign', token: ownTok, initData: init(ownerUser, ownTok), signature: PNG, consent: true, docHash: o.envelope.docHash });
  assert.ok(s1.ok && !s1.final);
  assert.strictEqual(gas.post({ action: 'open', token: tenTok, initData: init(stranger, tenTok) }).error, 'wrong_user');
  const t = gas.post({ action: 'open', token: tenTok, initData: init(tenantUser, tenTok) });
  const s2 = gas.post({ action: 'sign', token: tenTok, initData: init(tenantUser, tenTok), signature: PNG, consent: true, docHash: t.envelope.docHash });
  assert.ok(s2.final && s2.final.source === PDF, 'последний получает оригинал PDF');
  assert.deepStrictEqual(s2.final.signers.map((x) => x.role).sort(), ['owner', 'tenant']);
  const f = gas.post({ action: 'finalize', token: tenTok, initData: init(tenantUser, tenTok), pdf: PDF });
  assert.ok(f.ok && f.deliveredAgent === true);
});

test('отменённый договор не открывается', () => {
  const r = gas.post({ action: 'create', key: KEY, kind: 'template', template: 'nda-agent', agentName: 'C', personalId: '5', phone: '6' });
  assert.ok(gas.post({ action: 'cancel', key: KEY, id: r.envelope.id }).ok);
  const t = r.envelope.signers[0].token;
  assert.strictEqual(gas.post({ action: 'open', token: t, initData: init(stranger, t) }).error, 'cancelled');
});

test('обновление со старой версии: старые строки не мешают', () => {
  const g = createGas({ SIGN_BOT_TOKEN: BOT, BOT_USERNAME: 'b', APP_SHORT_NAME: 'sign' });
  g.ctx.setup();
  const book = g.state.sheets[g.state.props.SHEET_ID];
  // как в v1: свой набор колонок и одна старая строка, лист Signers отсутствует
  book.tabs.Envelopes = [['token', 'number', 'template', 'status', 'agentName'], ['s123', 'NDA-2026-0001', 'nda-agent', 'signed', 'Old']];
  delete book.tabs.Signers;
  const k = g.state.props.ADMIN_KEY;
  assert.deepStrictEqual(g.post({ action: 'list', key: k }).items, []);
  const r = g.post({ action: 'create', key: k, kind: 'template', template: 'nda-agent', agentName: 'New', personalId: '1', phone: '2' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.envelope.number, /-0002$/, 'нумерация продолжается после старых');
  assert.ok(book.tabs.Envelopes[0].slice(0, 5).join() === 'token,number,template,status,agentName' && book.tabs.Envelopes[0].includes('kind'));
  assert.ok(book.tabs.Signers);
});

test('мусор на входе не роняет сервер', () => {
  assert.strictEqual(gas.postRaw('{oops').error, 'bad_json');
  assert.strictEqual(gas.post({ action: 'drop' }).error, 'unknown_action');
  assert.strictEqual(gas.post({ action: 'open', token: '../x', initData: init(agentUser) }).error, 'not_found');
});

console.log('\nbackend: ' + passed + ' tests passed');
