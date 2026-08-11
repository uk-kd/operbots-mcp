/**
 * Общий контекст инструментов и разбор ссылок на дело и бота.
 *
 * Модель редко знает идентификаторы: она знает названия — «Магазин
 * Северный», «бот поддержки». Поэтому любой инструмент принимает и
 * UUID, и название, а разбор происходит здесь: один раз на процесс,
 * с коротким кэшем, чтобы не дёргать панель на каждом шаге.
 */

import type { OperbotsApi } from './api.js';
import type { AuthManager } from './auth.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Насколько долго держим список дел и ботов без перечитывания. */
const CACHE_TTL_MS = 30_000;

export interface CaseSummary {
  id: string;
  name: string;
  slug: string;
  emoji: string;
  is_archived: boolean;
  is_owner: boolean;
  role_name: string | null;
  permissions: string[];
  members_count: number;
  bots_count: number;
  running_bots_count: number;
  unread_count: number;
}

export interface BotSummary {
  id: string;
  name: string;
  username: string | null;
  status: string;
  is_enabled: boolean;
}

interface Cached<T> {
  at: number;
  value: T;
}

export class Context {
  private cases: Cached<CaseSummary[]> | null = null;
  private readonly bots = new Map<string, Cached<BotSummary[]>>();

  constructor(
    readonly api: OperbotsApi,
    readonly auth: AuthManager,
    readonly config: Config,
  ) {}

  // ── Дела ───────────────────────────────────────────────────

  /** Список дел пользователя (с коротким кэшем). */
  async caseList(refresh = false): Promise<CaseSummary[]> {
    if (!refresh && this.cases && Date.now() - this.cases.at < CACHE_TTL_MS) {
      return this.cases.value;
    }
    const value = await this.api.get<CaseSummary[]>('/cases', { include_archived: true });
    this.cases = { at: Date.now(), value };
    return value;
  }

  /** Сбрасывает кэш: вызывать после создания или удаления дела. */
  forgetCases(): void {
    this.cases = null;
    this.bots.clear();
  }

  /**
   * Находит дело по идентификатору, названию, короткому имени или эмодзи.
   *
   * Без подсказки берётся дело из настройки OPERBOTS_CASE, затем
   * последнее открытое в панели, и только если оно одно-единственное —
   * оно же. В остальных случаях честнее спросить, чем угадать.
   */
  async resolveCase(hint?: string | null): Promise<CaseSummary> {
    const wanted = hint?.trim() || this.config.defaultCase;

    if (wanted && UUID.test(wanted)) {
      const known = (await this.caseList()).find((item) => item.id === wanted);
      if (known) return known;
      // Дела может не быть в списке у суперпользователя — спросим напрямую.
      return this.api.get<CaseSummary>(`/cases/${wanted}`);
    }

    const list = await this.caseList();
    if (list.length === 0) {
      throw new ApiError(404, 'no_cases', 'У вас нет ни одного дела. Создайте его: cases_save.');
    }

    if (wanted) {
      // Короткое имя дела не содержит пробелов и кавычек — именно его
      // подставляет панель в готовую команду установки.
      const bySlug = list.find((item) => item.slug === wanted.toLowerCase());
      return bySlug ?? pickByName(list, wanted);
    }

    const me = await this.auth.whoami();
    const last = me.last_case_id ? list.find((item) => item.id === me.last_case_id) : undefined;
    if (last) return last;

    const active = list.filter((item) => !item.is_archived);
    if (active.length === 1 && active[0]) return active[0];

    throw new ApiError(
      400,
      'case_required',
      'Укажите дело: у вас их несколько.\n' +
        active.map((item) => `  ${item.emoji} ${item.name}`).join('\n'),
    );
  }

  // ── Боты ───────────────────────────────────────────────────

  async botList(caseId: string, refresh = false): Promise<BotSummary[]> {
    const cached = this.bots.get(caseId);
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const value = await this.api.get<BotSummary[]>(`/cases/${caseId}/bots`);
    this.bots.set(caseId, { at: Date.now(), value });
    return value;
  }

  forgetBots(caseId: string): void {
    this.bots.delete(caseId);
  }

  /** Находит бота по идентификатору, названию или @username. */
  async resolveBot(caseId: string, hint: string): Promise<BotSummary> {
    const wanted = hint.trim();
    if (UUID.test(wanted)) {
      const known = (await this.botList(caseId)).find((item) => item.id === wanted);
      return known ?? this.api.get<BotSummary>(`/cases/${caseId}/bots/${wanted}`);
    }

    const list = await this.botList(caseId);
    if (list.length === 0) {
      throw new ApiError(404, 'no_bots', 'В этом деле нет ни одного бота. Подключите: bots_save.');
    }

    const handle = wanted.replace(/^@/, '').toLowerCase();
    const byUsername = list.filter((item) => item.username?.toLowerCase() === handle);
    if (byUsername.length === 1 && byUsername[0]) return byUsername[0];

    return pickByName(list, wanted);
  }
}

/**
 * Выбирает запись по названию: сначала точное совпадение, затем
 * вхождение подстроки. Неоднозначность — это ошибка, а не повод
 * взять первое попавшееся: не тот бот получит не то сообщение.
 */
function pickByName<T extends { id: string; name: string }>(list: T[], wanted: string): T {
  const needle = wanted.toLowerCase();

  const exact = list.filter((item) => item.name.toLowerCase() === needle);
  if (exact.length === 1 && exact[0]) return exact[0];

  const partial = exact.length > 1 ? exact : list.filter((item) => item.name.toLowerCase().includes(needle));
  if (partial.length === 1 && partial[0]) return partial[0];

  if (partial.length === 0) {
    throw new ApiError(
      404,
      'not_found',
      `Не нашёл «${wanted}». Есть: ${list.map((item) => item.name).join(', ')}`,
    );
  }

  throw new ApiError(
    400,
    'ambiguous',
    `Под «${wanted}» подходит несколько: ${partial.map((item) => `${item.name} (${item.id})`).join('; ')}. ` +
      'Уточните название или передайте идентификатор.',
  );
}
