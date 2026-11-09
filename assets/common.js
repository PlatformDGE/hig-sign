/*
 * HiG Sign — общие функции (API, разметка текста договора).
 * Made with Claude (Anthropic) · © Homes in Georgia · Created by Irakli Kvirkvelia
 */
(function (global) {
  'use strict';

  var ERRORS = {
    forbidden: { ru: 'Неверный пароль админ-панели.', ka: 'ადმინ-პანელის პაროლი არასწორია.' },
    not_found: { ru: 'Договор не найден. Проверьте ссылку.', ka: 'ხელშეკრულება ვერ მოიძებნა. შეამოწმეთ ბმული.' },
    cancelled: { ru: 'Этот договор отменён компанией.', ka: 'ეს ხელშეკრულება გაუქმებულია კომპანიის მიერ.' },
    wrong_user: { ru: 'Эта ссылка предназначена для другого Telegram-аккаунта. Откройте её с того аккаунта, который вы сообщили компании.', ka: 'ეს ბმული განკუთვნილია სხვა Telegram-ანგარიშისთვის. გახსენით ის იმ ანგარიშიდან, რომელიც კომპანიას მიაწოდეთ.' },
    bad_init_data: { ru: 'Не удалось подтвердить Telegram. Закройте и откройте ссылку заново.', ka: 'Telegram-ის დადასტურება ვერ მოხერხდა. დახურეთ და თავიდან გახსენით ბმული.' },
    init_data_expired: { ru: 'Сессия устарела. Закройте окно и откройте ссылку заново.', ka: 'სესია ვადაგასულია. დახურეთ ფანჯარა და თავიდან გახსენით ბმული.' },
    no_init_data: { ru: 'Откройте ссылку на договор в Telegram.', ka: 'გახსენით ხელშეკრულების ბმული Telegram-ში.' },
    doc_changed: { ru: 'Текст договора изменился. Обновите страницу.', ka: 'ხელშეკრულების ტექსტი შეიცვალა. განაახლეთ გვერდი.' },
    consent_required: { ru: 'Поставьте отметку согласия.', ka: 'მონიშნეთ თანხმობის ველი.' },
    bad_signature: { ru: 'Распишитесь в поле подписи.', ka: 'მოაწერეთ ხელი ხელმოწერის ველში.' },
    bad_status: { ru: 'Договор уже в другом статусе. Обновите страницу.', ka: 'ხელშეკრულებას სხვა სტატუსი აქვს. განაახლეთ გვერდი.' },
    bot_not_configured: { ru: 'Бот подписи ещё не настроен (SIGN_BOT_TOKEN).', ka: 'ხელმოწერის ბოტი ჯერ არ არის გამართული.' },
    storage_not_configured: { ru: 'Хранилище не настроено: запустите setup() в Apps Script.', ka: 'საცავი არ არის გამართული.' },
    name_required: { ru: 'Укажите ФИО агента.', ka: 'მიუთითეთ აგენტის სახელი და გვარი.' },
    phone_required: { ru: 'Укажите телефон агента.', ka: 'მიუთითეთ აგენტის ტელეფონი.' },
    personal_id_required: { ru: 'Укажите личный номер или номер паспорта.', ka: 'მიუთითეთ პირადი ნომერი ან პასპორტის ნომერი.' },
    bad_telegram: { ru: 'Telegram username: 4–32 символа, латиница, цифры и _.', ka: 'Telegram username: 4–32 სიმბოლო.' },
    already_signed: { ru: 'Договор уже подписан — отменить нельзя.', ka: 'ხელშეკრულება უკვე ხელმოწერილია.' },
    client: { ru: 'Не удалось собрать PDF на этом устройстве. Пришлите скриншот этой ошибки в компанию.', ka: 'PDF-ის შექმნა ამ მოწყობილობაზე ვერ მოხერხდა. გაუგზავნეთ ამ შეცდომის სქრინშოტი კომპანიას.' },
    network: { ru: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', ka: 'სერვერთან კავშირი ვერ დამყარდა. სცადეთ თავიდან.' },
    not_configured: { ru: 'Система ещё не подключена к серверу (API_URL в assets/config.js).', ka: 'სისტემა ჯერ არ არის დაკავშირებული სერვერთან.' }
  };

  function errorText(code, lang) {
    var e = ERRORS[code];
    if (!e) return (lang === 'ka' ? 'შეცდომა: ' : 'Ошибка: ') + code;
    return lang === 'both' ? e.ka + ' / ' + e.ru : e[lang] || e.ru;
  }

  function api(payload) {
    var url = (global.HIG_SIGN_CONFIG || {}).API_URL;
    if (!url) return Promise.reject(codeError('not_configured'));
    return fetch(url, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' })
      .catch(function () { throw codeError('network'); })
      .then(function (r) { return r.json().catch(function () { throw codeError('network'); }); })
      .then(function (data) {
        if (!data || !data.ok) {
          var err = codeError((data && data.error) || 'server_error');
          err.detail = data && data.detail;
          throw err;
        }
        return data;
      });
  }

  function codeError(code) {
    var e = new Error(code);
    e.code = code;
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** "**жирный** текст" → [{text, bold}] */
  function runs(s) {
    var out = [];
    String(s || '').split('**').forEach(function (part, i) {
      if (part) out.push({ text: part, bold: i % 2 === 1 });
    });
    return out;
  }

  function inlineHtml(s) {
    return runs(s).map(function (r) { return r.bold ? '<b>' + esc(r.text) + '</b>' : esc(r.text); }).join('');
  }

  /** HTML договора на одном языке (для чтения в Mini App). */
  function contractHtml(content, lang, extra) {
    extra = extra || {};
    var html = '<h1 class="c-title">' + esc(content.title[lang]) + '</h1>' +
      '<p class="c-num">№ ' + esc(content.number) + '</p>';
    var listOpen = '';
    content.blocks.forEach(function (b) {
      var tag = b.t === 'li' ? 'ul' : b.t === 'oli' ? 'ol' : '';
      if (listOpen && listOpen !== tag) { html += '</' + listOpen + '>'; listOpen = ''; }
      if (tag && !listOpen) { html += '<' + tag + ' class="c-list">'; listOpen = tag; }
      if (b.t === 'h2') html += '<h2>' + inlineHtml(b[lang]) + '</h2>';
      else if (b.t === 'p') html += '<p>' + inlineHtml(b[lang]) + '</p>';
      else if (b.t === 'li') html += '<li>' + inlineHtml(b[lang]) + '</li>';
      else if (b.t === 'oli') html += '<li value="' + parseInt(b.n, 10) + '">' + inlineHtml(b[lang]) + '</li>';
      else if (b.t === 'table') html += tableHtml(b, lang, extra);
    });
    if (listOpen) html += '</' + listOpen + '>';
    return html;
  }

  /** Реквизиты в Mini App: две карточки (Компания / Агент) — на телефоне таблица слишком узкая. */
  function tableHtml(b, lang, extra) {
    var cell = function (v) {
      if (v === '{{signature}}') return extra.signatureHtml || '<i>' + (lang === 'ka' ? 'ხელმოწერა ქვემოთ' : 'подпись ниже') + '</i>';
      if (v === '{{signedAt}}') return esc(extra.signedAtText || (lang === 'ka' ? 'შეივსება ავტომატურად' : 'заполнится автоматически'));
      return esc(v);
    };
    return ['company', 'agent'].map(function (side) {
      var rows = b.rows.filter(function (r) { return r[side] && r[side] !== '—'; });
      return '<div class="c-party"><h4>' + esc(b.head[side][lang]) + '</h4><dl>' + rows.map(function (r) {
        return '<dt>' + esc(r.label[lang]) + '</dt><dd>' + cell(r[side]) + '</dd>';
      }).join('') + '</dl></div>';
    }).join('');
  }

  function bytesToBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  global.HigSign = {
    api: api, esc: esc, runs: runs, inlineHtml: inlineHtml, contractHtml: contractHtml,
    errorText: errorText, codeError: codeError, bytesToBase64: bytesToBase64
  };
})(window);
