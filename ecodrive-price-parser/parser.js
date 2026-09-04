import { chromium } from 'playwright';

const BRIDGE_URL = process.env.APPS_SCRIPT_WEBAPP_URL;
const BRIDGE_TOKEN = process.env.APPS_SCRIPT_TOKEN;

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 45000;
const BATCH_SIZE = 20;

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  console.error('Missing APPS_SCRIPT_WEBAPP_URL or APPS_SCRIPT_TOKEN');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(1200 + Math.floor(Math.random() * 2300));

function normalizePrice(value) {
  if (value === null || value === undefined) return null;

  let s = String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[^\d.,]/g, '');

  if (!s) return null;

  if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeAvailability(value) {
  if (!value) return '';
  const text = String(value).toLowerCase();

  if (/outofstock|out_of_stock|немає в наявності|нет в наличии/.test(text)) {
    return 'Нет в наличии';
  }

  if (/preorder|backorder|під замовлення|под заказ/.test(text)) {
    return 'Под заказ';
  }

  if (/instock|in_stock|в наявності|в наличии/.test(text)) {
    return 'В наличии';
  }

  return '';
}

async function fetchSheetRows() {
  const url = new URL(BRIDGE_URL);
  url.searchParams.set('action', 'list');
  url.searchParams.set('token', BRIDGE_TOKEN);

  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Bridge GET HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bridge GET returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (!data.ok || !Array.isArray(data.rows)) {
    throw new Error(`Bridge GET error: ${data.error || 'invalid response'}`);
  }

  return data.rows;
}

async function postUpdates(updates) {
  if (!updates.length) return;

  const response = await fetch(BRIDGE_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'update',
      token: BRIDGE_TOKEN,
      updates
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Bridge POST HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bridge POST returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (!data.ok) {
    throw new Error(`Bridge POST error: ${data.error || 'unknown error'}`);
  }

  console.log(`Saved ${data.updated || updates.length} rows to Google Sheet`);
}

async function warmUp(page) {
  try {
    const response = await page.goto('https://ecodrive.in.ua/', {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT
    });

    console.log(`Warm-up homepage: HTTP ${response?.status() ?? 'unknown'}`);
    await sleep(1800);
  } catch (error) {
    console.warn(`Warm-up failed: ${error.message}`);
  }
}

async function extractProduct(page) {
  return page.evaluate(() => {
    const parsePrice = value => {
      if (value === null || value === undefined) return null;

      let s = String(value)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, '')
        .replace(/[^\d.,]/g, '');

      if (!s) return null;

      if (s.includes(',') && !s.includes('.')) {
        s = s.replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }

      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const normalizeStock = value => {
      if (!value) return '';
      const text = String(value).toLowerCase();

      if (/outofstock|out_of_stock|немає в наявності|нет в наличии/.test(text)) {
        return 'Нет в наличии';
      }

      if (/preorder|backorder|під замовлення|под заказ/.test(text)) {
        return 'Под заказ';
      }

      if (/instock|in_stock|в наявності|в наличии/.test(text)) {
        return 'В наличии';
      }

      return '';
    };

    const findInJson = data => {
      if (!data) return null;

      if (Array.isArray(data)) {
        for (const item of data) {
          const found = findInJson(item);
          if (found) return found;
        }
        return null;
      }

      if (typeof data !== 'object') return null;

      const type = String(data['@type'] || '').toLowerCase();
      const looksLikeProduct = type.includes('product') || data.offers || data.sku;

      if (looksLikeProduct && data.offers) {
        const offers = Array.isArray(data.offers) ? data.offers : [data.offers];

        for (const offer of offers) {
          if (!offer || typeof offer !== 'object') continue;

          const price = parsePrice(
            offer.price ??
            offer.lowPrice ??
            offer.highPrice ??
            offer.priceSpecification?.price
          );

          if (price) {
            return {
              price,
              stock: normalizeStock(offer.availability),
              sku: String(data.sku || data.mpn || '').trim()
            };
          }
        }
      }

      for (const value of Object.values(data)) {
        if (value && typeof value === 'object') {
          const found = findInJson(value);
          if (found) return found;
        }
      }

      return null;
    };

    // 1) JSON-LD is the most reliable source when present.
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const json = JSON.parse(script.textContent || '');
        const found = findInJson(json);
        if (found?.price) return found;
      } catch (_) {}
    }

    // 2) Structured/meta price.
    const priceSelectors = [
      'meta[itemprop="price"]',
      'meta[property="product:price:amount"]',
      '[itemprop="price"]',
      '.product-price',
      '.product__price',
      '.price-new',
      '.price'
    ];

    for (const selector of priceSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const raw = el.getAttribute?.('content') || el.textContent || '';
        const price = parsePrice(raw);
        if (price) {
          const bodyText = document.body?.innerText || '';
          const skuMatch = bodyText.match(/Артикул\s*:?\s*([A-ZА-Я0-9][A-ZА-Я0-9._\/-]{2,})/i);
          return {
            price,
            stock: normalizeStock(bodyText),
            sku: skuMatch ? skuMatch[1].trim() : ''
          };
        }
      }
    }

    // 3) Visual fallback: score visible UAH price elements.
    const candidates = [];
    const nodes = document.querySelectorAll('span, div, p, strong, b');

    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

      const text = (el.innerText || '').trim();
      if (!text || text.length > 120 || !/грн\.?/i.test(text)) continue;

      const match = text.match(/(\d[\d\s\u00a0.,]{1,})\s*грн\.?/i);
      if (!match) continue;

      const price = parsePrice(match[1]);
      if (!price) continue;

      const cls = `${el.className || ''} ${el.id || ''}`.toLowerCase();
      const fontSize = parseFloat(style.fontSize || '0') || 0;
      const decoration = String(style.textDecorationLine || '').toLowerCase();

      let score = fontSize * 3;
      if (/price|cost|product-price|product__price/.test(cls)) score += 70;
      if (/old|former|strike|sale-old/.test(cls)) score -= 100;
      if (decoration.includes('line-through')) score -= 120;
      if (/міс\.?|місяц|частинами|кредит|розстроч/i.test(text)) score -= 90;
      if (price < 1000) score -= 30;

      candidates.push({ price, score, text });
    }

    candidates.sort((a, b) => b.score - a.score);

    const bodyText = document.body?.innerText || '';
    const skuMatch = bodyText.match(/Артикул\s*:?\s*([A-ZА-Я0-9][A-ZА-Я0-9._\/-]{2,})/i);

    return {
      price: candidates[0]?.price || null,
      stock: normalizeStock(bodyText),
      sku: skuMatch ? skuMatch[1].trim() : '',
      debugPriceText: candidates[0]?.text || ''
    };
  });
}

async function parseOne(page, item, index) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[${index}] Attempt ${attempt}: ${item.url}`);

      const response = await page.goto(item.url, {
        waitUntil: 'domcontentloaded',
        timeout: REQUEST_TIMEOUT
      });

      const status = response?.status() ?? 0;
      if (status === 403) throw new Error('HTTP 403');
      if (status >= 400) throw new Error(`HTTP ${status}`);

      await page.waitForTimeout(1500);

      const product = await extractProduct(page);
      const price = normalizePrice(product.price);
      const stock = normalizeAvailability(product.stock);

      if (!price) {
        throw new Error(`Price not found${product.debugPriceText ? ` (${product.debugPriceText})` : ''}`);
      }

      console.log(
        `[${index}] OK: ${price} UAH | ${stock || 'stock unknown'} | SKU ${product.sku || '-'}`
      );

      return {
        row: item.row,
        url: item.url,
        price,
        stock,
        ecodriveSku: product.sku || '',
        checkedAt: new Date().toISOString(),
        status: 'OK'
      };
    } catch (error) {
      lastError = error;
      console.warn(`[${index}] Attempt ${attempt} failed: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
      }
    }
  }

  try {
    await page.screenshot({
      path: `debug-row-${item.row}.png`,
      fullPage: false
    });
  } catch (_) {}

  return {
    row: item.row,
    url: item.url,
    checkedAt: new Date().toISOString(),
    status: `ERROR: ${lastError?.message || 'unknown error'}`
  };
}

async function main() {
  const rows = await fetchSheetRows();
  console.log(`Loaded ${rows.length} EcoDrive URLs from Google Sheet`);

  const proxy = PROXY_SERVER
    ? {
        server: PROXY_SERVER,
        ...(PROXY_USERNAME ? { username: PROXY_USERNAME } : {}),
        ...(PROXY_PASSWORD ? { password: PROXY_PASSWORD } : {})
      }
    : undefined;

  const browser = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy } : {})
  });

  const context = await browser.newContext({
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(REQUEST_TIMEOUT);

  // Save traffic but keep scripts/styles/cookies intact.
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (type === 'media' || type === 'font') {
      return route.abort();
    }
    return route.continue();
  });

  await warmUp(page);

  let pending = [];

  try {
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];

      if (!item?.url || !String(item.url).includes('ecodrive.in.ua')) {
        continue;
      }

      const update = await parseOne(page, item, i + 1);
      pending.push(update);

      if (pending.length >= BATCH_SIZE) {
        await postUpdates(pending);
        pending = [];
      }

      await randomDelay();
    }

    if (pending.length) {
      await postUpdates(pending);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
