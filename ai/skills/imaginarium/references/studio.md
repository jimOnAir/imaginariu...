# Imaginarium: устройство и использование студии

Версия приложения 0.3.0, git `master` (`a7d5cfc` на 17.10.2026). Источники: `README.md`, `ARCHITECTURE.md`, `docs/forge/*.md`, `docs/FORGE-CONTRACT.md`,
`server/*.mjs`, `scripts/*.mjs`, `scripts/blender/steps/`, `src/App.jsx`. Часть документов отстаёт от кода (см. «Расхождения» в `troubleshooting.md`);
здесь числа сверены с кодом. Интерфейс и все сообщения — по-русски.

## 1. Архитектура

```
Браузер (React 19 + three.js 0.180, Vite)  ─►  Express :3210 (127.0.0.1, server/index.mjs)
                                                 │
        ┌────────────────────────────────────────┼───────────────────────────────────────────┐
        │ генерация (server/jobs.mjs, очередь ≤ 4)│ Кузница (server/forge*.mjs, /api/forge/*)  │ вкладка VFX (server/vfx-tools.mjs)
        │  ├─ ComfyUI студии :8190 (Hunyuan3D,    │  ├─ очередь Blender (по 1; server/blender.mjs) │  └─ веб-генераторы :3211
        │  │   SDXL, MV-Adapter; D:\ComfyUI)      │  │   blender -b --python imaginarium_run.py -- <шаг>    │
        │  └─ ComfyUI-Pixal3D :8191 (форма)       │  ├─ Godot 4.5.1 headless (проверка пакетов)     │ Ollama :11434 (помощник, qwen3-vl)
        │ общий замок видеокарты Global\HG_GPU_RENDER (server/gpu-lock.mjs, gpu-handover.mjs)       │
        └──────────────────────────────────────────────────────────────────────────────────────────┘
Паспорта ассетов, версии, клипы, пакеты: <library> (C:\Imaginarium\library). Данные студии (проекты, генерации): <APP>\data.
```

- Сервер слушает только `127.0.0.1`. Защита: Host ∈ {127.0.0.1, localhost}; Origin = свой хост; **любой не-GET запрос к `/api` требует заголовок `x-imaginarium-client: studio`**
  (иначе 403 «Запрос должен быть отправлен из студии»). Папки `/data /server /scripts /tests` по HTTP отдают 404.
- Генерация: максимум 4 задания в очереди; LLM и 3D не работают одновременно (одна видеокарта; в ответе «Дождитесь…»).
- Основной ComfyUI владельца на 8188 студия **не использует и не перенастраивает**. Её ComfyUI на 8190 — отдельный процесс из кода/`.venv` ComfyUI (см. `components.md`).
- Запуск: `Start.cmd` → `scripts\Start.ps1 [-NoBrowser]` (читает `config\paths.json`, прячет окно node, ждёт `/api/health` до 20 с, открывает браузер).
  Если на 3210 уже отвечает `{"app":"Imaginarium"}`, ничего не запускает; чужое приложение на порту — ошибка. При старте сервер сам поднимает ComfyUI 8190, если в
  `data\models\checkpoints` лежит `hunyuan3d-dit-v2.safetensors`. Pixal3D стартует **по требованию** (первое задание, ≈ 6 с на тёплой машине, 1–2 мин холодный)
  или `POST /api/runtime/pixal3d/start`; уже работающий вручную экземпляр студия использует и не останавливает.
- Остановка: `Stop.cmd`. Журналы: `data\runtime\server.log`, `server-error.log`, `comfy.log`, `pixal3d.log`; журналы Blender — `<runtime>\blender\<jobId>\<шаг>.log`.
- Просмотр результатов: вкладка → «Показать в сцене» у любого результата с GLB.

## 2. Вкладки интерфейса (левая колонка; 10 вкладок в `src/App.jsx`)

| Вкладка | Что делает |
|---|---|
| **Создать** | Концепт (PNG/JPG/WEBP: один объект на нейтральном фоне) или описание (SDXL → картинка). Категория: существо / предмет / корабль. **«Ракурсы»**: из вида спереди (персонаж в T-позе) создаёт слева/сзади/справа — источник «ChatGPT» (через Codex, лучше по деталям) или «Локально» (MV-Adapter), либо свои файлы в любой слот. **«Движок 3D»**: Pixal3D (точнее, ≈ 4 мин, ≈ 10 ГБ VRAM; по умолчанию, если установлен) или Hunyuan3D (быстрее). «Качество геометрии» (только Hunyuan): draft/standard/high, форма Hunyuan 2.0/2.1, уровень поверхности, seed, фон auto/alpha/keep. Кнопки **«Создать 3D-модель»** (по одному изображению) и **«Создать 3D по ракурсам»** (2–4 вида). Результат — GLB в сцене и в «Результатах» |
| **Кузница** | Мастер на Blender: *Что создаём → Подготовка → Скелет → Движения → Предметы → Эффекты → Экспорт*; «Задачи» (все сборки, прогресс, журнал, отмена), «Пакет» (серии: зёрна, папки GLB), «Приёмка» (концепт рядом с анимацией: Одобрить / На доработку / Брак, поле «Юнит игры», экспорт решений). Подробно — `docs/forge/ui.md`, `REVIEW.md` |
| **Кости** | Старый браузерный редактор: шаблоны Humanoid/Quadruped/Mechanical/Custom, привязка по расстоянию, кисть весов, клипы Idle/Walk/Run (процедурные заготовки), экспорт GLB со скелетом. Не авториг (для игровых персонажей — «Кузница») |
| **Текстуры** | UV-атлас (xatlas, на CPU), процедурные PBR-карты 512–4096 (металл, камень, дерево, ткань), кисть по Base Color, «Запечь видимый цвет» с референса, «Сравнить с референсом» (силуэт IoU, подбор камеры) |
| **Анимация** | Вращение/парение/полёт, ключевые кадры, длительность 1–60 с; запись WebM 30 к/с; экспорт сцены |
| **Эффекты** | Эмиттеры частиц на модели/кости (12 пресетов Кузницы + «Пустой»), живой предпросмотр, генератор текстур (10 типов, 20 рецептов, флипбуки), «ZIP для Godot 4.5». → скилл `imaginarium-vfx` |
| **VFX** | Каталог 31 внешнего генератора текстур, запуск/установка/папка, готовые PNG накладываются на объект. → скилл `imaginarium-vfx` |
| **Спрайты** | Изометрические спрайты 8 направлений (35° над горизонтом, прозрачный фон), ZIP «PNG + Godot SpriteFrames `.tres`», «Запечь все клипы в GLB». (Профили игр и качество — шаги Кузницы `render_sprites`) |
| **AI** | Помощник: локальная Ollama (по умолчанию `qwen3-27b-cc:latest`) либо свой OpenAI-совместимый эндпоинт (адрес + имя модели, ключ по желанию); предлагает безопасные изменения (материал, трансформ, движение, эффект), применяются кнопкой; произвольный код и команды ОС не исполняются |
| **Tripo** | Облачный Tripo (15 операций через официальный SDK); платные задачи **без решения владельца не запускать** |

Снизу слева: «Импорт 3D» (GLB, OBJ, STL; GLB только со встроенными текстурами), «Результаты». Сверху: «Проекты» (`.imaginarium.json`/gzip, до 512 МБ распакованным),
экспорт GLB/OBJ/WebM/PNG/проект (копия каждого экспорта кладётся в `data\exports`). Горячие клавиши: W/E/R, F, пробел, Delete, Ctrl+D/S/Z, Ctrl+Shift+Z.
Несохранённая сцена после перезагрузки страницы не восстанавливается.

## 3. Кузница: паспорт, версии, библиотека

- **Паспорт ассета** `<library>\assets\<uuid>\asset.json`: `id, name, kind (humanoid|creature|item|ship|prop), created, updated, source, profile ({height_m,…}), pipeline[], clips[], props[], fx[], exports[], qa, versions[]`.
  `source.type`: `job` (генерация студии), `asset` (другой паспорт/модель студии), `upload` (GLB/FBX/OBJ до 300 МБ по сигнатуре), `params` (генераторы без файла).
- **Версии** `v001, v002, …` — рецепт запуска, **не перезаписываются**; шаг k пишет в `v00N\<kk>_<шаг>\` (`request.json`, `result.json`, выходы). `from`: `source` (по умолчанию), `latest`, `v003`.
  Повтор рецепта даёт ту же геометрию. Экспорт всегда от последней завершённой версии. Шаги экспорта (`godot_package`, `render_sprites`) модель не меняют.
- **Результат шага** (`IMAGINARIUM_RESULT {json}` / `result.json`): `ok, outputs{glb,blend,preview,…}, stats, checks[{name,ok,value,limit,severity}], warnings`. Проверка с `severity:error` и `ok:false` валит шаг;
  предупреждения — нет. Пути абсолютные.
- **Корзина**: удаление = перенос в `<library>\trash\`. `qa.reviewed` ставит только человек (вкладка «Приёмка»).
- Раскладка библиотеки: `assets\`, `jobs\<jobId>.json`, `batches\`, `trash\`, `animations\{index.json,mixamo\,quaternius\}`, `kits\`, `props\`, `rigs\`.
- Соглашения: Z вверх, метры; персонажи и существа смотрят в **−Y** Blender (как Mixamo; в glTF +Z); корабли/турели/реквизит Space Quest — нос **+Y** (в glTF −Z).
  Кости людей — имена Mixamo (`mixamorig:*`, 25 основных + пальцы). Сокеты `socket_<вид>_<место>` + `extras.game_socket`: у человека `socket_mount_hand_r|l`,
  `socket_mount_shield_r|l`, `socket_mount_back`, `socket_mount_hip_*`, `socket_fx_head`, `socket_fx_chest`; у предмета `socket_grip_main|off`, `socket_fx_tip`.
- Очередь: Blender по одному (`IMAGINARIUM_BLENDER_CONCURRENCY`), таймаут шага 15 мин (чистка 30, рендер 60). GPU-шаги (`render_sprites`; `cleanup` при `voxel_remesh_m>0` и `bake_device=GPU`) берут замок видеокарты.

## 4. CLI `node scripts/forge.mjs …` (из папки APP)

```
status                                  Blender, Godot, библиотека, очередь, замок GPU
steps | presets                         реестр шагов (с параметрами) и готовые конвейеры
assets | show <id>                      паспорта | один паспорт (версии, конвейер, экспорты)
create --kind humanoid|creature|item|ship|prop --name <имя>
       источник: --from-glb <GLB|FBX|OBJ> | --from-job <jobId> | --from-asset <id> | --params <json|файл>
       рецепт:   [--preset <id> | --steps <файл.json>]
run <assetId> (--steps файл.json | --preset id) [--from source|latest|v003]
export <assetId> --profile godot|space_quest|heroes_gates|iso8 [--params <json|файл>] [--out <папка>]
batch <items.json>                      {"items":[{name, kind, source, preset|steps}]}
clips [list] | clips import <папка FBX> | clips remove <clipId>
jobs | job <jobId> [--wait] | cancel <jobId>
общие: --direct (без сервера, в этом процессе) --json --server <URL> --no-wait
```
`--direct` читает пути только из переменных `IMAGINARIUM_*` (не из `paths.json`!). Файл `--steps` — массив `[{"step":"cleanup","params":{…}}, …]`; в Blender уходят только заданные параметры.
Другие скрипты: `scripts/forge-concepts.mjs` (пачка «папка концептов → генерация → ассеты → спрайты и Godot», резюмируемая, `--dry`), `scripts/forge-smoke.mjs`,
`scripts/views/views_generate.mjs` (ракурсы), `scripts/views/views_3d.mjs` (3D по набору видов: `--engine pixal3d|hunyuan|auto`), `scripts/parts/build_parts.py` (по частям),
`scripts/vfx/Install-VfxTools.ps1`.

## 5. Шаги конвейера (28; `server/forge-steps.mjs`, `GET /api/forge/steps`)

| Шаг (модуль) | Назначение | Виды |
|---|---|---|
| `inspect` (core) | импорт и статистика: треугольники, размеры, скелет, клипы; лист видов | все |
| `cleanup` | масштаб/пол/сварка/мусор/упрощение до `target_tris`; `voxel_remesh_m` — воксельный ремеш с запеканием цвета (нужен для рваных сеток Pixal3D, вреден на целых); GPU условно | все |
| `convert` | GLB ↔ FBX ↔ OBJ; `mixamo:true` — FBX для загрузки на mixamo.com | все |
| `separate` | разбить сетку на части/удалить/разрез `slit` (рукав от мантии) | все |
| `replace_part` | заменить область (череп, кисть, навершие) деталью, сгенерированной по увеличенному кропу | все |
| `place_parts` | расставить копии детали по поверхности/позам (застёжки, пуговицы, камни) | все |
| `paint_from_concept` (paint) | цвет для голой геометрии по картинке концепта (камера по силуэту, спина «насквозь», карта свечения); `concept_asset`/`concept_file` | все |
| `assemble_parts` (parts) | голова/торс/руки/ноги генерируются отдельно (`scripts/parts`) и сплавляются в одну сетку | humanoid |
| `extract_props` (items) | вырезать меч/щит/знамя/лук/посох/книгу из сгенерированного тела в отдельные GLB с сокетами | humanoid |
| `rig_humanoid` (humanoid) | авториг с костями Mixamo, маркеры, веса, сокеты, проверки пропорций и разрывов (`deform_gate`), `hard_surface` (жёсткие латы), `markers` для ручной правки | humanoid |
| `prepare_mixamo` / `import_mixamo_rig` | FBX для ручной загрузки на mixamo.com / принять скачанный риг («With Skin») | humanoid |
| `retarget` (mixamo) | клипы библиотеки на скелет персонажа (IK ног, швы петель); `root_motion lock/keep/extract`; `clips:[{source:"library:<id>",name,loop,in_place}]` | humanoid |
| `motion_style` | своя походка и процедурная смерть на персонажа (`seed`, `death`: library/auto/fall_back/fall_forward/fall_left/fall_right/kneel_collapse/spin_fall/slump_sit/crumble; `build`: heavy/armored/robed/light/skeleton/zombie), замер разрывов сетки по реальным клипам | humanoid |
| `cloth_sim` | физика ткани мантий/плащей/знамён по клипам (кэш для спрайтов, тканевые кости для GLB) | humanoid |
| `clip_library` | сканирование/импорт/удаление/превью клипов (одна задача за раз) | — |
| `rig_creature` / `anim_creature` (creatures) | риг по шаблону (quadruped, winged_quadruped, bird, hexapod, octopod, serpent, custom, auto) / процедурные клипы покой-шаг-бег-полёт-атака-удар-смерть | creature |
| `item_kit` (items) | процедурное оружие/щиты/посохи/зелья/бластеры (22 вида: sword, greatsword, dagger, axe, battle_axe, mace, warhammer, spear, halberd, staff, wand, bow, crossbow, shield_round, shield_kite, shield_tower, buckler, torch, potion, book, blaster_pistol, blaster_rifle), `seed`, пакет вариантов | item/prop |
| `item_from_mesh` | сгенерированный меш → игровой предмет (ось, хват, бюджет) | item/prop |
| `attach_prop` | предмет в руку/на щитовой сокет; `extracted:true` — вернуть вырезанные предметы; проверка пересечений по клипам | humanoid/creature |
| `bone_kit` | детали нежити без генерации: скелетная кисть (27 костей), костяной посох, застёжка | item/prop |
| `ship_gen` (ships) | процедурный корабль: 9 классов (fighter, interceptor, gunship, corvette, freighter, miner, frigate, carrier, transport), 4 стиля (industrial, military, sleek, alien), LOD, сокеты по контракту Space Quest | ship |
| `turret_gen` | турель `socket_mount → pivot_yaw → pivot_pitch → socket_muzzle_*` | ship/prop |
| `ship_from_mesh` | сгенерированный меш → корабль: нос +Y, бюджет класса, материалы `SQ_*`, сокеты, LOD, броня, надписи | ship |
| `kitbash` | гатлинги, сопла, трубы, антенны, огни на сокетах готовой модели | ship/prop |
| `render_sprites` (export) | листы спрайтов по направлениям и клипам; профили `iso8`, `heroes_gates`, `custom`; GPU | все |
| `godot_package` | GLB + `.tscn` + `ima_fx_mount.gd` + `fx/*.tscn` + README + запись реестра; проверка настоящим Godot 4.5.1 | все |
| `vrm_package` | персонаж одним `.vrm` (VRM 1.0 через VRM-аддон: кости по спеке, мета, выражения из поддерживаемого лицом); чего не хватает — честно в `report`; проверка экспорта ждёт установки компонента (`installer -Only vrmaddon`) | humanoid |

Подробности — `docs/forge/<модуль>.md` (core, humanoid, mixamo, motion_style, cloth_sim, extract_props, paint_from_concept, creatures, items, bone_kit, ships, kitbash, replace_part, parts, export, necromancer, bevy, unity, vrm_package).

### Готовые конвейеры (`presets`)
`humanoid_from_mesh` (cleanup → rig_humanoid → retarget → godot_package), `humanoid_hg_sprites` (… → render_sprites `heroes_gates` → godot_package), `humanoid_face_checked`, `humanoid_vrm` (cleanup → rig_humanoid → retarget → vrm_package), `creature_auto`, `sculpt_refine`, `item_kit_sword`, `item_from_mesh`,
`ship_procedural`, `ship_from_mesh`, `turret`. Расширенная цепочка бойца «Врат» (`forge-concepts.mjs`): cleanup → paint_from_concept → extract_props → rig_humanoid → retarget → attach_prop (extracted) →
motion_style → cloth_sim → render_sprites → godot_package.

Пример `steps.json` для гуманоида из Pixal3D/Hunyuan-GLB (параметры сверять с `forge.mjs steps`):
```json
[{"step":"cleanup","params":{"target_tris":24000,"height_m":1.8}},
 {"step":"paint_from_concept","params":{}},
 {"step":"rig_humanoid","params":{"height_m":1.8}},
 {"step":"retarget","params":{"root_motion":"lock","clips":[
   {"source":"library:quaternius-idle-loop","name":"idle","loop":true},
   {"source":"library:quaternius-walk-loop","name":"walk","loop":true,"in_place":true},
   {"source":"library:quaternius-sword-attack","name":"attack","in_place":true},
   {"source":"library:quaternius-hit-chest","name":"hit"},
   {"source":"library:quaternius-death01","name":"death","in_place":true}]}},
 {"step":"render_sprites","params":{"profile":"heroes_gates","in_place":"drift"}},
 {"step":"godot_package","params":{"profile":"godot"}}]
```

## 6. Генерация 3D (вкладка «Создать» / `POST /api/jobs`)

| Движок | Вход | Время (RTX 4070) | VRAM | Заметки |
|---|---|---|---|---|
| **Pixal3D** (основной с 14.10) | 1–4 вида (перед обязателен) | 4 вида ≈ 232–243 с; 1 вид ≈ 262–355 с | ≈ 9,5–10,8 ГБ (1 вид 6,4) | только форма (текстуры — `paint_from_concept`); фиксированные параметры: heun, 25 шагов грубой формы, по 12 на 512/1024, ≈ 700 тыс. граней, FOV 0,1 рад и азимуты 0/90/180/270 для нескольких видов; «переизвлечь поверхность» недоступно; IoU силуэта 4 вида 0,971/0,937/0,940/0,938 |
| Hunyuan3D-2 / 2mv / 2.1 | изображение; 2mv — 2–4 вида | 2mv `high`: 2 вида ≈ 155 с, 4 вида ≈ 176–180 с | ≈ 6,7 ГБ в памяти после задания (замер передачи карты) | `quality` draft(15 шагов, 128) / standard(25, 256) / high(45, 512); `meshLevel` −1…1; seed; свой Marching Cubes (`ImaginariumMesh`) |
| Ракурсы: ChatGPT / MV-Adapter | вид спереди | ≈ 57–65 с на вид / ≈ 34 с на все | — / ≈ 9,7 ГБ при 640 px | MV-Adapter придумывает спину (на ополченце ошибся), ChatGPT точнее; для чистовых моделей — ChatGPT или свои виды |

`POST /api/jobs` тело: `{imageId?, prompt?, quality, shapeModel: "default"|"hunyuan21", meshLevel, backgroundMode: "auto"|"alpha"|"keep", hazeFilter: "auto"|"on"|"off", seed, viewSetId?, engine: "hunyuan"|"pixal3d"|"auto"}`
(по умолчанию `hunyuan`; `auto` = Pixal3D, если установлен). Два движка не держат видеокарту одновременно: перед заданием студия ждёт, пока другой закончит, и просит его выгрузить модели.
Нормировка выхода: центр в нуле, высота 2, перед −Y после импорта в Blender.

## 7. API (все под `http://127.0.0.1:3210`)

| Группа | Маршруты |
|---|---|
| Студия | `GET /api/health`, `GET /api/status` (ollama, comfy, gpu, pixal3d), `GET/PUT /api/config`, `PUT /api/keys/:provider`, `POST /api/runtime/start`, `POST /api/runtime/pixal3d/start`, `POST /api/shutdown` |
| Файлы | `POST /api/assets` (multipart `file`: PNG/JPG/WEBP/GLB/OBJ/STL ≤ 100 МБ), `GET /api/assets/:id`, `POST /api/exports`, `GET /api/exports/:id` |
| Генерация | `GET/POST /api/jobs`, `POST /api/jobs/:id/cancel, /validate, /reextract` |
| Ракурсы | `GET /api/views/status`, `POST /api/views {imageId}`, `GET /api/views/:id`, `GET …/image/:slot`, `PUT/DELETE /api/views/:id/:slot`, `POST …/generate {provider:"codex" или "mvadapter",slots?,overwrite?,seed?,size?,steps?,note?}`, `POST …/cancel` |
| Кузница `/api/forge` | `status, steps, presets, assets(+/:id, PATCH, DELETE, /:id/run, /:id/export, /:id/files/…), jobs(+/:id, /:id/cancel), clips(+/:id/poses), batch(+/:id), review, review/export` |
| Проекты | `GET/POST /api/projects`, `POST /api/projects/compressed`, `GET /api/projects/:id`, `POST /api/unwrap`, `POST /api/optimize`, `POST /api/reference/prepare`, `POST /api/chat` |
| VFX | `GET /api/vfx-tools`, `…/textures`, `POST /api/vfx-tools/:id/launch, /install, /folder` |
| Tripo | `POST /api/tripo/tasks/:id/<действие>` |

Ошибки — JSON `{error: "текст по-русски", code}`: `not_found, bad_id, bad_path, busy, validation, no_local_paths, fx_socket_missing, bad_glb, bad_json, bad_state, pixal3d_not_installed, no_part, no_concept`.
Через HTTP нельзя передать локальный путь в параметрах (`no_local_paths`): файлы загружаются; пути (`part_file`, `concept_file`, `parts_file`) — только `--direct`.

## 8. Раскладка `<APP>\data` (в git не входит)

`assets\` (изображения, GLB студии + `.json`), `jobs\`, `projects\` (gzip JSON), `exports\`, `views\<id>\` (наборы ракурсов: `raw\ norm\ work\ views.json`), `tripo\`, `python\` (xatlas),
`models\{checkpoints,background,mvadapter}`, `runtime\` (`input output temp user`, `custom_nodes\`, `models.yaml`, `studio.db`, `comfy.log`, `pixal3d.log`, `*.pid`, `pixal3d-temp\`),
`config.json` (подключения), `vault.json` (ключи API через Windows DPAPI — **секрет, не публиковать, не копировать на другой ПК**), `library.moved-2026-10-11\` (старая копия).

## 9. Проверки качества и тесты

- Каждый шаг пишет `checks` (например `tris_within_target`, `height_matches`, `deform_torn_area`, `foot_skate`, `cell_fit`, `body_scale_px_per_m`, `godot_scene_loads`, `godot_animation_loops`, `godot_engine_errors`).
  Неудача `severity:error` останавливает шаг: «Не прошли проверки качества: …».
- Проверка Godot — без окна (загрузка, имена, петли, сокеты, FX); картинку она не оценивает.
- `npm test` — `node --test tests/*.test.mjs` (23 файла в `tests/`); тесты Blender — `scripts/blender/tests/run_tests.py`.
- Внешние ворота, которых нет в студии (скрипты на этой машине): осанка `posture.py`, `vlm_check.py` — `games.md`.
