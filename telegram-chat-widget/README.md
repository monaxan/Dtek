# Telegram-чат для X-Shop

Готовый виджет обратной связи: посетитель пишет на сайте, а сообщение приходит в Telegram-группу или личный чат.

## Что уже есть

- украинский и русский интерфейс по языку страницы;
- имя, телефон/Telegram и сообщение;
- ссылка на страницу, с которой написал клиент;
- время, страна, IP, устройство и ID посетителя;
- Telegram-токен не попадает в код сайта;
- ограничение разрешённых доменов;
- базовая защита от ботов через honeypot и проверку времени заполнения.

> Это односторонний виджет заявок: клиент пишет с сайта, вы получаете сообщение в Telegram. Ответ клиенту нужно отправлять по оставленному телефону или Telegram.

## 1. Создать Telegram-бота

1. Откройте `@BotFather` в Telegram.
2. Выполните `/newbot` и получите токен.
3. Добавьте бота в нужную Telegram-группу.
4. Напишите любое сообщение в группе.
5. Узнайте `chat_id`, открыв в браузере:

```text
https://api.telegram.org/botВАШ_ТОКЕН/getUpdates
```

Для группы `chat_id` обычно начинается с минуса. Если сообщения должны приходить в тему форума, дополнительно понадобится `message_thread_id`.

## 2. Развернуть Cloudflare Worker

```bash
cd telegram-chat-widget
npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npm run deploy
```

Для Telegram-темы дополнительно:

```bash
npx wrangler secret put TELEGRAM_THREAD_ID
```

После публикации Cloudflare покажет адрес примерно такого вида:

```text
https://brunette-telegram-chat.ВАШ-АККАУНТ.workers.dev
```

Проверка Worker:

```text
https://brunette-telegram-chat.ВАШ-АККАУНТ.workers.dev/health
```

Должен открыться ответ `{"ok":true,"service":"telegram-chat-widget"}`.

## 3. Указать домен сайта

В `wrangler.toml` уже указаны:

```toml
ALLOWED_ORIGINS = "https://brunette.com.ua,https://www.brunette.com.ua"
```

Если виджет ставится на другой сайт, замените домены и снова выполните:

```bash
npm run deploy
```

## 4. Добавить в X-Shop

Откройте `xshop-snippet.html` и замените:

```js
apiUrl: "https://YOUR-WORKER.workers.dev/api/message"
```

на реальный адрес Worker.

Затем вставьте весь код файла в глобальное поле пользовательского HTML/JavaScript, желательно перед закрывающим тегом `</body>`, чтобы виджет отображался на всех страницах.

## Настройка внешнего вида

В начале `xshop-snippet.html` можно изменить:

```js
accent: "#111111"
```

а также заголовки и подзаголовки для украинской и русской версий.

## Безопасность

Никогда не вставляйте `TELEGRAM_BOT_TOKEN` непосредственно в HTML или JavaScript сайта. Токен должен храниться только как секрет Cloudflare Worker. Cloudflare поддерживает зашифрованные secrets через Wrangler, а отправка сообщения выполняется сервером через метод Telegram Bot API `sendMessage`.
