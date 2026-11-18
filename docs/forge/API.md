# Forge API (сервер Imaginarium, 10.10.2026)

Дополняет `docs/FORGE-CONTRACT.md`. Все маршруты под `/api/forge`. Изменяющие запросы проходят
существующую защиту `server/index.mjs`: loopback Host/Origin и заголовок `x-imaginarium-client: studio`.
Ответы — JSON; ошибки `{error: "текст по-русски", code}` с HTTP 4xx/5xx.

## Состояние и справочники

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/status` | `{blender:{path,version,ok}, godot:{path,version,ok}, library:{clips}, queue:{running,queued}, gpuLock:{name,held}}` |
| GET | `/steps` | реестр шагов: `[{step, title, kinds, inputs, params:{<имя>:{type,default,min,max,enum,title,help}}, gpu: true|false|'conditional', timeoutSec}]` (`'conditional'` — у `cleanup`: GPU нужен только при запекании на GPU) |
| GET | `/presets` | готовые конвейеры: `[{id, kind, title, steps:[{step, params}]}]` |

## Ассеты (паспорта)

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/assets` | краткий список паспортов `[{id,name,kind,updated,thumbnail,lastStatus}]` |
| POST | `/assets` | JSON `{name, kind, source:{type:'job'|'asset'|'upload'|'params', jobId?, assetId?, params?}, profile?}` или multipart: `file` (GLB/FBX/OBJ по сигнатуре, до 300 МБ) + поля `name`, `kind`, `source` (JSON), `profile` (JSON) → паспорт |
| GET | `/assets/:id` | паспорт `asset.json` целиком |
| PATCH | `/assets/:id` | `{name?, profile?, clips?, props?, fx?, qa?}`; `qa.reviewed` меняется только явным полем. Решение приёмки: `qa:{reviewed:true, decision:'approved'|'rework'|'rejected', comment?, game_unit?}` (сервер сам ставит `qa.at`; без `reviewed` флаг включается сам); `qa:{reviewed:false, decision:null}` сбрасывает решение; `comment` и `game_unit` отдельно меняют уже сохранённое решение. См. `docs/forge/REVIEW.md` |
| DELETE | `/assets/:id` | перенос в `<library>/trash/` (не удаление) |
| POST | `/assets/:id/run` | `{steps:[{step, params}]}` или `{preset}`; `from`: `'source'` (по умолчанию) | `'latest'` | `'v003'` (итог завершённой версии) → `{jobId, version, warnings}` |
| POST | `/assets/:id/export` | `{profile:'godot'|'space_quest'|'heroes_gates'|'iso8', params}` → `{jobId}` |
| GET | `/assets/:id/files/<version>/<stepDir>/<file>` | файл результата (белый список расширений, защита от `..`) |

## Задачи

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/jobs` | последние задачи |
| GET | `/jobs/:jobId` | `{id, assetId, version, status:'queued'|'running'|'completed'|'failed'|'cancelled', steps:[{step,status,progress,startedAt,finishedAt,result,logTail}], createdAt}` |
| POST | `/jobs/:jobId/cancel` | отмена; процесс Blender снимается вместе с дочерними |

Прогресс: опрос `GET /jobs/:jobId` раз в секунду (WebSocket — по желанию, если уже есть общий канал).

## Библиотека клипов

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/clips` | `<library>/animations/index.json` |
| POST | `/clips` | multipart `files[]` (.fbx, проверка сигнатуры «Kaydara FBX Binary» или ASCII FBX) → задача импорта |
| GET | `/clips/:clipId/poses` | `<id>.poses.json` для превью «палочками» |
| DELETE | `/clips/:clipId` | удаление из библиотеки |

## Пакеты

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/batch` | JSON `{items:[{name, kind, source, preset?|steps?}]}` или multipart: `items` (JSON) + `files[]`, у элемента `source:{type:'upload', fileIndex}` → `{batchId, items:[{assetId, jobId}]}` |
| GET | `/batch/:batchId` | сводка по элементам |

## Приёмка

Вкладка «Приёмка» в панели кузницы читает и пишет только эти маршруты и `PATCH /assets/:id`. Подробности — `docs/forge/REVIEW.md`.
Её режим «Журнал и рецепты» и самообучение (журнал производства, вердикты, рецепты классов, `POST /assets/:id/plan`) — маршруты `/learn/*`, `docs/forge/LEARN.md`.
`POST /assets/:id/run` принимает ещё `assetClass` (класс для рецепта) и `recipes: false` (без рецепта); ответ — `{jobId, version, warnings, assetClass, learned, recipeNotes}`.

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/review?batch=<имя>` | `{batch:{name, source:'state'|'library', stateFile, stateUpdated, decisionsFile, generatedAt}, counts:{total, reviewable, built, failed_qa, failed_forge, skipped, other, approved, rework, rejected, notReviewed}, items:[…]}`. Строка: `{assetId, name, kind, file, role, faction, handWeapon, notes, status:'built'|'failed_qa'|'failed_forge'|'incomplete'|'running'|'new'|'skipped'|'missing', label, tone:'good'|'warn'|'bad'|'busy'|'muted', reason, failedStep, failedStepTitle, error, tear:{gate, ok, failedClips, worst:{clip, tornPct, robePct, limitPct}, worstRobe, clips:[{clip, tornPct, robePct, limitPct, ok, frame, overFrames, frames, bones}]}|null, urls:{concept, compare, motion, sprites, markers, poses, glb}, glbStep, version, decision:{decision, comment, game_unit, at}|null, reviewable, canApprove}`. Без `batch` — пакет по умолчанию |
| POST | `/review/export` | тело `{batch?}`; пишет `review_decisions.json` рядом с файлом состояния пакета → `{ok, path, count, batch, counts}` |

Файл состояния пакета — `IMAGINARIUM_REVIEW_STATE` (по умолчанию `C:\Imaginarium\incoming\build\build.state.json`); другой пакет `?batch=pilot2` берётся из `<папка incoming>/pilot2/pilot2.state.json`. Файл решений — `IMAGINARIUM_REVIEW_DECISIONS` (по умолчанию рядом с файлом состояния). Заметки к концептам — `IMAGINARIUM_REVIEW_ROLES` (по умолчанию `roles.json` папки концептов). Нет файла состояния и пакет не назван — берутся все гуманоиды и существа библиотеки, собранные из генераций (`source.type:'job'`).

## Ракурсы (3D по нескольким видам)

Не под `/api/forge`, а под `/api/views` (сервер студии, `server/views.mjs`); защита та же: loopback и заголовок `x-imaginarium-client: studio`
для изменяющих запросов. Подробности — `docs/forge/views.md`. Слоты: `front`, `left`, `back`, `right` (+ `frontLeft`, `frontRight` без влияния на 3D).

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/api/views/status` | `{codex:{available,message,version}, mvadapter:{ready,reasons[]}, slots, shapeSlots}` (кеш 20 с) |
| POST | `/api/views` | `{imageId}` (ресурс из `/api/assets`) → 201 набор; тот же концепт возвращает тот же набор |
| GET | `/api/views/:id` | `{id, frontAssetId, slots:{<слот>:{filled, source:'input'|'manual'|'codex'|'mvadapter', seconds, thumb, full, …}}, normalized:{at,stale}, task:{status:'running'|'completed'|'failed'|'cancelled', provider, slots, message}, extraViews, canBuild, lastRun}` |
| GET | `/api/views/:id/image/:slot?kind=thumb|norm|raw` | картинка (`norm` — вход генератора формы 1536², `raw` — как получено) |
| PUT | `/api/views/:id/:slot` | multipart `file` (PNG/JPG/WEBP, до 40 МБ) → набор; свой ракурс, пока идёт генерация, — 409 |
| DELETE | `/api/views/:id/:slot` | убрать ракурс (вид спереди убрать нельзя) |
| POST | `/api/views/:id/generate` | `{provider:'codex'|'mvadapter', slots?:['left','back','right'], overwrite?:false, seed?, size?:512..768, steps?:8..60, note?}` → 202 набор с `task`; одновременно идёт одна генерация (иначе 409); заполняются только пустые слоты, если нет `overwrite` |
| POST | `/api/views/:id/cancel` | снять генерацию |

«3D по ракурсам» — обычное задание генерации: `POST /api/jobs` с `{imageId, viewSetId, quality, seed, meshLevel, …}`. Задание ждёт замок видеокарты,
берёт нормированные виды набора, грузит их в ComfyUI и строит граф `hunyuanMultiViewWorkflow` (Hunyuan3D-2mv); в записи задания `viewSetId`, `viewSlots`.

`shapeModel` у hunyuan-задания: `"auto"` (значение по умолчанию: на слабой карте — < 9216 MiB, тот же разрез, что у TripoSG-линии — и при установленных весах
Hunyuan3D-2mini форма строится им (файл 3,8 ГБ против 4,9 у 2.0), иначе берётся настроенный чекпоинт), `"default"` (настроенный чекпоинт, прежнее поведение),
`"hunyuan21"`, `"hunyuan2mini"`. `auto` разрешается в момент выполнения задания; разрешённый файл попадает в запись задания как `modelCheckpoint`.

### Движок 3D: Pixal3D (`engine`)

`POST /api/jobs` принимает `engine`: `"hunyuan"` (по умолчанию, поведение API не меняется), `"pixal3d"` или `"auto"` (Pixal3D, если установлен, иначе Hunyuan; в записи
задания всегда конкретное значение). С `pixal3d` поля `quality`, `shapeModel`, `meshLevel` не используются; без установки — 400 с причиной по-русски.
Работает и с `viewSetId` (до четырёх видов, граф `pixal3dWorkflow`), и с одним изображением. В записи задания: `engine`, `engineUrl`, `modelCheckpoint`,
`pixal3d:{seconds, slots, targetFaces, vramPeakMb, vramBaselineMb, scale}`. `POST /api/jobs/:id/reextract` для таких заданий возвращает ошибку (у Pixal3D нет «уровня поверхности»).
`GET /api/status` содержит `pixal3d:{installed, running, url, dir, missing[], message, estimate}`; `POST /api/runtime/pixal3d/start` запускает движок заранее (иначе он стартует сам
при первой генерации). Подробности: `docs/forge/pixal3d.md`.

## Коды ошибок

`not_found`, `bad_id`, `bad_path`, `busy`, `validation`, `no_local_paths` (по HTTP нельзя передать
локальный путь в параметрах — файлы загружаются), `fx_socket_missing` (маска эффекта не нашла сокетов
модели), `bad_glb`, `bad_json` (битое тело запроса; слишком большое — 413), `bad_state` (файл состояния пакета не читается, 503). Текст ошибки всегда по-русски.
Подробности реализации: `docs/forge/server.md`.

## Версии и разрешение входов

Библиотека `<library>` — `C:\Imaginarium\library` (или `IMAGINARIUM_LIBRARY`). Каждый запуск конвейера создаёт новую версию `<library>/assets/<id>/v00N/`; шаг `k` пишет в
`v00N/<kk>_<step>/` (`out_dir`). Вход шага берётся из выходов предыдущего: `outputs.blend` →
`inputs.blend`, иначе `outputs.glb` → `inputs.mesh`. Для первого шага — источник паспорта
(GLB генерации, загруженный файл) или ничего (генераторы `item_kit`, `ship_gen`, `turret_gen`).
Экспорт (`godot_package`, `render_sprites`) не меняет цепочку: его выходы пишутся отдельно, следующая модельная операция получает прежний `.blend`.
Особые входы: `attach_prop` — `inputs.character` = текущий результат, `inputs.item` = последний GLB
ассета из `props[].asset`; `render_sprites`, `godot_package` — текущий `.blend`/`.glb`.

## Командная строка

`node scripts/forge.mjs <команда>`: `status`, `assets`, `create --kind ship --name X [--from-glb path] [--preset id]`,
`run <assetId> --steps file.json | --preset id`, `batch file.json`, `clips import <папка>`,
`export <assetId> --profile space_quest --out <папка>`. Работает через запущенный сервер
(заголовок `x-imaginarium-client: studio`) или напрямую без сервера (`--direct`), используя тот же модуль
конвейера.
