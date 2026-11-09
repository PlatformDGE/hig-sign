/*
 * Сквозной тест HiG Sign в браузере: админ создаёт договор → агент подписывает в «Telegram» → PDF.
 * node tests/e2e.test.js  (нужен Playwright + Chromium)
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

function telegramMock(initData, user, startParam) {
  return 'window.Telegram={WebApp:{initData:' + JSON.stringify(initData) + ',initDataUnsafe:' +
    JSON.stringify({ user, start_param: startParam }) + ',ready(){},expand(){},isVersionAtLeast(){return true},' +
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

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const gas = createGas({ SIGN_BOT_TOKEN: BOT, BOT_USERNAME: 'homesingeorgia_sign_bot', APP_SHORT_NAME: 'sign', ADMIN_CHAT_IDS: '111' });
  gas.ctx.setup();
  const browser = await chromium.launch();
  const errors = [];

  // 1. Админ-панель
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await wire(admin, gas);
  await admin.goto(base + '/admin.html');
  await admin.fill('#key', 'wrong'); await admin.click('#loginBtn');
  await admin.waitForSelector('#loginErr:not([hidden])');
  await admin.fill('#key', gas.state.props.ADMIN_KEY); await admin.click('#loginBtn');
  await admin.waitForSelector('#app:not([hidden])');
  await admin.fill('#agentName', 'Нино Беридзе');
  await admin.fill('#personalId', '01001012345');
  await admin.fill('#phone', '+995 555 12 34 56');
  await admin.fill('#telegram', '@Nino_Agent');
  await admin.click('#createBtn');
  await admin.waitForSelector('#result:not([hidden])');
  const link = await admin.textContent('#result code');
  const token = new URL(link).searchParams.get('startapp');
  assert.match(token, /^s[a-f0-9]{40}$/);
  await admin.waitForSelector('#rows .chip');
  await admin.screenshot({ path: path.join(OUT, '1-admin.png'), fullPage: true });
  console.log('  ✓ админ создал договор, ссылка: ' + link);

  // 2. Чужой Telegram-аккаунт
  const stranger = { id: 999, first_name: 'X', username: 'someone_else', language_code: 'ru' };
  const sp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await wire(sp, gas, telegramMock(makeInitData(BOT, stranger, token), stranger, token));
  await sp.goto(base + '/sign.html');
  await sp.waitForSelector('#fatal:not([hidden])');
  assert.ok((await sp.textContent('#fatalText')).includes('другого Telegram'));
  await sp.close();
  console.log('  ✓ чужой аккаунт получил отказ');

  // 3. Агент подписывает
  const agent = { id: 777001, first_name: 'Нино', last_name: 'Беридзе', username: 'Nino_Agent', language_code: 'ka', allows_write_to_pm: false };
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push('sign: ' + e.message));
  await wire(page, gas, telegramMock(makeInitData(BOT, agent, token), agent, token));
  await page.goto(base + '/sign.html');
  await page.waitForSelector('#main:not([hidden])');
  assert.ok((await page.textContent('#contract')).includes('ხელშეკრულება'), 'грузинский текст по language_code=ka');
  await page.screenshot({ path: path.join(OUT, '2-sign-ka.png') });
  await page.click('.tabs button[data-lang="ru"]');
  assert.ok((await page.textContent('#contract')).includes('Давида Тибелашвили'));
  assert.strictEqual(await page.isDisabled('#signBtn'), true);

  const box = await page.locator('#pad').boundingBox();
  await page.locator('#pad').scrollIntoViewIfNeeded();
  const b2 = await page.locator('#pad').boundingBox();
  await page.mouse.move(b2.x + 30, b2.y + 120); await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const x = b2.x + 30 + i * 7, y = b2.y + 110 - Math.sin(i / 4) * 45 - (i % 10) * 2;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  await page.mouse.move(b2.x + 120, b2.y + 60); await page.mouse.down();
  await page.mouse.move(b2.x + 200, b2.y + 140, { steps: 8 }); await page.mouse.up();
  assert.strictEqual(await page.isDisabled('#signBtn'), true, 'без галочки нельзя');
  await page.check('#consent');
  assert.strictEqual(await page.isDisabled('#signBtn'), false);
  await page.screenshot({ path: path.join(OUT, '3-sign-ready.png') });
  await page.click('#signBtn');
  await page.waitForSelector('#done:not([hidden])', { timeout: 60000 });
  assert.strictEqual(await page.evaluate(() => window.__wa), 1, 'запросили право писать в личку');
  await page.screenshot({ path: path.join(OUT, '4-done.png') });
  console.log('  ✓ агент подписал: ' + (await page.textContent('#doneText')));

  // 4. Проверка на сервере
  const row = gas.post({ action: 'list', key: gas.state.props.ADMIN_KEY }).items.find((i) => i.token === token);
  assert.strictEqual(row.status, 'completed');
  const pdfFile = Object.values(gas.state.files).find((f) => f.blob.type === 'application/pdf');
  fs.writeFileSync(path.join(OUT, 'signed.pdf'), pdfFile.blob._buf);
  assert.strictEqual(pdfFile.blob._buf.slice(0, 5).toString(), '%PDF-');
  const docs = gas.state.fetches.filter((f) => f.url.endsWith('/sendDocument')).map((f) => f.opts.payload.chat_id);
  assert.deepStrictEqual(docs, ['111', '777001']);
  console.log('  ✓ PDF сохранён (' + Math.round(pdfFile.blob._buf.length / 1024) + ' КБ) и отправлен админу и агенту');

  // 5. Повторное открытие — «уже подписан»
  await page.reload();
  await page.waitForSelector('#done:not([hidden])');
  console.log('  ✓ повторное открытие показывает «подписан»');

  await admin.click('#refresh');
  await admin.waitForSelector('.s-completed');
  await admin.screenshot({ path: path.join(OUT, '5-admin-after.png'), fullPage: true });

  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('\ne2e: passed · ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
