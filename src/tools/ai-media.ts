/** Файлы, аудио, потоковые пробы и персистентные задачи ИИ панели. */
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { report } from '../format.js';
import { findProvider } from './bots.js';
import { body, caseField, tool, type Tool } from './kit.js';

const providerField = z.string().min(1).describe('Подключение: название или идентификатор.');
const modelField = z.string().max(120).optional();
const optionsField = z.record(z.string(), z.unknown()).optional();

export const aiMediaTools: Tool[] = [
  tool({
    name: 'ai_models', title: 'Актуальные модели подключения', kind: 'write',
    description: 'Запрашивает список моделей у сервиса по ключу подключения. Это внешний запрос; возможности режима смотрите в operbots_catalog what=ai_kinds.',
    input: { case: caseField, provider: providerField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      return report('Модели подключения.', await ctx.api.post(`/cases/${found.id}/ai-providers/${provider.id}/models`));
    },
  }),
  tool({
    name: 'ai_stream', title: 'Проверить потоковый ответ ИИ', kind: 'write',
    description: 'Выполняет платную потоковую пробу chat/responses и возвращает собранный ответ, ID и расход. Обрыв и ошибка потока возвращаются ошибкой. Не повторяйте автоматически после таймаута.',
    input: { case: caseField, provider: providerField, prompt: z.string().min(1).max(2000),
      mode: z.enum(['chat', 'responses']).optional(), model: modelField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      const { case: _, provider: __, ...payload } = args;
      const text = await ctx.api.postText(`/cases/${found.id}/ai-providers/${provider.id}/stream`, body(payload));
      return report('Потоковая проба завершена.', streamResult(text));
    },
  }),
  tool({
    name: 'ai_speech', title: 'Синтезировать речь', kind: 'write',
    description: 'Платный синтез речи. Возвращает файл дела; скачайте его через ai_files_download. Возможности и параметры модели берите из каталога.',
    input: { case: caseField, provider: providerField, text: z.string().min(1).max(5000), model: modelField,
      voice: z.string().max(64).optional(), response_format: z.string().max(16).optional(),
      speed: z.number().min(0.25).max(4).optional(), instructions: z.string().max(1000).optional(), options: optionsField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      const { case: _, provider: __, ...payload } = args;
      return report('Файл речи создан.', await ctx.api.post(`/cases/${found.id}/ai-providers/${provider.id}/speech`, body(payload)));
    },
  }),
  tool({
    name: 'ai_transcribe', title: 'Расшифровать аудиофайл', kind: 'write',
    description: 'Платная расшифровка файла дела. Сначала загрузите звук через ai_files_upload; file — UUID файла панели.',
    input: { case: caseField, provider: providerField, file: z.uuid(), model: modelField,
      language: z.string().max(16).optional(), prompt: z.string().max(2000).optional(),
      response_format: z.string().max(16).optional(), options: optionsField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      const { case: _, provider: __, file, ...payload } = args;
      return report('Расшифровка.', await ctx.api.post(`/cases/${found.id}/ai-providers/${provider.id}/transcribe`, body({ file_id: file, ...payload })));
    },
  }),
  tool({
    name: 'ai_files_list', title: 'Файлы ИИ дела', kind: 'read',
    description: 'Файлы ИИ с назначением, размером, привязкой к сервису и ID результатов задач.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Файлы ИИ.', await ctx.api.get(`/cases/${found.id}/ai-files`));
    },
  }),
  tool({
    name: 'ai_files_get', title: 'Метаданные файла ИИ', kind: 'read',
    description: 'Читает карточку конкретного файла дела.',
    input: { case: caseField, file: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Файл ИИ.', await ctx.api.get(`/cases/${found.id}/ai-files/${args.file}`));
    },
  }),
  tool({
    name: 'ai_files_upload', title: 'Загрузить файл ИИ', kind: 'write',
    description: 'Сохраняет локальный файл в деле и отправляет копию сервису. Для user_data/messages обязательны target_models. Лимит MCP: 20 МиБ, batch JSONL — 50 МиБ; панель может иметь меньший лимит. При отсутствии remote_id локальная копия уже сохранена: не загружайте повторно вслепую.',
    input: { case: caseField, provider: providerField, path: z.string().min(1).describe('Абсолютный локальный путь.'),
      purpose: z.enum(['user_data', 'messages', 'batch']),
      target_models: z.array(z.string().trim().min(1)).optional().describe('Целевые модели обязательны для user_data/messages; для batch не нужны.') },
    async run(args, ctx) {
      if (args.purpose !== 'batch' && !args.target_models?.length) throw new ApiError(400, 'target_models_required', 'Для user_data/messages укажите непустой target_models.');
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      return report('Файл сохранён; проверьте remote_id.', await ctx.api.upload(`/cases/${found.id}/ai-files`, args.path,
        { provider_id: provider.id, purpose: args.purpose, target_models: (args.target_models ?? []).join(',') },
        undefined, (args.purpose === 'batch' ? 50 : 20) * 1024 * 1024));
    },
  }),
  tool({
    name: 'ai_files_refresh', title: 'Обновить метаданные файла ИИ', kind: 'write',
    description: 'Запрашивает метаданные удалённой копии у сервиса и обновляет карточку панели.',
    input: { case: caseField, file: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Карточка обновлена.', await ctx.api.post(`/cases/${found.id}/ai-files/${args.file}/refresh`));
    },
  }),
  tool({
    name: 'ai_files_download', title: 'Скачать файл ИИ', kind: 'read',
    description: 'Сохраняет содержимое файла дела по абсолютному локальному пути. Не перезаписывает существующие файлы; предел 100 МиБ.',
    input: { case: caseField, file: z.uuid(), destination: z.string().min(1) },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Файл скачан.', await ctx.api.download(`/cases/${found.id}/ai-files/${args.file}/content`, args.destination));
    },
  }),
  tool({
    name: 'ai_files_delete', title: 'Удалить файл ИИ', kind: 'danger',
    description: 'Удаляет удалённую копию и файл дела. Ошибка сервиса останавливает удаление; операция необратима.',
    input: { case: caseField, file: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Файл удалён.', await ctx.api.delete(`/cases/${found.id}/ai-files/${args.file}`));
    },
  }),
  tool({
    name: 'ai_jobs_list', title: 'Задачи ИИ дела', kind: 'read',
    description: 'Список Batch/Video задач с состоянием, ошибками и сохранёнными результатами. Не запускает опрос внешнего сервиса.',
    input: { case: caseField },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Задачи ИИ.', await ctx.api.get(`/cases/${found.id}/ai-jobs`));
    },
  }),
  tool({
    name: 'ai_jobs_get', title: 'Карточка задачи ИИ', kind: 'read',
    description: 'Сохранённое состояние задачи, remote_id, input_file_id и результат. Файлы результата скачиваются через ai_files_download.',
    input: { case: caseField, job: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Задача ИИ.', await ctx.api.get(`/cases/${found.id}/ai-jobs/${args.job}`));
    },
  }),
  tool({
    name: 'ai_jobs_create', title: 'Создать задачу Batch или Video', kind: 'write',
    description: 'Ставит платную задачу. Для batch нужен input_file (JSONL purpose=batch) и payload.endpoint; для video — payload.prompt и модель. idempotency_key задайте один раз и сохраняйте при повторе того же запроса; новый ключ создаёт новую задачу.',
    input: { case: caseField, provider: providerField, kind: z.enum(['batch', 'video']), input_file: z.uuid().optional(),
      payload: optionsField, idempotency_key: z.string().trim().min(1).max(120) },
    async run(args, ctx) {
      if (args.kind === 'batch' && !args.input_file) throw new ApiError(400, 'input_file_required', 'Для batch нужен input_file из ai_files_upload.');
      const found = await ctx.resolveCase(args.case);
      const provider = await findProvider(ctx, found.id, args.provider);
      return report('Задача создана.', await ctx.api.post(`/cases/${found.id}/ai-jobs`, body({ provider_id: provider.id,
        kind: args.kind, input_file_id: args.input_file, payload: args.payload, idempotency_key: args.idempotency_key })));
    },
  }),
  tool({
    name: 'ai_jobs_cancel', title: 'Отменить Batch-задачу', kind: 'danger',
    description: 'Отправляет отмену Batch-задачи сервису. Уже выполненная работа может быть оплачена. Video этот маршрут не отменяет.',
    input: { case: caseField, job: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Результат отмены.', await ctx.api.post(`/cases/${found.id}/ai-jobs/${args.job}/cancel`));
    },
  }),
  tool({
    name: 'ai_jobs_candidates', title: 'Кандидаты восстановления Batch-задачи', kind: 'write',
    description: 'Запрашивает внешний список Batch-задач для сверки после неопределённого результата отправки. Выберите remote_id явно и передайте в ai_jobs_reconcile.',
    input: { case: caseField, job: z.uuid() },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Кандидаты восстановления.', await ctx.api.get(`/cases/${found.id}/ai-jobs/${args.job}/reconcile`));
    },
  }),
  tool({
    name: 'ai_jobs_reconcile', title: 'Привязать задачу ИИ к внешней', kind: 'write',
    description: 'Восстанавливает связь по явно выбранному remote_id после неопределённого результата отправки. Панель проверяет соответствие; повторно платную задачу не создаёт.',
    input: { case: caseField, job: z.uuid(), remote_id: z.string().trim().min(1).max(120) },
    async run(args, ctx) {
      const found = await ctx.resolveCase(args.case);
      return report('Связь восстановлена.', await ctx.api.post(`/cases/${found.id}/ai-jobs/${args.job}/reconcile`, { remote_id: args.remote_id }));
    },
  }),
];

function streamResult(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = { text: '' };
  let done = false;
  for (const event of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data.trim()) continue;
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { throw new ApiError(502, 'bad_stream', 'Повреждённое событие потока ИИ.'); }
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new ApiError(502, 'bad_stream', 'Повреждённое событие потока ИИ.');
    const value = chunk as Record<string, unknown>;
    if (value.error) throw new ApiError(502, 'ai_stream_failed', String(value.error));
    if (typeof value.text_delta === 'string') result.text += value.text_delta;
    for (const key of ['response_id', 'model', 'usage']) if (value[key]) result[key] = value[key];
    if (value.done === true) done = true;
  }
  if (!done) throw new ApiError(502, 'incomplete_stream', 'Поток ИИ оборвался без подтверждения завершения.');
  return result;
}
