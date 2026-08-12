# operbots-mcp

[![npm](https://img.shields.io/npm/v/operbots-mcp)](https://www.npmjs.com/package/operbots-mcp)

MCP-сервер панели [operbots](https://github.com/uk-kd/operbots). Даёт Claude Code
и другим клиентам MCP работать с делами, телеграм-ботами, сценариями на полотне,
перепиской, базой знаний и подключениями к ИИ.

**Права те же, что у вас.** Токен опознаёт вашу учётную запись, и панель применяет
к запросам те же проверки ролей и прав по делам. Выдать помощнику больше, чем
можете сами, нельзя.

```
собери сценарий приёма заявок для бота поддержки и прогони его на «привет»
покажи диалоги, где ждут ответа дольше часа, и ответь им от имени бота
добавь в базу знаний прайс со страницы example.com/prices и проверь поиск
```

Требуется Node 20 или новее.

---

## Установка

Сначала выпустите токен в панели: **аккаунт → Интеграции → «Выпустить токен»**.
Значение показывается один раз — скопируйте сразу.

Плагином — сервер пропишется сам и будет обновляться:

```
/plugin marketplace add uk-kd/operbots-mcp
/plugin install operbots-mcp@operbots
```

Или вручную, в любой клиент MCP:

```bash
claude mcp add operbots -- npx -y operbots-mcp
```

Дальше скажите Claude «подключись к панели operbots» — откроется окно для адреса
и токена. Проверить: `npx operbots-mcp status`.

---

## Доступ

Пароль сервер не видит и не хранит: на диск ложится только токен —
`~/.operbots/credentials.json` с правами 600. В самой панели значения тоже нет,
там лежит лишь его отпечаток, поэтому даже из базы токен не восстановить.

Отозвать доступ — в панели, аккаунт → Интеграции. Отзыв действует сразу и только
для этого токена: остальные машины продолжают работать. Команда
`operbots-mcp logout` лишь стирает токен с этой машины, сам он остаётся живым.

Выпускать и отзывать токены можно только из панели — по токену нельзя, иначе
утёкший ключ выписывал бы себе новые.

---

## Настройки

Все необязательны.

| Переменная | Что делает |
| --- | --- |
| `OPERBOTS_URL` | Адрес панели. Обычно берётся из сохранённого профиля |
| `OPERBOTS_TOKEN` | Токен вместо сохранённого файла: контейнер, сборка |
| `OPERBOTS_CASE` | Дело по умолчанию: короткое имя, название или идентификатор |
| `OPERBOTS_READ_ONLY=1` | Оставить только инструменты чтения — 18 вместо 55 |
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

Наружу намеренно не выведены регистрация и смена пароля, выпуск и отзыв токенов,
выход на всех устройствах, служебные вебхуки Telegram. Значения секретных переменных
бота панель отдаёт открыто, а сервер скрывает — видно только имя.

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
operbots-mcp login    сохранить токен доступа к панели
operbots-mcp logout   удалить токен с этой машины
operbots-mcp status   проверить связь с панелью и показать права
operbots-mcp tools    перечислить доступные инструменты
```

---

MIT · правите код — загляните в [CONTRIBUTING.md](CONTRIBUTING.md)
