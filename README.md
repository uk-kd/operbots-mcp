# operbots-mcp

MCP-сервер панели [operbots](https://github.com/nikitabelan/operbots): дела, боты,
сценарии на полотне, диалоги, база знаний и подключения к ИИ — прямо из Claude Code.

**Права те же, что у вас.** Сервер держит обычную пользовательскую сессию панели:
бэкенд не отличает её от вкладки браузера и применяет ровно те же проверки ролей
и прав по делам. Ничего сверх того, что позволено вашей роли, сделать нельзя.

---

## Быстрый старт

```bash
# 1. Вход в панель (один раз)
npx operbots-mcp login

# 2. Подключение к Claude Code
claude mcp add operbots -- npx -y operbots-mcp
```

Готово. Проверить: `npx operbots-mcp status`.

Пока пакет не опубликован в npm, вместо `operbots-mcp` подставляйте адрес
репозитория — сборка выполнится при установке:

```bash
npx github:nikitabelan/operbots-mcp login
claude mcp add operbots -- npx -y github:nikitabelan/operbots-mcp
```

Подключение появится в панели: **аккаунт → Интеграции**. Оттуда же его можно отозвать,
не заходя на машину, где стоит Claude Code.

---

## Как устроен вход

`operbots-mcp login` спрашивает адрес панели, почту и пароль. Пароль нигде не
сохраняется — он сразу обменивается на токен обновления, и на диск ложится только он:

```
~/.operbots/credentials.json      (права 600)
{
  "version": 1,
  "current": "https://panel.example.com",
  "profiles": {
    "https://panel.example.com": { "baseUrl": "…", "refreshToken": "…", … }
  }
}
```

Дальше сервер сам меняет токен обновления на короткоживущий токен доступа. Панель
выдаёт при каждом обновлении новый токен и сразу гасит прежний, поэтому:

* новый токен записывается на диск **до** того, как понадобится снова;
* обновление идёт под блокировкой файла, а токен перечитывается прямо перед
  запросом — иначе две сессии Claude Code отобрали бы доступ друг у друга;
* файл переписывается целиком через временный файл и переименование, чтобы обрыв
  посреди записи не оставил пустышку.

Отозвать доступ можно двумя способами: `npx operbots-mcp logout` на машине или
кнопкой «Отозвать» в разделе «Интеграции» панели.

---

## Настройки

Все необязательны — сервер работает и без них.

| Переменная | Что делает |
| --- | --- |
| `OPERBOTS_URL` | Адрес панели. Обычно берётся из сохранённого профиля |
| `OPERBOTS_CASE` | Дело по умолчанию: название или идентификатор |
| `OPERBOTS_READ_ONLY=1` | Оставить только инструменты чтения — 18 вместо 53 |
| `OPERBOTS_EMAIL`, `OPERBOTS_PASSWORD` | Вход без участия человека (контейнер, CI) |
| `OPERBOTS_REFRESH_TOKEN` | Готовый токен вместо файла. Ротация живёт только в памяти: после перезапуска токен уже недействителен |
| `OPERBOTS_CREDENTIALS` | Другой путь к файлу доступа |
| `OPERBOTS_TIMEOUT_MS` | Сколько ждать ответ панели. По умолчанию 30000 |
| `OPERBOTS_INSECURE_TLS=1` | Не проверять сертификат — для панели с самоподписанным TLS |

Пример с настройками:

```bash
claude mcp add operbots \
  --env OPERBOTS_CASE="Магазин Северный" \
  --env OPERBOTS_READ_ONLY=1 \
  -- npx -y operbots-mcp
```

---

## Что умеет

53 инструмента. Дела, ботов, сценарии и подключения можно называть по имени —
идентификаторы не нужны: `flows_publish bot="бот поддержки" flow="Приём заявок"`.

| Раздел | Инструменты |
| --- | --- |
| **Справочники** | `operbots_catalog` — виды узлов и их настройки, заготовки, виды ИИ-сервисов, права |
| **Аккаунт** | `whoami`, `sessions_list`, `sessions_revoke`, `account_update` |
| **Дела** | `cases_list`, `cases_get`, `cases_save`, `cases_delete`, `cases_leave` |
| **Люди** | `members_list`, `members_save`, `members_remove`, `case_transfer`, `roles_save`, `roles_delete`, `invites_create`, `invites_revoke` |
| **Боты** | `bots_list`, `bots_get`, `bots_save`, `bots_control`, `bots_commands_apply`, `bots_variables_set`, `bots_reveal_token`, `bots_webhook_rotate`, `bots_delete` |
| **Сценарии** | `flows_list`, `flows_get`, `flows_save`, `flows_publish`, `flows_versions`, `flows_restore`, `flows_simulate`, `flows_delete` |
| **Диалоги** | `dialogs_list`, `dialogs_get`, `dialogs_history`, `dialogs_reply`, `dialogs_update`, `dialogs_delete`, `tasks_list`, `tasks_cancel` |
| **База знаний** | `knowledge_list`, `knowledge_save`, `knowledge_add_document`, `knowledge_reindex`, `knowledge_search`, `knowledge_delete` |
| **ИИ-сервисы** | `ai_list`, `ai_save`, `ai_test`, `ai_delete` |

Пятнадцать инструментов помечены как необратимые — Claude Code спросит разрешение
перед вызовом. Удаление дела, бота, сценария и диалога вдобавок требует передать
название дословно: случайный вызов ничего не сотрёт.

### Сценарии на полотне

Граф отдаётся и принимается в плоском виде — без внутренностей редактора:

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

Правка заменяет граф целиком: сначала `flows_get`, затем `flows_save` со всем
списком узлов. Размеры узлов и положение карты переносятся из текущей редакции,
поэтому правка одного узла не сбивает вид полотна. Состав `config` для каждого
вида узла — в `operbots_catalog what=node_kinds`.

---

## Команды

```
operbots-mcp                 запустить сервер MCP (так его вызывает Claude Code)
operbots-mcp login           войти в панель и сохранить доступ
operbots-mcp logout          завершить сессию и удалить сохранённый доступ
operbots-mcp status          проверить связь с панелью и показать права
operbots-mcp tools           перечислить доступные инструменты
```

---

## Что не выведено наружу

* **Регистрация и смена пароля.** Заводить учётные записи и менять пароль — дело
  человека в панели, не помощника.
* **Вебхуки Telegram.** Служебные адреса, которые дёргает сам Telegram.
* **Выход на всех устройствах.** Слишком легко отрезать себе доступ одной фразой;
  в панели это делается осознанно.
* **Значения секретных переменных бота.** Панель отдаёт их в открытом виде, сервер
  скрывает — показывается только имя переменной.

---

## Разработка

```bash
npm install
npm run build       # сборка в dist/
npm run typecheck
npm start           # запуск сервера на стандартном вводе-выводе
```

Требуется Node 20 или новее.

Проверить сборку живым клиентом:

```bash
claude mcp add operbots-dev -- node /путь/к/operbots-mcp/dist/index.js
```

---

## Лицензия

MIT
