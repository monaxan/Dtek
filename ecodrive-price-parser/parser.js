import { chromium } from 'playwright';

const BRIDGE_URL = process.env.APPS_SCRIPT_WEBAPP_URL;
const BRIDGE_TOKEN = process.env.APPS_SCRIPT_TOKEN;

const CATALOG_URL =
  process.env.ECODRIVE_CATALOG_URL ||
  'https://ecodrive.in.ua/eko-energiya/zaryadni-stancii/';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 45000;
const BATCH_SIZE = 15;
const MAX_CATALOG_PAGES = Math.max(3, Number(process.env.ECODRIVE_MAX_PAGES || 20));

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  console.error('Missing APPS_SCRIPT_WEBAPP_URL or APPS_SCRIPT_TOKEN');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(900 + Math.floor(Math.random() * 1800));

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(value || '')
      .trim()
      .split('#')[0]
      .split('?')[0]
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

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

  console.log(`Google Sheet source: ${data.sheet || 'unknown'}`);
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
      action: 'upsert',
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

  console.log(
    `Saved: updated=${data.updated ?? updates.length}, appended=${data.appended ?? 0}, ` +
    `history=${data.historyAdded ?? 0}, skippedNewNotInStock=${data.skippedNewNotInStock ?? 0}`
  );
}

async function warmUp(page) {
  try {
    const response = await page.goto('https://ecodrive.in.ua/', {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT
    });

    console.log(`Warm-up homepage: HTTP ${response?.status() ?? 'unknown'}`);
    await sleep(1500);
  } catch (error) {
    console.warn(`Warm-up failed: ${error.message}`);
  }
}

function catalogPageUrl(pageNumber) {
  const base = CATALOG_URL.endsWith('/') ? CATALOG_URL : `${CATALOG_URL}/`;
  if (pageNumber <= 1) return base;
  return new URL(`page-${pageNumber}/`, base).toString();
}

/**
 * Сканирует сам каталог, включая /page-2/, /page-3/ и дальнейшие страницы.
 * Это исправляет старое поведение, когда парсер проверял только URL,
 * которые уже были в Google Sheet, и не мог найти новые товары.
 */
async function discoverCatalogProducts(page) {
  const found = new Map();
  let knownMaxPage = 1;
  let previousSignature = '';
  let noNewPages = 0;

  console.log(`Catalog discovery started: ${CATALOG_URL}`);

  for (let pageNumber = 1; pageNumber <= MAX_CATALOG_PAGES; pageNumber++) {
    const url = catalogPageUrl(pageNumber);

    try {
      console.log(`Catalog page ${pageNumber}: ${url}`);

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: REQUEST_TIMEOUT
      });

      const status = response?.status() ?? 0;
      if (status === 403) throw new Error('HTTP 403');
      if (status >= 400) {
        console.warn(`Catalog page ${pageNumber}: HTTP ${status}; stopping pagination`);
        break;
      }

      await page.waitForTimeout(1400);

      // Некоторые каталоги дорисовывают карточки после первого viewport.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0));

      const result = await page.evaluate(catalogUrl => {
        const root = new URL(catalogUrl, location.origin);
        const rootPath = root.pathname.replace(/\/+$/, '') + '/';

        const clean = href => {
          try {
            const u = new URL(href, location.origin);
            u.hash = '';
            u.search = '';
            u.pathname = u.pathname.replace(/\/+$/, '');
            return u;
          } catch {
            return null;
          }
        };

        const isExcluded = u => {
          if (!u || u.hostname !== location.hostname) return true;

          const p = u.pathname.toLowerCase();
          const normalizedRoot = rootPath.toLowerCase().replace(/\/+$/, '');

          if (p === normalizedRoot || p === `${normalizedRoot}/`) return true;
          if (p.startsWith(`${normalizedRoot}/page-`) || /\/page-\d+\/?$/.test(p)) return true;
          if (/\.(jpg|jpeg|png|webp|gif|svg|pdf)$/i.test(p)) return true;
          if (/\/(cart|checkout|account|login|register|wishlist|compare|search)(\/|$)/i.test(p)) return true;
          if (/\/(contacts?|about|blog|news|service|servis)(\/|$)/i.test(p)) return true;

          return false;
        };

        const stockFromText = text => {
          const t = String(text || '').toLowerCase();
          if (/немає в наявності|нет в наличии|out.?of.?stock/.test(t)) return 'Нет в наличии';
          if (/під замовлення|под заказ|preorder|backorder/.test(t)) return 'Под заказ';
          if (/в наявності|в наличии|in.?stock/.test(t)) return 'В наличии';
          return '';
        };

        let maxPage = 1;
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') || '';
          const match = href.match(/\/page-(\d+)\/?(?:[?#].*)?$/i);
          if (match) maxPage = Math.max(maxPage, Number(match[1]));
        }

        const cardSelector = [
          '.product-layout',
          '.product-thumb',
          '.product-grid',
          '.product-item',
          '.product-card',
          '.products-item',
          '.catalog-product',
          '.product-item-container',
          '[data-product-id]',
          '[data-product]'
        ].join(',');

        const cards = Array.from(document.querySelectorAll(cardSelector));
        const products = new Map();

        const addFromContainer = container => {
          const anchors = Array.from(container.querySelectorAll('a[href]'))
            .map(a => {
              const u = clean(a.href);
              if (isExcluded(u)) return null;

              const text = String(a.textContent || '').replace(/\s+/g, ' ').trim();
              const imgAlt = String(a.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
              let score = 0;

              if (text.length >= 8) score += 6;
              if (imgAlt.length >= 8) score += 4;
              if (a.matches('.name a, .product-name a, .title a, h2 a, h3 a, h4 a')) score += 12;
              if (/product|name|title/i.test(String(a.className || ''))) score += 4;
              if (u && u.pathname.split('/').filter(Boolean).length <= 2) score += 2;

              return { a, u, text, imgAlt, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);

          const best = anchors[0];
          if (!best || best.score < 2) return;

          const heading = container.querySelector(
            '.product-name, .name, .product-title, .title, h2, h3, h4'
          );

          const name = String(
            heading?.textContent || best.text || best.imgAlt || ''
          ).replace(/\s+/g, ' ').trim();

          const key = best.u.toString().replace(/\/+$/, '').toLowerCase();
          const cardText = String(container.innerText || '').replace(/\s+/g, ' ').trim();

          if (!products.has(key)) {
            products.set(key, {
              url: best.u.toString(),
              name,
              stockHint: stockFromText(cardText)
            });
          }
        };

        cards.forEach(addFromContainer);

        // Fallback для другой верстки: ищем товарные ссылки внутри основного контента.
        if (products.size === 0) {
          const scope =
            document.querySelector('#content, main, .content, .products, .catalog') ||
            document.body;

          for (const a of scope.querySelectorAll('a[href]')) {
            const u = clean(a.href);
            if (isExcluded(u)) continue;

            const text = String(a.textContent || '').replace(/\s+/g, ' ').trim();
            const imgAlt = String(a.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
            const candidateName = text || imgAlt;

            // Категории и служебные ссылки обычно короткие. Карточки товара — длиннее.
            if (candidateName.length < 12) continue;

            const parentText = String(
              a.closest('li, article, div')?.innerText || ''
            ).replace(/\s+/g, ' ').trim();

            // Добавляем только ссылки, которые выглядят как товарная карточка:
            // рядом есть цена или явное наличие.
            if (!/грн\.?/i.test(parentText) && !/в наявності|немає в наявності|під замовлення/i.test(parentText)) {
              continue;
            }

            const key = u.toString().replace(/\/+$/, '').toLowerCase();
            if (!products.has(key)) {
              products.set(key, {
                url: u.toString(),
                name: candidateName,
                stockHint: stockFromText(parentText)
              });
            }
          }
        }

        return {
          maxPage,
          products: Array.from(products.values())
        };
      }, CATALOG_URL);

      knownMaxPage = Math.max(knownMaxPage, Number(result.maxPage || 1));

      const urlsOnPage = result.products.map(item => normalizeUrl(item.url)).sort();
      const signature = urlsOnPage.join('|');

      // Если сервер вместо несуществующей page-N возвращает ту же последнюю страницу,
      // не зацикливаемся.
      if (pageNumber > 1 && signature && signature === previousSignature) {
        console.log(`Catalog page ${pageNumber} repeats previous page; stopping`);
        break;
      }

      previousSignature = signature;

      let newOnPage = 0;
      for (const item of result.products) {
        const key = normalizeUrl(item.url);
        if (!key || !key.includes('ecodrive.in.ua')) continue;
        if (!found.has(key)) {
          found.set(key, item);
          newOnPage++;
        }
      }

      console.log(
        `Catalog page ${pageNumber}: found=${result.products.length}, new=${newOnPage}, ` +
        `paginationMax=${knownMaxPage}, totalUnique=${found.size}`
      );

      if (newOnPage === 0) noNewPages++;
      else noNewPages = 0;

      // Если пагинация явно показала последнюю страницу — заканчиваем точно на ней.
      if (knownMaxPage > 1 && pageNumber >= knownMaxPage) break;

      // Если номер последней страницы не удалось вытащить из DOM,
      // продолжаем page-N, пока не получим две пустые/повторные страницы.
      if (knownMaxPage === 1 && pageNumber >= 3 && noNewPages >= 2) break;

      await randomDelay();
    } catch (error) {
      console.warn(`Catalog page ${pageNumber} failed: ${error.message}`);
      if (pageNumber === 1) throw error;
      break;
    }
  }

  console.log(`Catalog discovery complete: ${found.size} unique product URLs`);
  return Array.from(found.values());
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

      if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');

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

    const bodyText = document.body?.innerText || '';
    const bodyStock = normalizeStock(bodyText);
    const h1Name = String(document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
    const bodySku = (() => {
      const match = bodyText.match(/Артикул\s*:?\s*([A-ZА-Я0-9][A-ZА-Я0-9._\/-]{1,})/i);
      return match ? match[1].trim() : '';
    })();

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
              stock: normalizeStock(offer.availability) || bodyStock,
              sku: String(data.sku || data.mpn || bodySku || '').trim(),
              name: String(data.name || h1Name || '').replace(/\s+/g, ' ').trim()
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

    // 1) JSON-LD.
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
          return {
            price,
            stock: bodyStock,
            sku: bodySku,
            name: h1Name
          };
        }
      }
    }

    // 3) Visual fallback. Не берем рассрочку/старую зачеркнутую цену.
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
      if (/міс\.?|місяц|частинами|кредит|розстроч/i.test(text)) score -= 100;
      if (price < 1000) score -= 30;

      candidates.push({ price, score, text });
    }

    candidates.sort((a, b) => b.score - a.score);

    return {
      price: candidates[0]?.price || null,
      stock: bodyStock,
      sku: bodySku,
      name: h1Name,
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

      await page.waitForTimeout(1200);

      const product = await extractProduct(page);
      const price = normalizePrice(product.price);
      const stock = normalizeAvailability(product.stock || item.stockHint);
      const name = String(product.name || item.name || '').replace(/\s+/g, ' ').trim();

      if (!price) {
        throw new Error(`Price not found${product.debugPriceText ? ` (${product.debugPriceText})` : ''}`);
      }

      console.log(
        `[${index}] OK: ${price} UAH | ${stock || 'stock unknown'} | ` +
        `SKU ${product.sku || '-'} | ${name.slice(0, 70)}`
      );

      return {
        row: item.row || null,
        url: item.url,
        name,
        price,
        stock,
        ecodriveSku: product.sku || '',
        checkedAt: new Date().toISOString(),
        status: 'OK'
      };
    } catch (error) {
      lastError = error;
      console.warn(`[${index}] Attempt ${attempt} failed: ${error.message}`);

      if (attempt < MAX_RETRIES) await sleep(1800 * attempt);
    }
  }

  // Для существующих строк ошибка должна попасть в J.
  // Для нового кандидата без строки этот результат Apps Script просто не добавит.
  try {
    const suffix = item.row ? `row-${item.row}` : `new-${index}`;
    await page.screenshot({
      path: `debug-${suffix}.png`,
      fullPage: false
    });
  } catch (_) {}

  return {
    row: item.row || null,
    url: item.url,
    name: item.name || '',
    checkedAt: new Date().toISOString(),
    status: `ERROR: ${lastError?.message || 'unknown error'}`
  };
}

async function main() {
  const sheetRows = await fetchSheetRows();
  console.log(`Loaded ${sheetRows.length} existing EcoDrive URLs from Google Sheet`);

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

  const page = await context.newPage();
  page.setDefaultTimeout(REQUEST_TIMEOUT);

  // Ускоряем загрузку, но HTML/CSS/JS оставляем.
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  await warmUp(page);

  try {
    const catalogProducts = await discoverCatalogProducts(page);

    const itemsByUrl = new Map();

    // Сначала существующие строки — они имеют приоритет и сохраняют row.
    for (const row of sheetRows) {
      if (!row?.url || !String(row.url).includes('ecodrive.in.ua')) continue;
      itemsByUrl.set(normalizeUrl(row.url), {
        ...row,
        isNew: false
      });
    }

    let discoveredNew = 0;

    for (const product of catalogProducts) {
      const key = normalizeUrl(product.url);
      if (!key || itemsByUrl.has(key)) continue;

      itemsByUrl.set(key, {
        row: null,
        url: product.url,
        name: product.name || '',
        stockHint: product.stockHint || '',
        isNew: true
      });
      discoveredNew++;
    }

    const items = Array.from(itemsByUrl.values());

    console.log(
      `Will check ${items.length} products: existing=${sheetRows.length}, ` +
      `newFromCatalog=${discoveredNew}`
    );

    let pending = [];
    let newInStock = 0;
    let newSkipped = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const update = await parseOne(page, item, i + 1);

      if (item.isNew) {
        // В таблицу автоматически добавляем только новые товары "В наличии".
        if (update.status !== 'OK' || update.stock !== 'В наличии') {
          console.log(
            `[${i + 1}] New product not appended: status=${update.status}, stock=${update.stock || 'unknown'}`
          );
          newSkipped++;
          await randomDelay();
          continue;
        }
        newInStock++;
      }

      pending.push(update);

      if (pending.length >= BATCH_SIZE) {
        await postUpdates(pending);
        pending = [];
      }

      await randomDelay();
    }

    if (pending.length) await postUpdates(pending);

    console.log(
      `Done. Catalog unique=${catalogProducts.length}, newInStockAppended=${newInStock}, ` +
      `newSkipped=${newSkipped}`
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
