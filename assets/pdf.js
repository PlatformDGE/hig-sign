/*
 * HiG Sign — сборка подписанного PDF прямо в браузере подписанта.
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 *
 * Страницы A4 рисуются на canvas (грузинский слева, русский справа, подпись внизу каждой
 * страницы, последний лист — протокол подписания), затем упаковываются в PDF (JPEG-страницы).
 * Внешних библиотек нет: грузинский и русский шрифты рисует сам браузер.
 */
(function (global) {
  'use strict';

  var W = 1240, H = 1754;            // A4 @150 dpi
  var PT_W = 595.28, PT_H = 841.89;  // A4 в пунктах PDF
  var M = 80, GUT = 36;
  var TOP = 165, BOTTOM = H - 200;
  var COL = (W - 2 * M - GUT) / 2;
  var NAVY = '#1D3560', RED = '#D52B1E', INK = '#1a1f2b', GREY = '#6b7280', LINE = '#c9d1e0';
  var FONT = "'Noto Sans', 'Noto Sans Georgian', 'DejaVu Sans', Arial, sans-serif";
  var S = { body: 19, lh: 27, h2: 21, title: 25, small: 15 };

  function font(size, bold) { return (bold ? '700 ' : '400 ') + size + 'px ' + FONT; }

  /* ───── перенос строк с жирными фрагментами ───── */
  function wrap(ctx, runs, width, size) {
    var tokens = [];
    runs.forEach(function (r) {
      r.text.split(/(\s+)/).forEach(function (w) { if (w) tokens.push({ text: w, bold: r.bold, space: /^\s+$/.test(w) }); });
    });
    var lines = [], line = [], lw = 0;
    function measure(t) { ctx.font = font(size, t.bold); return ctx.measureText(t.text).width; }
    function push() {
      while (line.length && line[line.length - 1].space) { lw -= line[line.length - 1].w; line.pop(); }
      if (line.length) lines.push(line);
      line = []; lw = 0;
    }
    tokens.forEach(function (t) {
      if (t.space) {
        if (!line.length) return;
        t = { text: ' ', bold: t.bold, space: true };
      }
      t.w = measure(t);
      if (!t.space && lw + t.w > width && line.length) push();
      if (!t.space && t.w > width) {           // очень длинное слово (хэш) — режем по символам
        var chunk = '';
        for (var i = 0; i < t.text.length; i++) {
          var c = chunk + t.text[i];
          ctx.font = font(size, t.bold);
          if (ctx.measureText(c).width > width && chunk) {
            line.push({ text: chunk, bold: t.bold, w: ctx.measureText(chunk).width }); push(); chunk = t.text[i];
          } else chunk = c;
        }
        t = { text: chunk, bold: t.bold, w: ctx.measureText(chunk).width };
      }
      line.push(t); lw += t.w;
    });
    push();
    return lines;
  }

  function drawLine(ctx, line, x, y, size, color) {
    ctx.fillStyle = color || INK;
    line.forEach(function (t) { ctx.font = font(size, t.bold); ctx.fillText(t.text, x, y); x += t.w; });
  }

  function runs(s, bold) {
    return bold ? [{ text: String(s || '').replace(/\*\*/g, ''), bold: true }] : global.HigSign.runs(s);
  }

  /* ───── раскладка по страницам ───── */
  function Layout(ctx) {
    this.ctx = ctx; this.pages = []; this.newPage();
  }
  Layout.prototype.newPage = function () { this.page = []; this.pages.push(this.page); this.y = TOP; };
  Layout.prototype.room = function () { return BOTTOM - this.y; };

  /** Двуязычный блок: две колонки строк, переносятся на следующую страницу построчно. */
  Layout.prototype.bilingual = function (b) {
    var ctx = this.ctx, isH = b.t === 'h2';
    var size = isH ? S.h2 : S.body, lh = isH ? 30 : S.lh;
    var indent = (b.t === 'li' || b.t === 'oli') ? 30 : 0;
    var cols = ['ka', 'ru'].map(function (lang) {
      return wrap(ctx, runs(b[lang], isH), COL - indent, size);
    });
    if (isH) {
      var need = Math.max(cols[0].length, cols[1].length) * lh + 3 * S.lh + 14;
      if (this.room() < need) this.newPage(); else this.y += 12;
    }
    var idx = [0, 0], first = true;
    while (idx[0] < cols[0].length || idx[1] < cols[1].length) {
      var fit = Math.floor(this.room() / lh);
      if (fit < 2) { this.newPage(); continue; }
      var taken = 0;
      for (var c = 0; c < 2; c++) {
        var x = M + c * (COL + GUT) + indent;
        var n = Math.min(fit, cols[c].length - idx[c]);
        for (var i = 0; i < n; i++) {
          var lineNo = idx[c] + i;
          this.page.push({ k: 'line', line: cols[c][lineNo], x: x, y: this.y + (i + 1) * lh - 7, size: size, color: isH ? NAVY : INK });
          if (lineNo === 0 && indent) {
            this.page.push({ k: 'text', text: b.t === 'oli' ? b.n : '•', x: x - indent + 4, y: this.y + lh - 7, size: size, bold: b.t === 'oli' });
          }
        }
        idx[c] += n; taken = Math.max(taken, n);
      }
      this.y += taken * lh;
      first = false;
      if (idx[0] < cols[0].length || idx[1] < cols[1].length) this.newPage();
    }
    this.y += isH ? 8 : (b.t === 'li' || b.t === 'oli' ? 4 : 12);
  };

  Layout.prototype.title = function (content) {
    var ctx = this.ctx, self = this;
    var cols = ['ka', 'ru'].map(function (l) { return wrap(ctx, [{ text: content.title[l], bold: true }], COL, S.title); });
    var n = Math.max(cols[0].length, cols[1].length);
    cols.forEach(function (lines, c) {
      lines.forEach(function (ln, i) {
        self.page.push({ k: 'line', line: ln, x: M + c * (COL + GUT), y: self.y + (i + 1) * 34 - 8, size: S.title, color: NAVY });
      });
    });
    this.y += n * 34 + 10;
    this.page.push({ k: 'text', text: '№ ' + content.number, x: M, y: this.y + 20, size: S.body, bold: true, color: RED });
    this.y += 44;
  };

  /** Таблица реквизитов на всю ширину; подпись агента — картинкой в ячейке. */
  Layout.prototype.table = function (b, ctx2) {
    var ctx = this.ctx, self = this;
    var widths = [0.30, 0.35, 0.35].map(function (f) { return (W - 2 * M) * f; });
    var pad = 12, size = 17, lh = 24;
    var head = [['', ''], [b.head.company.ka, b.head.company.ru], [b.head.agent.ka, b.head.agent.ru]];
    var rows = [{ head: true, cells: head.map(function (h) { return h[0] ? h[0] + ' / ' + h[1] : ''; }) }];
    b.rows.forEach(function (r) {
      rows.push({ cells: [r.label.ka + ' / ' + r.label.ru, r.company, r.agent] });
    });
    rows.forEach(function (r) {
      var cellLines = r.cells.map(function (v, i) {
        if (v === '{{signature}}') return 'SIG';
        if (v === '{{signedAt}}') v = ctx2.signedAtText + ' (Asia/Tbilisi)';
        return wrap(ctx, [{ text: String(v), bold: !!r.head || i === 0 }], widths[i] - 2 * pad, size);
      });
      var hgt = Math.max.apply(null, cellLines.map(function (l) { return l === 'SIG' ? 3.6 : l.length; })) * lh + 2 * pad;
      if (self.room() < hgt) self.newPage();
      var x = M;
      cellLines.forEach(function (lines, i) {
        self.page.push({ k: 'rect', x: x, y: self.y, w: widths[i], h: hgt, fill: r.head ? '#eef2f8' : (i === 0 ? '#f7f9fc' : null) });
        if (lines === 'SIG') {
          self.page.push({ k: 'sig', x: x + pad, y: self.y + pad, w: widths[i] - 2 * pad, h: hgt - 2 * pad });
        } else {
          lines.forEach(function (ln, j) {
            self.page.push({ k: 'line', line: ln, x: x + pad, y: self.y + pad + (j + 1) * lh - 6, size: size, color: r.head ? NAVY : INK });
          });
        }
        x += widths[i];
      });
      self.y += hgt;
    });
    this.y += 16;
  };

  /* ───── рисование ───── */
  function fitImage(ctx, img, x, y, w, h) {
    if (!img || !img.width || !img.height) return;
    var r = Math.min(w / img.width, h / img.height);
    var dw = img.width * r, dh = img.height * r;
    ctx.drawImage(img, x, y + (h - dh) / 2, dw, dh);
  }

  function drawPage(ctx, items, n, total, d) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    // шапка
    if (d.logo) fitImage(ctx, d.logo, M, 52, 190, 60);
    ctx.textAlign = 'right';
    ctx.font = font(S.small, true); ctx.fillStyle = NAVY;
    ctx.fillText('№ ' + d.content.number, W - M, 74);
    ctx.font = font(S.small, false); ctx.fillStyle = GREY;
    ctx.fillText('hge.ge · HiG Sign', W - M, 98);
    ctx.textAlign = 'left';
    ctx.fillStyle = NAVY; ctx.fillRect(M, 128, W - 2 * M, 3);
    ctx.fillStyle = RED; ctx.fillRect(M, 128, 60, 3);

    items.forEach(function (it) {
      if (it.k === 'line') drawLine(ctx, it.line, it.x, it.y, it.size, it.color);
      else if (it.k === 'text') { ctx.font = font(it.size, it.bold); ctx.fillStyle = it.color || INK; ctx.fillText(it.text, it.x, it.y); }
      else if (it.k === 'rect') {
        if (it.fill) { ctx.fillStyle = it.fill; ctx.fillRect(it.x, it.y, it.w, it.h); }
        ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.strokeRect(it.x, it.y, it.w, it.h);
      } else if (it.k === 'sig') fitImage(ctx, d.signature, it.x, it.y, it.w, it.h);
    });

    // подвал: подпись на каждой странице
    var fy = H - 170;
    ctx.fillStyle = LINE; ctx.fillRect(M, fy, W - 2 * M, 1.5);
    ctx.font = font(S.small, false); ctx.fillStyle = GREY;
    ctx.fillText('აგენტის ხელმოწერა / Подпись Агента:', M, fy + 34);
    ctx.font = font(S.small, true); ctx.fillStyle = INK;
    ctx.fillText(d.signerName, M, fy + 58);
    fitImage(ctx, d.signature, M + 330, fy + 10, 260, 80);
    ctx.textAlign = 'right';
    ctx.font = font(S.small, false); ctx.fillStyle = GREY;
    ctx.fillText('გვ. / Стр. ' + n + ' / ' + total, W - M, fy + 34);
    ctx.fillText(d.signedAtText + ' (Tbilisi)', W - M, fy + 58);
    ctx.textAlign = 'left';
    ctx.font = font(13, false); ctx.fillStyle = GREY;
    ctx.fillText('SHA-256: ' + d.docHash, M, fy + 118);
    ctx.fillText('Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia', M, fy + 140);
  }

  function auditItems(ctx, d) {
    var L = new Layout(ctx);
    var a = d.audit;
    L.page.push({ k: 'text', text: 'ელექტრონული ხელმოწერის ოქმი', x: M, y: TOP + 26, size: S.title, bold: true, color: NAVY });
    L.page.push({ k: 'text', text: 'Протокол электронного подписания', x: M, y: TOP + 62, size: S.title, bold: true, color: NAVY });
    L.y = TOP + 90;
    var rows = [
      ['დოკუმენტი / Документ', '№ ' + d.content.number + ' · ' + d.content.title.ru],
      ['შაბლონი / Шаблон', d.content.template + ' v' + d.content.version],
      ['ხელმომწერი / Подписант', d.signerName],
      ['პირადი ნომერი / Личный номер', a.personalId],
      ['ტელეფონი / Телефон', a.phone],
      ['Telegram (დადასტურებული / подтверждён)', (a.tgUsername ? '@' + a.tgUsername + ' · ' : '') + 'ID ' + a.tgId],
      ['ხელმოწერის დრო (სერვერი) / Время подписания (сервер)', d.signedAtText + ' (Asia/Tbilisi)'],
      ['IP-მისამართი / IP-адрес', a.ip || '—'],
      ['მოწყობილობა / Устройство', a.userAgent || '—'],
      ['საათის სარტყელი / Часовой пояс', a.timezone || '—'],
      ['დოკუმენტის ჰეში / Хэш документа (SHA-256)', d.docHash]
    ];
    var widths = [(W - 2 * M) * 0.36, (W - 2 * M) * 0.64], pad = 12, size = 17, lh = 24;
    rows.forEach(function (r) {
      var c0 = wrap(ctx, [{ text: r[0], bold: true }], widths[0] - 2 * pad, size);
      var c1 = wrap(ctx, [{ text: String(r[1]), bold: false }], widths[1] - 2 * pad, size);
      var hgt = Math.max(c0.length, c1.length) * lh + 2 * pad;
      L.page.push({ k: 'rect', x: M, y: L.y, w: widths[0], h: hgt, fill: '#f7f9fc' });
      L.page.push({ k: 'rect', x: M + widths[0], y: L.y, w: widths[1], h: hgt });
      c0.forEach(function (ln, j) { L.page.push({ k: 'line', line: ln, x: M + pad, y: L.y + pad + (j + 1) * lh - 6, size: size, color: NAVY }); });
      c1.forEach(function (ln, j) { L.page.push({ k: 'line', line: ln, x: M + widths[0] + pad, y: L.y + pad + (j + 1) * lh - 6, size: size }); });
      L.y += hgt;
    });
    L.y += 30;
    [
      'ხელმომწერმა გაეცნო ხელშეკრულების სრულ ტექსტს, მონიშნა თანხმობის ველი და ეკრანზე საკუთარი ხელით მოაწერა ხელი. ხელმომწერის ვინაობა დადასტურებულია Telegram-ის მეშვეობით: Mini App-ის მონაცემები შემოწმებულია Telegram-ის ციფრული ხელმოწერით Homes in Georgia-ს სერვერზე.',
      'Подписант ознакомился с полным текстом договора, поставил отметку согласия и собственноручно расписался на экране. Личность подписанта подтверждена через Telegram: данные Mini App проверены цифровой подписью Telegram на сервере Homes in Georgia.'
    ].forEach(function (t) {
      wrap(ctx, [{ text: t, bold: false }], W - 2 * M, S.body).forEach(function (ln) {
        L.page.push({ k: 'line', line: ln, x: M, y: L.y + S.lh - 7, size: S.body }); L.y += S.lh;
      });
      L.y += 14;
    });
    L.page.push({ k: 'sig', x: M, y: L.y + 10, w: 420, h: 140 });
    return L.page;
  }

  /* ───── PDF из JPEG-страниц ───── */
  function dataUrlBytes(url) {
    var b64 = url.split(',')[1], bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function pdfString(s) {
    // UTF-16BE с BOM — для метаданных с кириллицей
    var hex = 'FEFF';
    for (var i = 0; i < s.length; i++) hex += ('000' + s.charCodeAt(i).toString(16)).slice(-4);
    return '<' + hex.toUpperCase() + '>';
  }

  function makePdf(jpegs, info) {
    var enc = new TextEncoder(), parts = [], offsets = [], len = 0;
    function add(x) { var b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; }
    function obj(n, body) { offsets[n] = len; add(n + ' 0 obj\n'); body(); add('\nendobj\n'); }
    var nPages = jpegs.length, kids = [];
    for (var i = 0; i < nPages; i++) kids.push((4 + i * 3) + ' 0 R');
    add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, function () { add('<< /Type /Catalog /Pages 2 0 R >>'); });
    obj(2, function () { add('<< /Type /Pages /Count ' + nPages + ' /Kids [' + kids.join(' ') + '] >>'); });
    obj(3, function () {
      add('<< /Title ' + pdfString(info.title) + ' /Author ' + pdfString('Irakli Kvirkvelia · Homes in Georgia') +
        ' /Subject ' + pdfString(info.subject) + ' /Producer ' + pdfString('HiG Sign · Made with Claude (Anthropic)') +
        ' /CreationDate (D:' + info.date + ') >>');
    });
    jpegs.forEach(function (jpg, i) {
      var p = 4 + i * 3;
      obj(p, function () {
        add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PT_W + ' ' + PT_H + '] /Resources << /XObject << /Im' + i + ' ' +
          (p + 1) + ' 0 R >> >> /Contents ' + (p + 2) + ' 0 R >>');
      });
      obj(p + 1, function () {
        add('<< /Type /XObject /Subtype /Image /Width ' + W + ' /Height ' + H +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n');
        add(jpg); add('\nendstream');
      });
      var cs = 'q ' + PT_W + ' 0 0 ' + PT_H + ' 0 0 cm /Im' + i + ' Do Q';
      obj(p + 2, function () { add('<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream'); });
    });
    var nObj = 4 + nPages * 3, xref = len;
    var x = 'xref\n0 ' + nObj + '\n0000000000 65535 f \n';
    for (var n = 1; n < nObj; n++) x += ('000000000' + offsets[n]).slice(-10) + ' 00000 n \n';
    add(x + 'trailer\n<< /Size ' + nObj + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (b) { out.set(b, o); o += b.length; });
    return out;
  }

  function loadImage(src) {
    return new Promise(function (res) {
      if (!src) return res(null);
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = src;
    });
  }

  function loadFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = ['400', '700'].map(function (w) {
      return Promise.all([
        document.fonts.load(w + ' 19px "Noto Sans"', 'Договор Homes'),
        document.fonts.load(w + ' 19px "Noto Sans Georgian"', 'ხელშეკრულება')
      ]);
    });
    var timeout = new Promise(function (res) { setTimeout(res, 4000); });
    return Promise.race([Promise.all(loads), timeout]).catch(function () {});
  }

  /**
   * d = { content, docHash, signerName, signedAtText, signatureDataUrl, logoUrl,
   *       audit: {personalId, phone, tgId, tgUsername, ip, userAgent, timezone} }
   * → Promise<Uint8Array> (готовый PDF)
   */
  function buildSignedPdf(d) {
    return loadFonts().then(function () {
      return Promise.all([loadImage(d.signatureDataUrl), loadImage(d.logoUrl)]);
    }).then(function (imgs) {
      d.signature = imgs[0]; d.logo = imgs[1];
      var canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');
      ctx.textBaseline = 'alphabetic';

      var L = new Layout(ctx);
      L.title(d.content);
      d.content.blocks.forEach(function (b) {
        if (b.t === 'table') L.table(b, d); else L.bilingual(b);
      });
      var pages = L.pages.filter(function (p) { return p.length; });
      pages.push(auditItems(ctx, d));

      var jpegs = pages.map(function (items, i) {
        drawPage(ctx, items, i + 1, pages.length, d);
        return dataUrlBytes(canvas.toDataURL('image/jpeg', 0.75));
      });
      var now = new Date(), pad = function (n) { return ('0' + n).slice(-2); };
      return makePdf(jpegs, {
        title: d.content.number + ' — ' + d.content.title.ru,
        subject: 'Signed by ' + d.signerName + ' · SHA-256 ' + d.docHash,
        date: now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
          pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
      });
    });
  }

  global.HigSignPdf = { buildSignedPdf: buildSignedPdf, makePdf: makePdf };
})(window);
