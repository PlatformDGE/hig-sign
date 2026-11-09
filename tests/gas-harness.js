/*
 * Эмулятор Google Apps Script для тестов HiG Sign (Node).
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => (b + 256) % 256)));

function makeBlob(data, type, name) {
  const buf = toBuf(data || []);
  return {
    _buf: buf, type, name,
    getBytes: () => toSigned(buf),
    getDataAsString: () => buf.toString('utf8'),
    copyBlob: () => makeBlob(toSigned(buf), type, name),
    getName: () => name
  };
}

function createGas(props) {
  const state = { props: Object.assign({}, props), files: {}, folders: {}, sheets: {}, fetches: [] };
  let seq = 0;
  const id = (p) => p + (++seq);

  function folder(fid) {
    return {
      getId: () => fid,
      getFoldersByName(name) {
        const hits = Object.values(state.folders).filter((f) => f.parent === fid && f.name === name);
        let i = 0;
        return { hasNext: () => i < hits.length, next: () => folder(hits[i++].id) };
      },
      createFolder(name) { const nid = id('fld'); state.folders[nid] = { id: nid, name, parent: fid }; return folder(nid); },
      createFile(a, content, mime) {
        const fidn = id('file');
        const blob = typeof a === 'string' ? makeBlob(content, mime, a) : a;
        state.files[fidn] = { id: fidn, folder: fid, blob };
        return { getId: () => fidn };
      }
    };
  }

  // Таблица: state.sheets[ssId] = { name, tabs: { tabName: [[...rows]] } }
  function sheet(ssId, tab) {
    const book = state.sheets[ssId];
    const data = () => book.tabs[tab];
    const strip = (v) => (typeof v === 'string' && v[0] === "'" ? v.slice(1) : v);
    const width = () => data().reduce((m, r) => Math.max(m, r.length), 0);
    return {
      setName(n) { book.tabs[n] = book.tabs[tab]; delete book.tabs[tab]; tab = n; },
      setFrozenRows() {},
      appendRow(row) { data().push(row.map(strip)); },
      getDataRange: () => ({ getValues: () => { const w = width(); return data().map((r) => Array.from({ length: w }, (_, i) => (r[i] === undefined ? '' : r[i]))); } }),
      getMaxRows: () => 1000,
      getLastColumn: () => width(),
      getRange(r, c, nr, nc) {
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < (nr || 1); i++) {
              const row = data()[r - 1 + i] || [];
              out.push(Array.from({ length: nc || 1 }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j])));
            }
            return out;
          },
          setValues(v) {
            v.forEach((vals, i) => {
              while (data().length < r + i) data().push([]);
              vals.forEach((x, j) => { data()[r - 1 + i][c - 1 + j] = strip(x); });
            });
          },
          setValue(v) { while (data().length < r) data().push([]); data()[r - 1][c - 1] = strip(v); },
          setNumberFormat() {}
        };
      }
    };
  }

  const fmtParts = (d, tz) => {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p;
  };

  const ctx = {
    console,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      computeDigest: (alg, data) => toSigned(crypto.createHash(alg).update(toBuf(data)).digest()),
      newBlob: makeBlob,
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      base64Encode: (b) => toBuf(b).toString('base64'),
      getUuid: () => crypto.randomUUID(),
      formatDate(d, tz, f) {
        const p = fmtParts(d, tz === 'UTC' ? 'UTC' : tz);
        return f.replace(/'([^']*)'/g, '\u0000$1\u0001')
          .replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second)
          .replace(/\u0000([^\u0001]*)\u0001/g, '$1');
      }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (state.props[k] === undefined ? null : state.props[k]),
      setProperty: (k, v) => { state.props[k] = v; }
    }) },
    SpreadsheetApp: {
      create(name) { const sid = id('sheet'); state.sheets[sid] = { name, tabs: { 'Лист1': [] } }; return { getId: () => sid, getSheets: () => [sheet(sid, 'Лист1')] }; },
      openById: (sid) => ({
        getSheetByName: (n) => (state.sheets[sid].tabs[n] ? sheet(sid, n) : null),
        insertSheet: (n) => { state.sheets[sid].tabs[n] = []; return sheet(sid, n); }
      })
    },
    DriveApp: {
      createFolder(name) { const fid = id('fld'); state.folders[fid] = { id: fid, name, parent: null }; return folder(fid); },
      getFolderById: folder,
      getFileById: (fid) => ({ getBlob: () => state.files[fid].blob, moveTo() {} })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch(url, opts) { state.fetches.push({ url, opts }); return { getContentText: () => '{"ok":true}' }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }) }
  };
  vm.createContext(ctx);
  ['Templates.gs', 'Code.gs'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  });
  const post = (payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
  return { ctx, state, post, postRaw: (s) => JSON.parse(ctx.doPost({ postData: { contents: s } }).body) };
}

/** initData так, как его подписывает Telegram. */
function makeInitData(botToken, user, startParam, authDate) {
  const fields = {
    query_id: 'AAH' + crypto.randomBytes(6).toString('hex'),
    user: JSON.stringify(user),
    auth_date: String(authDate || Math.floor(Date.now() / 1000)),
    signature: crypto.randomBytes(32).toString('base64url')
  };
  if (startParam) { fields.start_param = startParam; fields.chat_type = 'sender'; fields.chat_instance = '-123456789'; }
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  fields.hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}

module.exports = { createGas, makeInitData };
