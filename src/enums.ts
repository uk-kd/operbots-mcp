/**
 * Перечисления, зафиксированные в коде панели.
 *
 * Держим их здесь, чтобы модель получала допустимые значения прямо в
 * описании инструмента и не тратила вызов на справочник. Если панель
 * пополнится новыми значениями, обновить нужно и этот файл — поэтому
 * рядом указано, откуда взято.
 */

/** `app/core/permissions.py` — Permission. */
export const PERMISSIONS = [
  'case.view',
  'case.edit',
  'case.delete',
  'case.transfer',
  'member.view',
  'member.invite',
  'member.edit',
  'member.remove',
  'role.view',
  'role.manage',
  'bot.view',
  'bot.create',
  'bot.edit',
  'bot.delete',
  'bot.control',
  'bot.token_reveal',
  'flow.view',
  'flow.edit',
  'flow.publish',
  'flow.delete',
  'market.publish',
  'chat.view',
  'chat.reply',
  'chat.takeover',
  'chat.broadcast',
  'chat.delete',
  'ai.view',
  'ai.manage',
  'knowledge.view',
  'knowledge.edit',
  'audit.view',
] as const;

/** `app/models/flow.py` — NodeKind: чем может быть узел полотна. */
export const NODE_KINDS = [
  'trigger.command',
  'trigger.text',
  'trigger.callback',
  'trigger.media',
  'trigger.event',
  'trigger.fallback',
  'action.message',
  'action.ai',
  'action.condition',
  'action.switch',
  'action.edit',
  'action.delete',
  'action.set_variable',
  'action.marks',
  'action.delay',
  'action.request',
  'action.handoff',
  'action.notify',
  'action.jump',
  'action.menu',
  'action.wait',
  'action.validate',
  'action.media',
  'action.schedule',
  'action.subscription',
  'action.report',
  'action.attempts',
  'action.reset',
  'action.compute',
  'action.keyboard',
  'action.form',
  'action.contact',
  'action.poll',
  'action.hours',
  'action.parse_date',
  'action.format_date',
  'action.schedule_at',
  'trigger.member',
  'trigger.post',
  'action.kick',
  'action.mute',
  'action.pin',
  'action.chat_title',
  'action.invite_link',
  'action.is_admin',
  'flow.split',
  'flow.merge',
  'flow.end',
] as const;

/**
 * `app/models/market.py` — MarketCategory: разделы маркета сценариев.
 * Готовые сценарии проекта переехали из заготовок формы создания сюда:
 * ставят их через market_install, а не через flows_save.
 */
export const MARKET_CATEGORIES = [
  'sales',
  'support',
  'booking',
  'survey',
  'ai',
  'notify',
  'other',
] as const;

/** `app/models/market.py` — MarketSource: кто выложил публикацию. */
export const MARKET_SOURCES = ['project', 'community'] as const;

/** `app/schemas/market.py` — Sort: порядок каталога маркета. */
export const MARKET_SORTS = ['popular', 'new', 'likes'] as const;

/** `app/bots/ai/registry.py` — виды подключаемых ИИ-сервисов. */
export const AI_KINDS = ['gigachat', 'yandexgpt', 'openai', 'openrouter', 'custom'] as const;

/** Роли-пресеты, создаваемые в каждом новом деле. */
export const ROLE_PRESETS = ['owner', 'admin', 'builder', 'operator', 'observer'] as const;

/**
 * `app/models/bot.py` — BotPlatform: во что панель умеет подключать бота.
 *
 * Список тот же, что отдаёт `GET /platforms`, и совпадение сторожит
 * проверка панели (`scripts/checks/platform_registry.py`). Пределы,
 * возможности и вид токена у каждой свои — за ними идите в
 * `operbots_catalog what=platforms`, а не гадайте по имени.
 */
export const BOT_PLATFORMS = ['telegram', 'max'] as const;

export const BOT_MODES = ['polling', 'webhook'] as const;
export const DIALOG_MODES = ['bot', 'operator'] as const;

/**
 * `app/models/flow.py` — FlowScope: для какой переписки сценарий.
 * dialog — личная, community — сообщества (группы и каналы). У бота по
 * одному включённому на вид; какой ведёт разговор, решает вид чата.
 */
export const FLOW_SCOPES = ['dialog', 'community'] as const;

/**
 * `app/schemas/chat.py` — DialogKind: отбор диалогов по виду чата.
 * private — личная переписка, community — все сообщества, group и
 * channel — только группы или только каналы.
 */
export const DIALOG_KINDS = ['private', 'community', 'group', 'channel'] as const;

/** `app/schemas/flow.py` — FlowSimulateRequest.event: что случилось в сообществе. */
export const SIMULATE_EVENTS = ['post', 'join', 'leave'] as const;
export const THEME_MODES = ['light', 'dark', 'auto'] as const;
export const DOCUMENT_SOURCES = ['text', 'url', 'file'] as const;

/** Какие ключи учётных данных нужны каждому виду ИИ-сервиса. */
export const AI_CREDENTIALS: Record<string, string> = {
  gigachat: 'authorization_key (обязательно), scope (по умолчанию GIGACHAT_API_PERS)',
  yandexgpt: 'api_key (обязательно), folder_id (обязательно)',
  openai: 'api_key (обязательно)',
  openrouter: 'api_key (обязательно)',
  custom: 'api_key (по желанию); обязателен base_url',
};

/** Модели, известные реестру. Поле `model` ими не ограничено. */
export const AI_MODELS: Record<string, string> = {
  gigachat: 'GigaChat, GigaChat-Pro, GigaChat-Max, GigaChat-2 (по умолчанию GigaChat)',
  yandexgpt: 'yandexgpt-lite, yandexgpt, yandexgpt-32k (по умолчанию yandexgpt-lite)',
  openai: 'gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, o4-mini (по умолчанию gpt-4o-mini)',
  openrouter:
    'openai/gpt-4o-mini, anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-001, ' +
    'meta-llama/llama-3.3-70b-instruct, deepseek/deepseek-chat',
  custom: 'зависит от вашего сервера; поле обязательно заполнить вручную',
};
