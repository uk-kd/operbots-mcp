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
  'chat.view',
  'chat.reply',
  'chat.takeover',
  'chat.delete',
  'ai.view',
  'ai.manage',
  'audit.view',
] as const;

/** `app/models/flow.py` — NodeKind: чем может быть узел полотна. */
export const NODE_KINDS = [
  'trigger.command',
  'trigger.text',
  'trigger.callback',
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
  'action.hours',
  'action.parse_date',
  'action.format_date',
  'action.schedule_at',
  'flow.split',
  'flow.merge',
] as const;

/** `app/services/flow_templates.py` — заготовки стартового графа. */
export const FLOW_TEMPLATES = [
  'blank',
  'ai_consultant',
  'faq_menu',
  'lead_form',
  'booking',
  'support_desk',
  'onboarding',
] as const;

/** `app/bots/ai/registry.py` — виды подключаемых ИИ-сервисов. */
export const AI_KINDS = ['gigachat', 'yandexgpt', 'openai', 'openrouter', 'custom'] as const;

/** Роли-пресеты, создаваемые в каждом новом деле. */
export const ROLE_PRESETS = ['owner', 'admin', 'builder', 'operator', 'observer'] as const;

export const BOT_MODES = ['polling', 'webhook'] as const;
export const DIALOG_MODES = ['bot', 'operator'] as const;
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
