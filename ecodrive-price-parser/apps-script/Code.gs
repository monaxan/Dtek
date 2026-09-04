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
 * Запустить ОДИН раз вручную из Apps Script.
 * Сохраняет ID таблицы, текущую вкладку и создаёт секретный токен.
 */
function setupEcoDriveBridge() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss) {
    throw new Error('Откройте Apps Script именно из нужной Google Таблицы.');
  }

  const sheet = ss.getActiveSheet();
  const props = PropertiesService.getScriptProperties();

  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('SOURCE_SHEET', sheet.getName());

  let token = props.getProperty('ECODRIVE_TOKEN');

  if (!token) {
    token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('ECODRIVE_TOKEN', token);
  }

  sheet.getRange(1, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue('Последняя проверка');
  sheet.getRange(1, ECODRIVE_CONFIG.STATUS_COL).setValue('Статус парсера');
  sheet.getRange(1, ECODRIVE_CONFIG.ECODRIVE_SKU_COL).setValue('Артикул EcoDrive');
  sheet.getRange(1, ECODRIVE_CONFIG.PRICE_CHANGE_COL).setValue('Изменение цены');

  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);

  sheet
    .getRange(2, ECODRIVE_CONFIG.LAST_CHECK_COL, maxRows, 1)
    .setNumberFormat('dd.MM.yyyy HH:mm');

  sheet
    .getRange(2, ECODRIVE_CONFIG.PRICE_CHANGE_COL, maxRows, 1)
    .setNumberFormat('+0;-0;0');

  ensureHistorySheet_(ss);

  Logger.log('=== EcoDrive bridge готов ===');
  Logger.log('Таблица: ' + ss.getName());
  Logger.log('Вкладка: ' + sheet.getName());
  Logger.log('APPS_SCRIPT_TOKEN: ' + token);
  Logger.log('Теперь разверните скрипт как Web App и скопируйте URL /exec.');
}


/**
 * Показывает текущие настройки и токен в журнале выполнения.
 */
function showEcoDriveBridgeConfig() {
  const props = PropertiesService.getScriptProperties();

  Logger.log('SPREADSHEET_ID: ' + (props.getProperty('SPREADSHEET_ID') || 'НЕ ЗАДАН'));
  Logger.log('SOURCE_SHEET: ' + (props.getProperty('SOURCE_SHEET') || 'НЕ ЗАДАНА'));
  Logger.log('APPS_SCRIPT_TOKEN: ' + (props.getProperty('ECODRIVE_TOKEN') || 'НЕ ЗАДАН'));
}


/**
 * Если нужно сменить секретный токен.
 */
function regenerateEcoDriveToken() {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('ECODRIVE_TOKEN', token);
  Logger.log('Новый APPS_SCRIPT_TOKEN: ' + token);
}


/**
 * GitHub Actions вызывает GET, чтобы получить список ссылок из Google Sheet.
 */
function doGet(e) {
  try {
    const token = String(e?.parameter?.token || '');
    authorize_(token);

    const action = String(e?.parameter?.action || 'list');

    if (action !== 'list') {
      return json_({ ok: false, error: 'Unknown action' });
    }

    const { sheet } = getSourceSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow < ECODRIVE_CONFIG.START_ROW) {
      return json_({ ok: true, rows: [] });
    }

    const count = lastRow - ECODRIVE_CONFIG.START_ROW + 1;
    const values = sheet
      .getRange(ECODRIVE_CONFIG.START_ROW, 1, count, ECODRIVE_CONFIG.PRICE_CHANGE_COL)
      .getValues();

    const rows = [];

    values.forEach((row, index) => {
      const sheetRow = ECODRIVE_CONFIG.START_ROW + index;
      const url = String(row[ECODRIVE_CONFIG.URL_COL - 1] || '').trim();

      if (!url || !/^https?:\/\/(www\.)?ecodrive\.in\.ua\//i.test(url)) {
        return;
      }

      rows.push({
        row: sheetRow,
        name: String(row[ECODRIVE_CONFIG.NAME_COL - 1] || ''),
        url,
        oldPrice: toNumber_(row[ECODRIVE_CONFIG.PRICE_COL - 1]),
        oldStock: String(row[ECODRIVE_CONFIG.STOCK_COL - 1] || ''),
        internalSku: String(row[ECODRIVE_CONFIG.INTERNAL_SKU_COL - 1] || '')
      });
    });

    return json_({
      ok: true,
      sheet: sheet.getName(),
      rows
    });

  } catch (error) {
    return json_({
      ok: false,
      error: error.message || String(error)
    });
  }
}


/**
 * GitHub Actions присылает сюда распарсенные цены и наличие.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e?.postData?.contents || '{}');
    authorize_(String(payload.token || ''));

    if (payload.action !== 'update') {
      return json_({ ok: false, error: 'Unknown action' });
    }

    if (!Array.isArray(payload.updates)) {
      return json_({ ok: false, error: 'updates must be an array' });
    }

    const { ss, sheet } = getSourceSheet_();
    const history = ensureHistorySheet_(ss);
    const historyRows = [];

    let updated = 0;

    payload.updates.forEach(item => {
      const row = Number(item.row);

      if (!Number.isInteger(row) || row < ECODRIVE_CONFIG.START_ROW || row > sheet.getLastRow()) {
        return;
      }

      const currentUrl = String(sheet.getRange(row, ECODRIVE_CONFIG.URL_COL).getValue() || '').trim();
      const incomingUrl = String(item.url || '').trim();

      if (!/^https?:\/\/(www\.)?ecodrive\.in\.ua\//i.test(currentUrl)) {
        return;
      }

      if (incomingUrl && stripUrl_(incomingUrl) !== stripUrl_(currentUrl)) {
        sheet.getRange(row, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue(new Date());
        sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue('ERROR: URL mismatch');
        return;
      }

      const checkedAt = parseDate_(item.checkedAt) || new Date();
      const status = String(item.status || 'ERROR: empty status').slice(0, 500);

      sheet.getRange(row, ECODRIVE_CONFIG.LAST_CHECK_COL).setValue(checkedAt);
      sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue(status);

      // При любой ошибке старую цену/наличие НЕ трогаем.
      if (status !== 'OK') {
        updated++;
        return;
      }

      const newPrice = toNumber_(item.price);

      if (!newPrice || newPrice <= 0) {
        sheet.getRange(row, ECODRIVE_CONFIG.STATUS_COL).setValue('ERROR: invalid price');
        updated++;
        return;
      }

      const oldPrice = toNumber_(sheet.getRange(row, ECODRIVE_CONFIG.PRICE_COL).getValue());
      const oldStock = String(sheet.getRange(row, ECODRIVE_CONFIG.STOCK_COL).getValue() || '');
      const newStock = String(item.stock || '').trim();
      const ecodriveSku = String(item.ecodriveSku || '').trim();
      const internalSku = String(sheet.getRange(row, ECODRIVE_CONFIG.INTERNAL_SKU_COL).getValue() || '');
      const name = String(sheet.getRange(row, ECODRIVE_CONFIG.NAME_COL).getValue() || '');

      sheet.getRange(row, ECODRIVE_CONFIG.PRICE_COL).setValue(newPrice);

      if (newStock) {
        sheet.getRange(row, ECODRIVE_CONFIG.STOCK_COL).setValue(newStock);
      }

      if (ecodriveSku) {
        sheet.getRange(row, ECODRIVE_CONFIG.ECODRIVE_SKU_COL).setValue(ecodriveSku);
      }

      const difference = oldPrice ? newPrice - oldPrice : 0;
      sheet.getRange(row, ECODRIVE_CONFIG.PRICE_CHANGE_COL).setValue(difference);

      if (!oldPrice || oldPrice !== newPrice || (newStock && oldStock !== newStock)) {
        historyRows.push([
          checkedAt,
          row,
          internalSku,
          ecodriveSku,
          name,
          currentUrl,
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
      updated,
      historyAdded: historyRows.length
    });

  } catch (error) {
    return json_({
      ok: false,
      error: error.message || String(error)
    });
  }
}


function getSourceSheet_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');
  const sourceSheet = props.getProperty('SOURCE_SHEET');

  if (!spreadsheetId || !sourceSheet) {
    throw new Error('Сначала запустите setupEcoDriveBridge().');
  }

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sourceSheet);

  if (!sheet) {
    throw new Error('Не найдена вкладка: ' + sourceSheet);
  }

  return { ss, sheet };
}


function ensureHistorySheet_(ss) {
  let sheet = ss.getSheetByName(ECODRIVE_CONFIG.HISTORY_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(ECODRIVE_CONFIG.HISTORY_SHEET);
  }

  const headers = [
    'Дата',
    'Строка',
    'Ваш SKU',
    'SKU EcoDrive',
    'Название',
    'Ссылка',
    'Старая цена',
    'Новая цена',
    'Изменение',
    'Старое наличие',
    'Новое наличие'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  return sheet;
}


function authorize_(incomingToken) {
  const expected = PropertiesService.getScriptProperties().getProperty('ECODRIVE_TOKEN');

  if (!expected) {
    throw new Error('Token is not configured');
  }

  if (!incomingToken || incomingToken !== expected) {
    throw new Error('Unauthorized');
  }
}


function stripUrl_(url) {
  return String(url || '')
    .split('#')[0]
    .split('?')[0]
    .replace(/\/+$/, '')
    .toLowerCase();
}


function toNumber_(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value || '')
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');

  const number = Number(normalized);
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
