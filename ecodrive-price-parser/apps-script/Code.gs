const ECODRIVE_CONFIG = {
  START_ROW: 2,

  NAME_COL: 1,          // A
  URL_COL: 2,           // B
  PRICE_COL: 3,         // C
  STOCK_COL: 4,         // D
  INTERNAL_SKU_COL: 6,  // F

  LAST_CHECK_COL: 9,    // I
  STATUS_COL: 10,       // J
  ECODRIVE_SKU_COL: 11, // K
  PRICE_CHANGE_COL: 12, // L

  HISTORY_SHEET: 'История цен'
};

/**
 * Запустить один раз вручную из Apps Script.
 * Функция сама ищет вкладку, где в колонке B есть ссылки ecodrive.in.ua,
 * поэтому случайно выбранная вкладка "История цен" больше не ломает настройку.
 */
function setupEcoDriveBridge() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Открой Apps Script из нужной Google Таблицы.');

  const sheet = detectSourceSheet_(ss);
  const props = PropertiesService.getScriptProperties();

  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('SOURCE_SHEET', sheet.getName());

  let token = props.getProperty('ECODRIVE_TOKEN');
  if (!token) {
    token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('ECODRIVE_TOKEN', token);
  }

  prepareSourceSheet_(sheet);
  ensureHistorySheet_(ss);

  Logger.log('=== EcoDrive bridge готов ===');
  Logger.log('Таблица: ' + ss.getName());
  Logger.log('Рабочая вкладка: ' + sheet.getName());
  Logger.log('APPS_SCRIPT_TOKEN: ' + token);
  Logger.log('После изменения кода Web App нужно развернуть НОВУЮ версию deployment.');
}

function showEcoDriveBridgeConfig() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('SPREADSHEET_ID: ' + (props.getProperty('SPREADSHEET_ID') || 'НЕ ЗАДАН'));
  Logger.log('SOURCE_SHEET: ' + (props.getProperty('SOURCE_SHEET') || 'НЕ ЗАДАНА'));
  Logger.log('APPS_SCRIPT_TOKEN: ' + (props.getProperty('ECODRIVE_TOKEN') || 'НЕ ЗАДАН'));
}

function regenerateEcoDriveToken() {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('ECODRIVE_TOKEN', token);
  Logger.log('Новый APPS_SCRIPT_TOKEN: ' + token);
}

/**
 * GET /exec?action=list&token=...
 * Возвращает все уже существующие ссылки из основной вкладки.
 */
function doGet(e) {
  try {
    authorize_(String(e && e.parameter && e.parameter.token || ''));
    const action = String(e && e.parameter && e.parameter.action || 'list');
    if (action !== 'list') return json_({ ok: false, error: 'Unknown action' });

    const source = getSourceSheet_();
    const sheet = source.sheet;
    const lastRow = sheet.getLastRow();

    if (lastRow < ECODRIVE_CONFIG.START_ROW) {
      return json_({ ok: true, sheet: sheet.getName(), rows: [] });
    }

    const count = lastRow - ECODRIVE_CONFIG.START_ROW + 1;
    const values = sheet
      .getRange(ECODRIVE_CONFIG.START_ROW, 1, count, ECODRIVE_CONFIG.PRICE_CHANGE_COL)
      .getValues();

    const rows = [];

    values.forEach(function(row, index) {
      const url = String(row[ECODRIVE_CONFIG.URL_COL - 1] || '').trim();
      if (!isEcoDriveUrl_(url)) return;

      rows.push({
        row: ECODRIVE_CONFIG.START_ROW + index,
        name: String(row[ECODRIVE_CONFIG.NAME_COL - 1] || ''),
        url: url,
        oldPrice: toNumber_(row[ECODRIVE_CONFIG.PRICE_COL - 1]),
        oldStock: String(row[ECODRIVE_CONFIG.STOCK_COL - 1] || ''),
        internalSku: String(row[ECODRIVE_CONFIG.INTERNAL_SKU_COL - 1] || '')
      });
    });

    return json_({ ok: true, sheet: sheet.getName(), rows: rows });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  }
}

/**
 * POST action=upsert/update.
 * - существующие товары обновляет;
 * - новые товары, найденные во всех страницах категории, автоматически добавляет;
 * - новый товар добавляется только если он реально "В наличии";
 * - при ошибке старая цена не обнуляется.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e && e.postData && e.postData.contents || '{}');
    authorize_(String(payload.token || ''));

    if (payload.action !== 'update' && payload.action !== 'upsert') {
      return json_({ ok: false, error: 'Unknown action' });
    }
    if (!Array.isArray(payload.updates)) {
      return json_({ ok: false, error: 'updates must be an array' });
    }

    const source = getSourceSheet_();
    const ss = source.ss;
    const sheet = source.sheet;
    const history = ensureHistorySheet_(ss);

    prepareSourceSheet_(sheet);

    let lastRow = sheet.getLastRow();
    const urlToRow = buildUrlRowMap_(sheet);
    const historyRows = [];
    let updated = 0;
    let appended = 0;
    let skippedNewNotInStock = 0;

    payload.updates.forEach(function(item) {
      const incomingUrl = String(item.url || '').trim();
      if (!isEcoDriveUrl_(incomingUrl)) return;

      const normalizedUrl = stripUrl_(incomingUrl);
      const status = String(item.status || 'ERROR: empty status').slice(0, 500);
      const checkedAt = parseDate_(item.checkedAt) || new Date();
      const newStock = normalizeStock_(item.stock);
      const newPrice = toNumber_(item.price);
      const ecodriveSku = String(item.ecodriveSku || '').trim();
      const incomingName = String(item.name || '').trim();

      let row = urlToRow[normalizedUrl] || null;

      // Если URL уже существует — всегда доверяем URL, а не старому номеру строки.
      if (!row && Number.isInteger(Number(item.row))) {
        const candidateRow = Number(item.row);
        if (candidateRow >= ECODRIVE_CONFIG.START_ROW && candidateRow <= sheet.getLastRow()) {
          const candidateUrl = String(sheet.getRange(candidateRow, ECODRIVE_CONFIG.URL_COL).getValue() || '').trim();
          if (stripUrl_(candidateUrl) === normalizedUrl) row = candidateRow;
        }
      }

      // Новый товар из каталога: добавляем только реально доступные товары.
      if (!row) {
        if (status !== 'OK' || newStock !== 'В наличии' || !newPrice || newPrice <= 0) {
          skippedNewNotInStock++;
          return;
        }

        row = Math.max(lastRow + 1, ECODRIVE_CONFIG.START_ROW);
        ensureRows_(sheet, row);

        sheet.getRange(row, ECODRIVE_CONFIG.NAME_COL).setValue(incomingName || 'EcoDrive товар');
        sheet.getRange(row, ECODRIVE_CONFIG.URL_COL).setValue(incomingUrl);
        sheet.getRange(row, ECODRIVE_CONFIG.PRICE_COL).setValue(newPrice);
        sheet.getRange(row, ECODRIVE_CONFIG.STOCK_COL).setValue(newStock);
        sheet.getRange(row, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue(checkedAt);
        sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue('OK');
        if (ecodriveSku) sheet.getRange(row, ECODRIVE_CONFIG.ECODRIVE_SKU_COL).setValue(ecodriveSku);
        sheet.getRange(row, ECODRIVE_CONFIG.PRICE_CHANGE_COL).setValue(0);

        copyFormulaIfPresent_(sheet, row - 1, row, 7); // G
        copyFormulaIfPresent_(sheet, row - 1, row, 8); // H

        historyRows.push([
          checkedAt,
          row,
          '',
          ecodriveSku,
          incomingName || 'EcoDrive товар',
          incomingUrl,
          '',
          newPrice,
          '',
          '',
          newStock
        ]);

        urlToRow[normalizedUrl] = row;
        lastRow = row;
        appended++;
        updated++;
        return;
      }

      // Существующий товар: всегда фиксируем время и статус.
      sheet.getRange(row, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue(checkedAt);
      sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue(status);

      // Ошибка парсинга не должна портить старые данные.
      if (status !== 'OK') {
        updated++;
        return;
      }

      if (!newPrice || newPrice <= 0) {
        sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue('ERROR: invalid price');
        updated++;
        return;
      }

      const oldPrice = toNumber_(sheet.getRange(row, ECODRIVE_CONFIG.PRICE_COL).getValue());
      const oldStock = normalizeStock_(sheet.getRange(row, ECODRIVE_CONFIG.STOCK_COL).getValue());
      const internalSku = String(sheet.getRange(row, ECODRIVE_CONFIG.INTERNAL_SKU_COL).getValue() || '');
      let name = String(sheet.getRange(row, ECODRIVE_CONFIG.NAME_COL).getValue() || '').trim();

      if (!name && incomingName) {
        name = incomingName;
        sheet.getRange(row, ECODRIVE_CONFIG.NAME_COL).setValue(name);
      }

      sheet.getRange(row, ECODRIVE_CONFIG.PRICE_COL).setValue(newPrice);
      if (newStock) sheet.getRange(row, ECODRIVE_CONFIG.STOCK_COL).setValue(newStock);
      if (ecodriveSku) sheet.getRange(row, ECODRIVE_CONFIG.ECODRIVE_SKU_COL).setValue(ecodriveSku);

      const difference = oldPrice ? newPrice - oldPrice : 0;
      sheet.getRange(row, ECODRIVE_CONFIG.PRICE_CHANGE_COL).setValue(difference);

      if (!oldPrice || oldPrice !== newPrice || (newStock && oldStock !== newStock)) {
        historyRows.push([
          checkedAt,
          row,
          internalSku,
          ecodriveSku,
          name || incomingName,
          incomingUrl,
          oldPrice || '',
          newPrice,
          oldPrice ? newPrice - oldPrice : '',
          oldStock,
          newStock || oldStock
        ]);
      }

      updated++;
    });

    if (historyRows.length) {
      const startRow = history.getLastRow() + 1;
      history.getRange(startRow, 1, historyRows.length, historyRows[0].length).setValues(historyRows);
      history.getRange(startRow, 1, historyRows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
    }

    SpreadsheetApp.flush();

    return json_({
      ok: true,
      updated: updated,
      appended: appended,
      skippedNewNotInStock: skippedNewNotInStock,
      historyAdded: historyRows.length
    });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  }
}

function getSourceSheet_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Сначала запусти setupEcoDriveBridge().');

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const storedName = props.getProperty('SOURCE_SHEET');
  let sheet = storedName ? ss.getSheetByName(storedName) : null;

  // Самовосстановление, если setup случайно запускался на "История цен".
  if (!sheet || sheet.getName() === ECODRIVE_CONFIG.HISTORY_SHEET || countEcoDriveUrls_(sheet) === 0) {
    sheet = detectSourceSheet_(ss);
    props.setProperty('SOURCE_SHEET', sheet.getName());
  }

  return { ss: ss, sheet: sheet };
}

function detectSourceSheet_(ss) {
  const active = ss.getActiveSheet();
  if (active && active.getName() !== ECODRIVE_CONFIG.HISTORY_SHEET && countEcoDriveUrls_(active) > 0) {
    return active;
  }

  let bestSheet = null;
  let bestCount = -1;

  ss.getSheets().forEach(function(sheet) {
    if (sheet.getName() === ECODRIVE_CONFIG.HISTORY_SHEET) return;
    const count = countEcoDriveUrls_(sheet);
    if (count > bestCount) {
      bestCount = count;
      bestSheet = sheet;
    }
  });

  if (!bestSheet) throw new Error('Не удалось найти рабочую вкладку.');
  return bestSheet;
}

function countEcoDriveUrls_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < ECODRIVE_CONFIG.START_ROW) return 0;

  const values = sheet
    .getRange(ECODRIVE_CONFIG.START_ROW, ECODRIVE_CONFIG.URL_COL, lastRow - ECODRIVE_CONFIG.START_ROW + 1, 1)
    .getDisplayValues();

  let count = 0;
  values.forEach(function(row) {
    if (isEcoDriveUrl_(String(row[0] || '').trim())) count++;
  });
  return count;
}

function buildUrlRowMap_(sheet) {
  const map = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < ECODRIVE_CONFIG.START_ROW) return map;

  const values = sheet
    .getRange(ECODRIVE_CONFIG.START_ROW, ECODRIVE_CONFIG.URL_COL, lastRow - ECODRIVE_CONFIG.START_ROW + 1, 1)
    .getDisplayValues();

  values.forEach(function(row, index) {
    const url = String(row[0] || '').trim();
    if (isEcoDriveUrl_(url)) map[stripUrl_(url)] = ECODRIVE_CONFIG.START_ROW + index;
  });

  return map;
}

function prepareSourceSheet_(sheet) {
  sheet.getRange(1, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue('Последняя проверка');
  sheet.getRange(1, ECODRIVE_CONFIG.STATUS_COL).setValue('Статус парсера');
  sheet.getRange(1, ECODRIVE_CONFIG.ECODRIVE_SKU_COL).setValue('Артикул EcoDrive');
  sheet.getRange(1, ECODRIVE_CONFIG.PRICE_CHANGE_COL).setValue('Изменение цены');

  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(2, ECODRIVE_CONFIG.LAST_CHECK_COL, maxRows, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, ECODRIVE_CONFIG.PRICE_CHANGE_COL, maxRows, 1).setNumberFormat('+0;-0;0');
}

function ensureHistorySheet_(ss) {
  let sheet = ss.getSheetByName(ECODRIVE_CONFIG.HISTORY_SHEET);
  if (!sheet) sheet = ss.insertSheet(ECODRIVE_CONFIG.HISTORY_SHEET);

  const headers = [
    'Дата', 'Строка', 'Ваш SKU', 'SKU EcoDrive', 'Название', 'Ссылка',
    'Старая цена', 'Новая цена', 'Изменение', 'Старое наличие', 'Новое наличие'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureRows_(sheet, targetRow) {
  if (targetRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), targetRow - sheet.getMaxRows());
  }
}

function copyFormulaIfPresent_(sheet, sourceRow, targetRow, column) {
  if (sourceRow < ECODRIVE_CONFIG.START_ROW) return;
  const formula = sheet.getRange(sourceRow, column).getFormulaR1C1();
  if (formula) sheet.getRange(targetRow, column).setFormulaR1C1(formula);
}

function authorize_(incomingToken) {
  const expected = PropertiesService.getScriptProperties().getProperty('ECODRIVE_TOKEN');
  if (!expected) throw new Error('Token is not configured');
  if (!incomingToken || incomingToken !== expected) throw new Error('Unauthorized');
}

function isEcoDriveUrl_(url) {
  return /^https?:\/\/(www\.)?ecodrive\.in\.ua\//i.test(String(url || '').trim());
}

function stripUrl_(url) {
  return String(url || '')
    .split('#')[0]
    .split('?')[0]
    .replace(/\/+$/, '')
    .toLowerCase();
}

function normalizeStock_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/немає в наявності|нет в наличии|out.?of.?stock/.test(text)) return 'Нет в наличии';
  if (/під замовлення|под заказ|preorder|backorder/.test(text)) return 'Под заказ';
  if (/в наявності|в наличии|in.?stock/.test(text)) return 'В наличии';
  return String(value || '').trim();
}

function toNumber_(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let s = String(value || '')
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');

  if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');

  const number = Number(s);
  return Number.isFinite(number) ? number : 0;
}

function parseDate_(value) {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
