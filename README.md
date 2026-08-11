# operbots-mcp

[![npm](https://img.shields.io/npm/v/operbots-mcp)](https://www.npmjs.com/package/operbots-mcp)

MCP-сервер панели [operbots](https://github.com/uk-kd/operbots). Даёт Claude Code
и другим клиентам MCP работать с делами, телеграм-ботами, сценариями на полотне,
перепиской, базой знаний и подключениями к ИИ.

**Права те же, что у вас.** Сервер держит обычную пользовательскую сессию: бэкенд
не отличает её от вкладки браузера и применяет те же проверки ролей и прав по делам.
Выдать помощнику больше, чем можете сами, нельзя.

```
собери сценарий приёма заявок для бота поддержки и прогони его на «привет»
покажи диалоги, где ждут ответа дольше часа, и ответь им от имени бота
добавь в базу знаний прайс со страницы example.com/prices и проверь поиск
```

Требуется Node 20 или новее.

---

## Установка

Плагином — сервер пропишется сам и будет обновляться:

```
/plugin marketplace add uk-kd/operbots-mcp
/plugin install operbots-mcp@operbots
```

Или вручную, в любой клиент MCP:

```bash
claude mcp add operbots -- npx -y operbots-mcp
```

Дальше скажите Claude «войди в панель operbots» — откроется окно для адреса,
почты и пароля. Проверить: `npx operbots-mcp status`.

---

## Вход и доступ

Два равнозначных пути: инструмент `operbots_login` (окно рисует клиент, ответ идёт
серверу напрямую — пароль не попадает в переписку с моделью) и команда
`operbots-mcp login` в терминале, где пароль вводится скрыто. Если клиент не умеет
запрашивать данные, инструмент скажет об этом и отправит в терминал.

Пароль не сохраняется нигде: он сразу меняется на токен обновления, и только токен
ложится в `~/.operbots/credentials.json` с правами 600. Дальше сервер сам получает
короткоживущие токены доступа. Панель гасит прежний токен обновления при каждой
выдаче нового, поэтому:

* новый токен пишется на диск раньше, чем понадобится снова;
* обновление идёт под блокировкой файла с перечитыванием — иначе две сессии
  Claude Code отобрали бы доступ друг у друга;
* файл переписывается через временный и переименование: обрыв не оставит пустышку.

Подключение видно в панели — **аккаунт → Интеграции**, там же кнопка «Отозвать».
С самой машины доступ убирает `operbots-mcp logout`.

---

## Настройки

Все необязательны.

| Переменная | Что делает |
| --- | --- |
| `OPERBOTS_URL` | Адрес панели. Обычно берётся из сохранённого профиля |
| `OPERBOTS_CASE` | Дело по умолчанию: короткое имя, название или идентификатор |
| `OPERBOTS_READ_ONLY=1` | Оставить только инструменты чтения — 18 вместо 55 |
| `OPERBOTS_EMAIL`, `OPERBOTS_PASSWORD` | Вход без участия человека: контейнер, сборка |
| `OPERBOTS_REFRESH_TOKEN` | Токен вместо файла. Обновлённый живёт только в памяти процесса |
| `OPERBOTS_CREDENTIALS` | Другой путь к файлу доступа |
| `OPERBOTS_TIMEOUT_MS` | Сколько ждать ответ панели. По умолчанию 30000 |
| `OPERBOTS_INSECURE_TLS=1` | Не проверять сертификат — для самоподписанного TLS |

```bash
claude mcp add operbots \
  --env OPERBOTS_CASE=magazin-severnyj --env OPERBOTS_READ_ONLY=1 \
  -- npx -y operbots-mcp
```

---

## Инструменты

55 штук. Дела, ботов, сценарии и подключения можно называть по имени —
идентификаторы не нужны: `flows_publish bot="бот поддержки" flow="Приём заявок"`.

| Раздел | Инструменты |
| --- | --- |
| **Аккаунт** | `operbots_login`, `operbots_logout`, `whoami`, `sessions_list`, `sessions_revoke`, `account_update` |
| **Дела** | `cases_list`, `cases_get`, `cases_save`, `cases_delete`, `cases_leave` |
| **Люди** | `members_list`, `members_save`, `members_remove`, `case_transfer`, `roles_save`, `roles_delete`, `invites_create`, `invites_revoke` |
| **Боты** | `bots_list`, `bots_get`, `bots_save`, `bots_control`, `bots_commands_apply`, `bots_variables_set`, `bots_reveal_token`, `bots_webhook_rotate`, `bots_delete` |
| **Сценарии** | `flows_list`, `flows_get`, `flows_save`, `flows_publish`, `flows_versions`, `flows_restore`, `flows_simulate`, `flows_delete` |
| **Диалоги** | `dialogs_list`, `dialogs_get`, `dialogs_history`, `dialogs_reply`, `dialogs_update`, `dialogs_delete`, `tasks_list`, `tasks_cancel` |
| **База знаний** | `knowledge_list`, `knowledge_save`, `knowledge_add_document`, `knowledge_reindex`, `knowledge_search`, `knowledge_delete` |
| **ИИ-сервисы** | `ai_list`, `ai_save`, `ai_test`, `ai_delete` |
| **Справочники** | `operbots_catalog` — виды узлов с их настройками, заготовки, виды ИИ-сервисов, права |

Шестнадцать помечены необратимыми — клиент спросит разрешение. Удаление дела, бота,
сценария и диалога вдобавок требует названия дословно: случайный вызов не сотрёт.

Наружу намеренно не выведены регистрация и смена пароля, выход на всех устройствах,
служебные вебхуки Telegram. Значения секретных переменных бота панель отдаёт открыто,
а сервер скрывает — видно только имя.

### Полотно

Граф отдаётся и принимается плоским, без внутренностей редактора:

```
узлы:
  - id: start
    kind: trigger.command
    config: { command: start }
  - id: hello
    kind: action.message
    config: { text: Здравствуйте! Чем помочь? }
связи:
  - from: start
    to: hello
```

Правка заменяет граф целиком: сначала `flows_get`, затем `flows_save` со всеми
узлами. Размеры и положение карты переносятся из текущей редакции, поэтому правка
одного узла не сбивает вид полотна. Состав `config` — в `operbots_catalog
what=node_kinds`. Новая редакция создаётся, только если граф действительно изменился.

---

## Команды

```
operbots-mcp          запустить сервер MCP (так его вызывает клиент)
operbots-mcp login    войти в панель и сохранить доступ
operbots-mcp logout   завершить сессию и удалить сохранённый доступ
operbots-mcp status   проверить связь с панелью и показать права
operbots-mcp tools    перечислить доступные инструменты
```

---

## Разработка и выпуск

```bash
npm install && npm run build
claude mcp add operbots-dev -- node ./dist/index.js
```

Выпуск: `npm version patch && git push --follow-tags`. Метка `v*` запускает
`.github/workflows/publish.yml` — сборка, проверка типов, сверка версии с меткой,
`npm publish --provenance`; нужен секрет `NPM_TOKEN`. Вручную —
`npm publish --access public`, но без отметки о происхождении.

Каталог плагина (`.claude-plugin/marketplace.json`, `plugins/operbots-mcp/`) живёт
в этом же репозитории и отдельной публикации не требует — поднимайте версию в
`plugin.json` вместе с пакетом. Для [реестра MCP](https://registry.modelcontextprotocol.io)
готов `server.json`: `mcp-publisher login github && mcp-publisher publish`, версии
в нём должны совпадать с `package.json`.

---

MIT
