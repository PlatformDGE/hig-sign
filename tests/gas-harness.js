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

  function sheet(sid) {
    const s = state.sheets[sid];
    const strip = (v) => (typeof v === 'string' && v[0] === "'" ? v.slice(1) : v);
    return {
      setName(n) { s.name = n; }, setFrozenRows() {},
      appendRow(row) { s.data.push(row.map(strip)); },
      getDataRange: () => ({ getValues: () => s.data.map((r) => r.slice()) }),
      getMaxRows: () => 1000,
      getRange(r, c) {
        return {
          setValues(v) { v.forEach((row, i) => { s.data[r - 1 + i] = row.map(strip); }); },
          setValue(v) { while (s.data.length < r) s.data.push([]); s.data[r - 1][c - 1] = strip(v); },
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
      create(name) { const sid = id('sheet'); state.sheets[sid] = { name, data: [] }; return { getId: () => sid, getSheets: () => [sheet(sid)] }; },
      openById: (sid) => ({ getSheetByName: () => sheet(sid) })
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
