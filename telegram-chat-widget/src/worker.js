const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
        return json({ ok: false, error: "Origin is not allowed" }, 403, corsHeaders);
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-chat-widget" }, 200, corsHeaders);
    }

    if (request.method !== "POST" || url.pathname !== "/api/message") {
      return json({ ok: false, error: "Not found" }, 404, corsHeaders);
    }

    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
      return json({ ok: false, error: "Origin is not allowed" }, 403, corsHeaders);
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return json({ ok: false, error: "Server is not configured" }, 500, corsHeaders);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return json({ ok: false, error: "JSON body required" }, 415, corsHeaders);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 20_000) {
      return json({ ok: false, error: "Request is too large" }, 413, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, corsHeaders);
    }

    // Honeypot: normal visitors never fill this hidden field.
    if (clean(payload.website, 200)) {
      return json({ ok: true }, 200, corsHeaders);
    }

    const name = clean(payload.name, 80);
    const contact = clean(payload.contact, 120);
    const message = clean(payload.message, 1500);
    const page = safeUrl(payload.page);
    const referrer = safeUrl(payload.referrer);
    const visitorId = clean(payload.visitorId, 80);
    const startedAt = Number(payload.startedAt || 0);

    if (!contact || contact.length < 3) {
      return json({ ok: false, error: "Contact is required" }, 400, corsHeaders);
    }

    if (!message || message.length < 2) {
      return json({ ok: false, error: "Message is required" }, 400, corsHeaders);
    }

    // Simple bot protection: reject forms submitted unrealistically fast.
    if (startedAt && Date.now() - startedAt < 1200) {
      return json({ ok: false, error: "Please try again" }, 429, corsHeaders);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const country = request.cf?.country || "unknown";
    const userAgent = clean(request.headers.get("User-Agent"), 250);
    const now = new Intl.DateTimeFormat("uk-UA", {
      timeZone: "Europe/Kyiv",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date());

    const lines = [
      "💬 <b>Нове повідомлення із сайту</b>",
      "",
      name ? `👤 <b>Ім’я:</b> ${escapeHtml(name)}` : null,
      `📞 <b>Контакт:</b> ${escapeHtml(contact)}`,
      `📝 <b>Повідомлення:</b>\n${escapeHtml(message)}`,
      "",
      page ? `🔗 <b>Сторінка:</b> ${escapeHtml(page)}` : null,
      referrer ? `↩️ <b>Джерело:</b> ${escapeHtml(referrer)}` : null,
      visitorId ? `🆔 <b>Відвідувач:</b> ${escapeHtml(visitorId)}` : null,
      `🕒 <b>Час:</b> ${escapeHtml(now)}`,
      `🌍 <b>Країна:</b> ${escapeHtml(country)}`,
      `🌐 <b>IP:</b> ${escapeHtml(ip)}`,
      userAgent ? `📱 <b>Пристрій:</b> ${escapeHtml(userAgent)}` : null,
    ].filter(Boolean);

    const telegramBody = {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    const threadId = Number(env.TELEGRAM_THREAD_ID || 0);
    if (threadId > 0) {
      telegramBody.message_thread_id = threadId;
    }

    if (page) {
      telegramBody.reply_markup = {
        inline_keyboard: [[{ text: "Відкрити сторінку", url: page }]],
      };
    }

    let telegramResponse;
    try {
      telegramResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(telegramBody),
        },
      );
    } catch (error) {
      console.error("Telegram network error", error?.message || error);
      return json({ ok: false, error: "Telegram is unavailable" }, 502, corsHeaders);
    }

    const telegramResult = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramResult?.ok) {
      console.error("Telegram API error", telegramResult?.description || telegramResponse.status);
      return json({ ok: false, error: "Message was not delivered" }, 502, corsHeaders);
    }

    return json({ ok: true }, 200, corsHeaders);
  },
};

function clean(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function safeUrl(value) {
  const text = clean(value, 600);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function allowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedOrigin(origin, configuredOrigins) {
  if (!origin) return false;
  return allowedOrigins(configuredOrigins).includes(origin.replace(/\/$/, ""));
}

function getCorsHeaders(origin, configuredOrigins) {
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };

  if (isAllowedOrigin(origin, configuredOrigins)) {
    headers["access-control-allow-origin"] = origin;
  }

  return headers;
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
