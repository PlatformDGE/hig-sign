/*
 * Сквозной тест HiG Sign v2 в браузере (Playwright + Chromium):
 *   1) NDA: админ создаёт → агент подписывает → Давид подписывает от компании → PDF всем
 *   2) Аренда: админ загружает свой PDF → собственник и арендатор подписывают → PDF с подписями на каждой странице
 * node tests/e2e.test.js
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const { createGas, makeInitData } = require('./gas-harness');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.OUT || path.join(__dirname, 'out');
const API = 'https://script.google.com/macros/s/TEST/exec';
const BOT = '123456:TEST-token_abc';
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

function telegramMock(user, startParam) {
  const initData = makeInitData(BOT, user, startParam);
  return 'window.Telegram={WebApp:{initData:' + JSON.stringify(initData) + ',initDataUnsafe:' +
    JSON.stringify({ user, start_param: startParam }) + ',ready(){},expand(){},disableVerticalSwipes(){},' +
    'enableClosingConfirmation(){},disableClosingConfirmation(){},colorScheme:"light",isVersionAtLeast(){return true},' +
    'requestWriteAccess(cb){window.__wa=1;cb(true)},HapticFeedback:{notificationOccurred(){}}}};';
}

async function wire(page, gas, tgScript) {
  await page.route('**/assets/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.HIG_SIGN_CONFIG={API_URL:' + JSON.stringify(API) + '};' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://api.ipify.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"ip":"203.0.113.7"}' }));
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: tgScript || '' }));
  await page.route(API, (r) => {
    const out = gas.postRaw(r.request().postData() || '');
    r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });
}

async function drawSignature(page, seed) {
  await page.locator('#pad').scrollIntoViewIfNeeded();
  const b = await page.locator('#pad').boundingBox();
  await page.mouse.move(b.x + 30, b.y + 120); await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(b.x + 30 + i * 7, b.y + 110 - Math.sin(i / (3 + seed)) * 45 - (i % 10) * 2);
  }
  await page.mouse.up();
  await page.mouse.move(b.x + 120, b.y + 60); await page.mouse.down();
  await page.mouse.move(b.x + 200 + seed * 20, b.y + 140, { steps: 8 }); await page.mouse.up();
}

/** Открыть ссылку подписанта «в Telegram», расписаться и нажать «Подписать». */
async function signAs(browser, base, gas, user, token, shot, errors) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(user.first_name + ': ' + e.message));
  await wire(page, gas, telegramMock(user, token));
  await page.goto(base + '/sign.html');
  await page.waitForSelector('#main:not([hidden])');
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  assert.strictEqual(await page.isDisabled('#signBtn'), true);
  await drawSignature(page, user.id % 3);
  await page.check('#consent');
  await page.click('#signBtn');
  await page.waitForSelector('#done:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => !/⏳/.test(document.getElementById('doneIcon').textContent), null, { timeout: 60000 });
  return page;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const gas = createGas({ SIGN_BOT_TOKEN: BOT, BOT_USERNAME: 'homesingeorgia_sign_bot', APP_SHORT_NAME: 'sign', ADMIN_CHAT_IDS: '111' });
  gas.ctx.setup();
  const browser = await chromium.launch();
  const errors = [];

  /* ───── Админ: вход ───── */
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await wire(admin, gas);
  await admin.goto(base + '/admin.html');
  await admin.fill('#key', gas.state.props.ADMIN_KEY); await admin.click('#loginBtn');
  await admin.waitForSelector('#app:not([hidden])');
  assert.ok((await admin.textContent('#companyHint')).includes('@davidtibelashvili'));

  /* ───── 1. NDA ───── */
  await admin.fill('#a_name', 'Нино Беридзе');
  await admin.fill('#a_pid', '01001012345');
  await admin.fill('#a_phone', '555 12 34 56');
  await admin.fill('#a_tg', '@Nino_Agent');
  await admin.click('#createBtn');
  await admin.waitForSelector('#result:not([hidden])');
  const ndaLinks = await admin.$$eval('#result code', (els) => els.map((e) => e.textContent));
  assert.strictEqual(ndaLinks.length, 2);
  const waHref = await admin.getAttribute('#result a.btn.wa', 'href');
  assert.ok(waHref.startsWith('https://wa.me/995555123456?text='), waHref);
  const [agentTok, davidTok] = ndaLinks.map((l) => new URL(l).searchParams.get('startapp'));
  await admin.screenshot({ path: path.join(OUT, '1-admin-nda.png'), fullPage: true });
  console.log('  ✓ NDA создан: ссылки для агента и для Давида, кнопки Telegram и WhatsApp');

  const david = { id: 500500, first_name: 'David', username: 'davidtibelashvili', language_code: 'ru' };
  // Давид открывает раньше времени
  const early = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await wire(early, gas, telegramMock(david, davidTok));
  await early.goto(base + '/sign.html');
  await early.waitForSelector('#done:not([hidden])');
  assert.ok((await early.textContent('#doneText')).includes('Нино Беридзе'));
  await early.screenshot({ path: path.join(OUT, '2-david-waits.png') });
  await early.close();
  console.log('  ✓ Давид до подписи агента видит «Сначала подписывает: Нино Беридзе»');

  const agent = { id: 777001, first_name: 'Нино', username: 'Nino_Agent', language_code: 'ka', allows_write_to_pm: true };
  const ag = await signAs(browser, base, gas, agent, agentTok, '3-agent-sign.png', errors);
  assert.ok((await ag.textContent('#doneText')).includes('Давид Тибелашвили'));
  await ag.screenshot({ path: path.join(OUT, '4-agent-waiting.png') });
  const btn = gas.state.fetches.find((f) => f.opts.payload.reply_markup && f.opts.payload.chat_id === '500500');
  assert.ok(btn, 'Давиду ушла кнопка «Подписать»');
  console.log('  ✓ агент подписал → ждём компанию, Давиду пришла кнопка «Подписать»');

  const dv = await signAs(browser, base, gas, david, davidTok, '5-david-sign.png', errors);
  assert.ok((await dv.textContent('#doneTitle')).includes('Договор подписан'), await dv.textContent('#doneText'));
  await dv.screenshot({ path: path.join(OUT, '6-david-done.png') });
  let pdfs = Object.values(gas.state.files).filter((f) => f.blob.type === 'application/pdf' && /NDA/.test(f.blob.name));
  assert.strictEqual(pdfs.length, 1);
  fs.writeFileSync(path.join(OUT, 'nda-signed.pdf'), pdfs[0].blob._buf);
  const ndaDocs = gas.state.fetches.filter((f) => f.url.endsWith('/sendDocument')).map((f) => f.opts.payload.chat_id);
  assert.deepStrictEqual(ndaDocs, ['111', '777001', '500500']);
  console.log('  ✓ Давид подписал → NDA с двумя подписями (' + Math.round(pdfs[0].blob._buf.length / 1024) + ' КБ) отправлен админу, агенту и Давиду');

  /* ───── 2. Аренда: ваш PDF ───── */
  const { PDFDocument, StandardFonts, rgb } = require('/opt/npm-tools/node_modules/pdf-lib');
  const src = await PDFDocument.create();
  const helv = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const pg = src.addPage([595.28, 841.89]);
    pg.drawText('LEASE AGREEMENT — page ' + i, { x: 60, y: 780, size: 20, font: helv, color: rgb(0.1, 0.2, 0.4) });
    for (let l = 0; l < 30; l++) pg.drawText('Clause ' + i + '.' + l + ' The tenant and the owner agree on the terms of this lease.', { x: 60, y: 740 - l * 22, size: 11, font: helv });
    pg.drawText('Bottom text must stay visible (page ' + i + ')', { x: 60, y: 30, size: 11, font: helv, color: rgb(0.8, 0, 0) });
  }
  const srcPath = path.join(OUT, 'lease-source.pdf');
  fs.writeFileSync(srcPath, await src.save());

  await admin.click('.seg button[data-kind="pdf"]');
  await admin.setInputFiles('#pdfFile', srcPath);
  await admin.waitForFunction(() => /страниц: 3/.test(document.getElementById('pdfInfo').textContent), null, { timeout: 60000 });
  await admin.fill('#l_addr', 'Тбилиси, Ваке, ул. Чавчавадзе 1');
  await admin.fill('#l_cad', '01.14.12.001.001');
  await admin.fill('#l_tenant_name', 'Anna Smith'); await admin.fill('#l_tenant_pid', 'P1234567'); await admin.fill('#l_tenant_phone', '+995 599 000 001'); await admin.fill('#l_tenant_tg', 'anna_tenant');
  await admin.fill('#l_owner_name', 'Гиорги Капанадзе'); await admin.fill('#l_owner_pid', '01001000001'); await admin.fill('#l_owner_phone', '599000002');
  await admin.click('#createBtn');
  await admin.waitForSelector('#result:not([hidden])');
  const leaseLinks = await admin.$$eval('#result code', (els) => els.map((e) => e.textContent));
  const [tenTok, ownTok] = leaseLinks.map((l) => new URL(l).searchParams.get('startapp'));
  await admin.screenshot({ path: path.join(OUT, '7-admin-lease.png'), fullPage: true });
  console.log('  ✓ договор аренды создан из PDF (3 стр.), ссылки арендатору и собственнику');

  const owner = { id: 300002, first_name: 'Giorgi', language_code: 'ka' };
  const ow = await signAs(browser, base, gas, owner, ownTok, '8-owner-sign.png', errors);
  assert.ok((await ow.textContent('#doneText')).includes('Anna Smith'));
  const tenant = { id: 300001, first_name: 'Anna', username: 'anna_tenant', language_code: 'ru' };
  const tn = await signAs(browser, base, gas, tenant, tenTok, null, errors);
  assert.ok((await tn.textContent('#doneTitle')).includes('Договор подписан'), await tn.textContent('#doneText') + ' ' + await tn.textContent('#doneErr'));
  pdfs = Object.values(gas.state.files).filter((f) => f.blob.type === 'application/pdf' && /^RENT.*—(?!.*оригинал)/.test(f.blob.name));
  assert.strictEqual(pdfs.length, 1, Object.values(gas.state.files).map((f) => f.blob.name).join(' | '));
  fs.writeFileSync(path.join(OUT, 'lease-signed.pdf'), pdfs[0].blob._buf);
  const signed = await PDFDocument.load(pdfs[0].blob._buf);
  assert.ok(signed.getPageCount() >= 4, 'оригинал 3 стр. + протокол');
  assert.strictEqual(signed.getAuthor(), 'Irakli Kvirkvelia · Homes in Georgia');
  console.log('  ✓ аренда подписана обеими сторонами: ' + signed.getPageCount() + ' стр. (оригинал + протокол)');

  await admin.click('#refresh');
  await admin.waitForFunction(() => document.querySelectorAll('#rows .s-completed').length >= 2);
  await admin.screenshot({ path: path.join(OUT, '9-admin-list.png'), fullPage: true });

  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('\ne2e: passed · ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
