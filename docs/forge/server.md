# Кузница: сервер, очередь Blender, замок GPU, CLI (модуль «server», 10.10.2026)

Реализует `docs/forge/API.md` и §3, §8, §9 контракта. Все тексты для пользователя — по-русски.

| Файл | Что делает |
|---|---|
| `server/blender.mjs` | поиск Blender/Godot и их версии (кеш), запуск шага, разбор `AFLOG`/`AFRESULT`/`AFERROR`, журналы, таймауты, снятие дерева процессов, очередь FIFO со «слотами» |
| `server/gpu-lock.mjs` | межпроцессный замок видеокарты `Global\HG_GPU_RENDER` (общий с «Вратами Героев») |
| `server/forge-steps.mjs` | реестр 24 шагов (11.10: + `motion_style`, см. `docs/forge/motion_style.md`; 11.10, ночь: + `rig_humanoid.deform_gate`, `motion_style.robe_settle/deform_qa/deform_every/deform_gate/deform_limits`, `render_sprites.adaptive_cell`) и 8 пресетов (данные), проверка параметров |
| `server/forge-pipeline.mjs` | движок: паспорта, версии, разрешение входов, задачи, экспорт, клипы, замок библиотеки клипов, пакеты, раздача файлов |
| `server/forge.mjs` | маршруты `/api/forge/*` |
| `scripts/forge.mjs` | командная строка (через сервер или `--direct`) |
| `scripts/forge-concepts.mjs` | пакет «папка концептов → генерация → ассеты» (роли из `roles.json`, своя комбинация клипов, `motion_style` и вариант смерти на персонажа); `--state` (отдельное состояние, генерации читаются из состояния папки), `--no-gen`, `--direct` (кузница в процессе — пока студия держит старый реестр), `--qa clips|pose|off` (по умолчанию `clips`: проверка позами рига — предупреждение, решают разрывы на настоящих клипах в `motion_style`; `off` = `--no-rig-qa`), `--qa-render-failed`, `--clip-limits`, `--watch` (сборка вслед за генерацией до её конца, `--watch-poll`, `--watch-stall`), превью `previews/<имя>.png` и `_contact_sheet.png`, `roles.json` → `rig` (параметры рига персонажа) и `paint` (параметры покраски), `paint_from_concept` после `cleanup` у гуманоидов и существ (`--no-paint` — без неё), `--dry` |
| `scripts/forge-smoke.mjs` | дымовой прогон всех пресетов в настоящих Blender 5.0.1 и Godot 4.5.1 → `docs/forge/SMOKE.md` + `SMOKE.json` (вне `npm test`) |
| `tests/forge-*.test.mjs` | 56 быстрых тестов без Blender (реальный замок GPU — только Windows) |

Правки чужих файлов: `server/index.mjs` — одна строка импорта и один вызов
`registerForge(app,asyncRoute,{getGenerationJob:getJob})` сразу после `registerTripo`, то есть после защитного
middleware (loopback Host/Origin, `x-astra-client: studio`). `server/jobs.mjs` — замок GPU только вокруг
отправки промпта ComfyUI и ожидания результата (`waitPrompt`): три строки. В раунде исправлений эти два
файла не менялись.

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ASTRA_BLENDER` | `C:/Program Files/Blender Foundation/Blender 5.0/blender.exe` | путь к Blender |
| `ASTRA_BLENDER_CONCURRENCY` | 1 | одновременных процессов Blender |
| `ASTRA_FORGE_JOB_CONCURRENCY` | как у Blender | одновременных задач (задача = цепочка шагов) |
| `ASTRA_GODOT` | поиск `Godot_v*-stable_win64[_console].exe` в `C:/Program Files/Godot`, `C:/Godot`, `C:/Dorn/Game Dev`, `%LOCALAPPDATA%/Programs/Godot` | только для `/status` |
| `ASTRA_GPU_MUTEX` | `Global\HG_GPU_RENDER` | имя мьютекса (тесты используют свои `Local\AF_TEST_*`) |
| `ASTRA_FORGE_LIBRARY` | `data/library` | библиотека (паспорта, задачи, клипы, корзина) |
| `ASTRA_FORGE_RUNTIME` | `data/runtime` | журналы Blender и рабочие папки |
| `ASTRA_FORGE_URL`, `PORT` | `http://127.0.0.1:3210` | адрес сервера для CLI |

Путь библиотеки лучше держать коротким: Blender (Python) на Windows не открывает файлы с путём длиннее
260 символов, а внутри ассета добавляется ещё ~110 символов (`assets/<uuid>/v001/02_godot_package/…`).

## Раскладка данных

```
data/library/assets/<id>/asset.json              паспорт (запись через временный файл + rename)
data/library/assets/<id>/source/source.<glb|fbx|obj>  копия входа (задание генерации / ассет / загрузка)
data/library/assets/<id>/v001/version.json       рецепт версии, база, итоговое состояние (final)
data/library/assets/<id>/v001/asset.snapshot.json паспорт на момент запуска (вход godot_package)
data/library/assets/<id>/v001/01_cleanup/        out_dir шага 1: request.json, result.json, выходы
data/library/assets/<id>/exports/<профиль>-v003.zip  архивы godot_package / render_sprites
data/library/jobs/<jobId>.json                   записи задач (pid + heartbeatAt владельца)
data/library/batches/<batchId>.json              пакеты
data/library/animations/index.json               библиотека клипов (пишет шаг clip_library)
data/library/trash/assets|clips/                 удалённое (ничего не стирается насовсем)
data/runtime/blender/<jobId>/<step>.log          журнал шага (при повторе шага в задаче — <kk>_<step>.log)
data/runtime/forge/uploads/<uuid>/               временные загрузки (меши — до конца запроса, FBX клипов —
                                                 до конца задачи импорта; забытые после сбоя — удаляются через сутки)
data/runtime/forge/jobs/<jobId>/01_clip_library/ out_dir задач без ассета (импорт клипов)
```

## Запуск шага Blender (`server/blender.mjs`)

`runBlenderStep({step, request, jobId, timeoutSec, gpu, signal, onLog, onProgress, onStart})`:

1. CPU-шаг занимает место в очереди синхронно при вызове — порядок запуска = порядок вызовов (FIFO);
   отмена задачи, ещё стоящей в очереди, просто убирает её оттуда.
2. GPU-шаг сначала ждёт замок видеокарты **вне** очереди (CPU-шаги тем временем идут), а получив замок,
   встаёт в очередь впереди обычных шагов — видеокарта простаивает не дольше текущего шага. Замок
   освобождается в `finally` (и при ошибке, и при отмене).
3. В слоте: `out_dir/request.json`, затем
   `blender -b --factory-startup --python scripts/blender/af_run.py -- <step> <out_dir>/request.json`.
4. stdout/stderr читаются построчно (UTF-8, `\r\n`), всё пишется в журнал. `AFLOG {json}` → `onLog`;
   прогресс берётся из `progress` (0..1 или 0..100), `pct`, `done/total` или `frame/frames`.
   `AFRESULT` — итог (если строки нет, но `result.json` записан в этом запуске — берётся он).
   `AFERROR` — ошибка шага с трассой. Нет ни результата, ни `AFERROR` (скрипт `--python` упал раньше
   обработчика af_run, Blender при этом выходит с кодом 0) — в тексте ошибки последняя строка Python-
   исключения из stderr, например `… (код 0): FileNotFoundError: … request.json`.
5. Таймаут: из реестра (`timeoutSec`), иначе 15 мин, GPU-шаги 60 мин. Таймаут и отмена снимают
   всё дерево процессов: `taskkill /PID <pid> /T /F` (в тесте проверено, что погибает и внук).
6. Результат `ok:false` (проваленная проверка с `severity:error`) — не исключение: движок помечает
   шаг ошибкой с текстом проваленных проверок.

`StepQueue.run(fn, {signal, onStart, front})` передаёт `fn` объект места `slot`: `slot.release()` отдаёт
место другим, `await slot.reacquire(signal)` берёт его снова впереди очереди (`false` при отмене).

## Замок видеокарты (`server/gpu-lock.mjs`)

Node не умеет владеть мьютексом Win32, поэтому запускается скрытый `powershell.exe -EncodedCommand`
(политика выполнения не мешает), который создаёт `System.Threading.Mutex($false,'Global\HG_GPU_RENDER')`,
ждёт его кусками по 250 мс (печатает `WAITING`), печатает `LOCKED` и держит до строки в stdin или до
закрытия stdin (смерть нашего процесса). Освобождение — `ReleaseMutex` в `finally`.

- Совместимость: это тот же мьютекс, что у `tools/art/gpu_run.ps1` «Врат Героев», — рендеры HG и
  кузницы/ComfyUI идут строго по очереди.
- Падение держателя: если процесс-держатель убит, Windows помечает мьютекс брошенным; следующий
  ожидающий получает его (`ABANDONED` → `lock.abandoned=true`). Если ожидающих нет, объект мьютекса
  исчезает вместе с последним дескриптором и новый захват тоже проходит. Оба случая есть в тесте.
- `timeoutMs` и `AbortSignal`: при отмене ожидания держатель убивается (мьютекс он ещё не держал).
- `failOpen:true` (так вызывают Blender-шаги и ComfyUI): если PowerShell не запускается, работа
  идёт без замка с предупреждением в журнале — генерация не ломается из-за вспомогательного процесса.
- Кто берёт замок: `render_sprites` всегда; `cleanup` — только при `voxel_remesh_m > 0` и
  `bake_device = 'GPU'` (правило `gpuWhen` в реестре); генерация в `server/jobs.mjs` — на время
  каждого промпта ComfyUI (SDXL и Hunyuan по отдельности), ожидание видно в статусе задания.
- Очередь задач: на время GPU-шага (ожидание замка + рендер) задача отдаёт своё место в очереди задач,
  поэтому задачи с CPU-шагами и импорт клипов не стоят за рендером, который ждёт видеокарту до 60 минут.
  После GPU-шага задача снова берёт место — впереди ещё не начатых задач.
- `/status.gpuLock.held` — держит ли замок этот процесс (не весь компьютер).

## Реестр шагов (`server/forge-steps.mjs`)

Таблица `STEP_LIST`: `{step, module, title, help, kinds, inputs:{slots, required, formats, manifest}, outputs,
params, gpu | gpuWhen, timeoutSec, export, scope}`. Схема параметра: `{type, default, min, max, enum,
nullable, items, minItems, maxItems, alt, title, help, server, auto, path}`. `alt` — запасные схемы: значение,
не прошедшее основную, принимается, если подходит под одну из них (`head_dir` — метка `auto|−Y|+Y|−X|+X` или
вектор `[x, y]`; `item_scale` — число или `'auto'`; `speed` — число или `{клип: м/с}`); интерфейс рисует
основную схему. `inputs.manifest: true` — сервер кладёт в `inputs.manifest` снимок паспорта (`render_sprites`,
`godot_package`). Составные параметры, которые схема не описывает, проверяет таблица `STEP_CHECKS` до запуска
(клипы `retarget`/`attach_prop`, `attach_prop.attachments`, зоны `separate.regions`, `bone_kit`: `part` обязателен,
`origin` и `length_m` по детали, варианты `batch`; `replace_part`: `region`, `cut_plane`, UUID `part_asset`,
`part_transform`; `place_parts`: `points` обязательны и разбираются по точкам; `rig_humanoid`: `grip_dirs`, `socket_bones`,
`arm_bleed`; `retarget`: `facing`/`hips_drop`/`ground`/`hand_floor` общие и у клипа; `attach_prop`: `grip_dir`,
`refit_socket`; `separate`: виды зон и поверхности разреза `slit`). Правится как данные; код ниже таблиц трогать не нужно.

Шагов 21 (10.10, вечер, после готовности модулей — `docs/forge/bone_kit.md`, `docs/forge/replace_part.md`, финальный
`run(req)`):
- `bone_kit` (модуль items, генератор без входов, виды item/prop): `part` = `skeleton_hand | bone_staff | bone_toggle`
  и параметры всех трёх деталей (кисть: `side`, `pose`, `curl`, `finger_spread_deg`, `grip_radius_m`, `grip_tilt_deg`,
  `rings`, `ring_at`; посох: `grip_fraction`, `grip_off_fraction`, `segments`, `shaft_radius_m`, `crystal_*`, `talons`,
  `talon_length_m`, `bend`; застёжка: `gold`, `loop`, `bone_radius_m`; общие: `style`, `seed`, `length_m` и `origin`
  — умолчания свои у каждой детали, поэтому в реестре пусто, `palette`, `budget_tris`, `batch`, `sheet_*`, превью).
  Выходы: `glb`, `blend`, `json`, `preview`; у пакета вариантов — списки `glb`/`blend`, `contact_sheet`, `batch_json`.
- `replace_part` (модуль core, все виды): тело — из цепочки (`inputs.mesh`, иначе `inputs.blend`), **новый слот
  `inputs.part`** — деталь: `part_asset` (UUID другого ассета кузницы; сервер берёт его последний GLB, а без версий —
  загруженный исходник, так попадает и загрузка) или `part_file` (путь, только CLI `--direct`); оба — серверные,
  в Blender не уходят. Предпроверка запуска: без `region` или без детали — 400 (`no_part`), чужой ассет должен
  существовать. Остальное — параметры `run(req)`: `region`, `cut_plane`, `height_m`/`rotate_z_deg`/`ground`/`center`,
  `align` и ICP, `part_tris`, крошки, `seam_gap`, `hang_m`/`keep_hang`, `texture` (путь к кропу — только CLI),
  `eyes`, `name`, превью. Выходы: `glb`, `blend`, `part_glb`, `compare`, `compare_views`.

10.10, ночь (SQ-03 v2, `docs/forge/kitbash.md`, `docs/forge/ships.md`): **22 шага**.
- `kitbash` (модуль ships, виды ship/prop, слоты `blend, mesh` — после `ship_from_mesh` берёт его `ship.blend` с LOD и
  метаданными; `godot_package` после него получает GLB `kitbash`): `parts` — список деталей `{kind: gatling | nozzle |
  piping | antenna | mast | nav_light | vent_grille | block | remove, at, …}`, `drop_sockets`, `budget_class`, `lods`,
  превью, инспектор. `STEP_CHECKS.kitbash` до запуска проверяет вид детали, `at` (сокет/маска, точка `[x, y, z]` /
  `[x, y]` или список), `points` труб (≥ 2 точки), зоны `remove` (`cylinder | sphere | box` или
  `{radius, depth, inset, above, cap}`). Выходы: `glb`, `blend`, `preview`, `lod_strip`, `manifest`, `lod1`, `lod2`.
- `ship_from_mesh`: `materials` += `paint`; новые `palette` (input | faction), `livery`, `paint` (объект; `image` —
  путь, только CLI `--direct`; по HTTP — `paint.asset`: UUID картинки студии, сервер подставляет
  `data/assets/<id>.png|jpg|jpeg|webp` в `paint.image`, нет картинки — задача падает до запуска Blender),
  `armor_texture` (имя набора или объект), `decals` (список; `STEP_CHECKS` требует `text` и `position` + `size`),
  `turret_sockets` (flats | protrusions | auto), `lod_targets`, `thruster_cue`.
- `turret_gen`: `barrel_style` (plain | rotary) — умолчание совпадает с модулем (мастер выписывает его в рецепт).
- Генерация (`server/schema.mjs`, не шаг кузницы): поле `hazeFilter` (auto | on | off) — см. «Фильтр дымки выхлопа».

10.10, ночь (некромант v2, `docs/forge/necromancer.md` раздел v2): **23 шага**. Записи сверены с `run(req)` модулей
(`place_parts.py`, `replace_part.py`, `rig_humanoid.py` + `_humanoid_lib.skin`, `attach_prop.py`, `retarget.py`,
`separate.py` + `_mesh_lib.SlitSurface`), умолчания реестра равны умолчаниям модулей (тест сверяет таблицу).
- **`place_parts`** «Расстановка деталей» (модуль core, все виды): копии детали на поверхность цели или в явную позу.
  Слоты `mesh, blend, part`: цель — модель цепочки (GLB/FBX/OBJ предпочтительнее, иначе `.blend`), деталь по умолчанию
  — `inputs.part` из `part_asset` (UUID ассета, сервер берёт его последний GLB, без версий — загруженный исходник) или
  `part_file` (путь, только CLI `--direct`; важнее `part_asset`); оба серверные, в Blender не уходят. `points`
  (обязательно): `[x, z]` (вид спереди), `[x, y, z]` или `{at, asset | part, name, scale, roll_deg, snap: surface | none,
  rot_deg | matrix, standoff_m, sockets, rest_percentile, normal_patch, max_tilt_deg}`; `points[].asset` — UUID детали
  точки, сервер подставляет `points[i].part` = её последний GLB (в рецепте остаётся UUID); если деталь есть у каждой
  точки, `part_asset` не нужен. Остальное — параметры модуля с его умолчаниями: `target_objects`, `ray` (`+Y` | `-Y` |
  `+X` | `-X` | `+Z` | `-Z`, +Y), `contact` (footprint | center), `normal` (fit | hit | axis), `footprint_grid` ([5, 3]),
  `footprint_fill` (0,8), `rest_percentile` (100, 0–100), `normal_patch` (1), `max_tilt_deg` (45), `up` ([0, 0, 1]),
  `search_m` (пусто — по детали), `join` (true), `name`, `part_sockets` (true), нормализация `height_m`/`rotate_z_deg`/
  `ground`/`center` (**по умолчанию выкл.**: точки в рамке файла), превью 512. `STEP_CHECKS.place_parts`: точки
  непустые, каждая — точка 2D/3D или объект только с известными ключами; `snap none` — нужна 3D-точка; `scale` > 0;
  `matrix` — поворот (определитель > 0); `asset` — UUID и не вместе с `part`; `footprint_grid` ≥ 1; `up` не нулевой.
  Предпроверка запуска (как у `replace_part`): без детали — 400 `no_part`, ассеты `part_asset` и `points[].asset`
  должны существовать (404 с номером точки). Выходы: `glb`, `blend`, `preview`.
- `replace_part`: `align` += `none` (деталь в своей позе, без подгонки к удалённой области); `part_transform`
  `{location, rot_deg | matrix, scale}` (лишние ключи, например `loc`, отклоняются); `keep_materials` (false);
  `cut_part` (true).
- `rig_humanoid`: `grip_dirs` (`{"l"|"r": [x, y, z] | up | down | forward | back | out | in}`), `keep_input_sockets`
  (true), `socket_bones` (`{сокет: кость}`), `replace_sockets` ([]), `island_max_frac` (0,01), `surface_aware` (true),
  `surface_margin_h` (0,05), `arm_bleed` ([0,1, 0,35]; `null`/`false` — выкл., `null` отправляется явно).
- `attach_prop`: `refit_socket` (false), `grip_dir` (строка-направление или `[x, y, z]`, пусто — нет); оба — и у
  предмета в `attachments`.
- `retarget`: `facing` (keep | rest), `facing_bone` (пусто — Hips), `hips_drop` (1, 0–1), `hips_height_m`, `floor`
  (true), `hand_floor` (`{"l"|"r": dz}`), `ground` (feet | mesh), `ground_tolerance_m` (0), `ground_samples` (2000),
  `floor_tolerance_m` (0,02), `floor_samples` (16). У клипа модуль читает `facing`, `facing_bone`, `hips_drop`,
  `hand_floor`, `ground` (клип важнее общего); их проверяет `checkClipList`. Допуски и выборки — только общие.
- `separate`: `mode` += `slit` (зоны с видом по умолчанию slit), `caps` (true), `slit_gap_m` (пусто — 0,001 × высота).
  `STEP_CHECKS.separate`: `kind` part | delete | slit; имя обязательно у части (у delete/slit без имени модуль даёт
  `delete_<i>`/`slit_<i>`); `caps` — да/нет; `facing` не нулевой, `facing_min` −1…1; `plane` (`{axis, value}` |
  `{point, normal}`), `curve` (`{axis, along, points}` — разные оси, ≥ 2 пары, `along` без повторов), `width_m` и
  `gap_m` ≥ 0 — только у зоны slit (иначе ошибка по-русски, что зону надо пометить `kind: "slit"`).
- Интерфейс (`src/forge/forge-core.js`, `ENUM_LABELS`): русские подписи значений `ship_gen.wing_style` (нет, дельта,
  стреловидные, обратная стреловидность, прямые, X-образные, короткие, серповидные), `thruster_frame`, `uv`,
  `turret_gen.barrel_style` rotary, `item_kit.sheet_scale`, всех перечислений `bone_kit`, новых перечислений
  `place_parts`/`retarget`/`replace_part`/`separate`; оси (`+Y`…) и числа остаются как есть. Таблица подписей общая на все
  шаги, поэтому `forward` подписан под крылья, а `attach_prop.grip_dir` — строка, не перечисление.

11.10, ночь (покраска по концепту, `docs/forge/paint_from_concept.md`): **25 шагов**.
- **`paint_from_concept`** «Покраска по концепту» (модуль paint, все виды, CPU): Hunyuan3D 2.1 даёт только
  геометрию — шаг красит сетку по картинке, из которой она сделана. Слоты `blend, mesh, concept`: модель — `.blend`
  цепочки (все объекты и сокеты остаются), иначе GLB/FBX/OBJ; **новый слот `inputs.concept`** разрешает
  `resolveInputs` → `_conceptInputs`: `concept_file` (путь, только CLI `--direct`, `path:true`) > `concept_asset` (UUID
  картинки студии, `data/assets/<id>.png|jpg|jpeg|webp`) > опорная картинка генерации, из которой сделан ассет
  (`source.type: job`, а для копии ассета кузницы — задание её источника, до 4 звеньев): `job.preparedConcept.reference`
  (исходный RGB + альфа rembg, `data/assets/<reference.id>.png`). Вместе с ней уходит `inputs.concept_original =
  {image, crop, content_rect}` — исходная загрузка (`reference.originalId` / `job.imageId`) и кадрирование
  `reference.framing`: шаг берёт оттуда прямой RGB (в опорной PNG цвет умножен на альфу, слабая альфа теряет цвет знамени).
  Задание без опорной картинки — его исходник (фон шаг вырезает по краю). Нет ничего — 400 `no_concept` (у первого
  шага — на предпроверке, до Blender). `concept_asset` и `concept_file` — серверные, в Blender не идут.
  Параметры модуля: `size` (512 | 1024 | 2048 | 4096, 2048), `uv` (auto | keep | smart), `uv_pack` (aabb | concave | none),
  `uv_angle_deg`, `uv_margin`, `camera` ("fit" или `{yaw_deg, pitch_deg, px_per_m > 0, offset_px}` из `paint_camera.json`;
  `STEP_CHECKS.paint_from_concept`), `yaw_range_deg` (пусто — 60, у существ 180), `yaw_step_deg`, `pitch_range_deg` (15),
  `perspective` (true), `facing_min`/`facing_full` (0,1 / 0,4; проверка: full > min), `depth_tolerance`, `edge_fade_px`,
  `delight`, `fill_blur`, `fill_smooth`, `back_fill` (through | none), `head_guard` (пусто — да, кроме существ),
  `head_fraction`, `mirror` (auto | x | none), `mirror_tolerance`, `emission` (auto | none), `emission_strength`,
  `roughness`, `metallic`, `objects`, `material_name`, превью. Вид ассета шаг читает из `request.asset.kind`.
  Выходы: `glb`, `blend`, `basecolor`, `emission`, `compare`, `camera`.
- `scripts/forge-concepts.mjs`: у каждого гуманоида и существа `paint_from_concept` сразу после `cleanup`
  (концепт кузница находит сама); `--no-paint` — по-старому белые модели; `roles.json` → `paint: {...}` — параметры шага
  для файла.

Важно: **в Blender уходят только явно заданные параметры** (пресетом, пользователем, источником
ассета). `default` в реестре — подсказка интерфейсу и основа для решений «GPU/таймаут»; настоящие
умолчания остаются в модулях шагов. Так реестр не может «перебить» более умное умолчание шага
(например `cleanup.merge_distance = 1e-5 × высота`, `name = "Body"`). Неизвестные реестру параметры
пропускаются как есть с предупреждением в задаче. Явный `null` для параметра, у которого умолчание `null`
(«пусто — решает модуль»), тоже не отправляется: модуль, читающий `p.get(key, default)`, не получит `None`.

Сервер сам заполняет пустые: `auto:'asset_slug'` — `asset_id` у `godot_package`, `render_sprites`,
`ship_gen`, `turret_gen`, `ship_from_mesh` (snake_case ASCII: `profile.asset_id` паспорта, если задан, иначе
транслит имени + 8 символов UUID, например `proverka_maski_043d11f1`; GLB корабля и пакет Godot получают один
id); `auto:'animations'` — папка библиотеки клипов для `retarget.library` и `clip_library.library` (для
HTTP-клиентов — всегда серверная, даже если передана). `server:true` (`attach_prop.prop_asset`,
`replace_part`/`place_parts` `part_asset` и `part_file`, `paint_from_concept` `concept_asset` и `concept_file`) в Blender не идёт. `path:true` (`import_mixamo_rig.texture_source`,
`clip_library.folder/files`, `replace_part.part_file`, `place_parts.part_file`, `paint_from_concept.concept_file`) — локальный путь, его может задать только
CLI `--direct`.

`GET /steps` отдаёт `gpu: true | false | 'conditional'` (`'conditional'` — у `cleanup`, правило в `gpuWhen`).

**Сверка с модулями (10.10, интеграция).** Все 19 записей сверены с настоящим `run(req)` и разбором параметров
каждого модуля в `scripts/blender/steps/*.py` (не только с документами): имена, типы, умолчания, перечисления,
диапазоны, слоты входов, ключи выходов, таймауты. Главное:
- `cleanup`, `separate` — слоты `mesh, blend` (чистый GLB предпочтительнее .blend со служебными объектами;
  после шага, давшего только .blend или FBX, берётся он), `convert` — `blend, mesh`; у `cleanup` добавлены
  `planar_angle_deg`, `decimate_stage_ratio`, `seam_weight`, `bake_samples/normal/emission/extrusion_m/ray_m`,
  `smart_uv_angle_deg`, `preview(_size)`; у `convert` — `name`, `ground/center` (пусто — по росту/Mixamo),
  `mixamo_*`, `texture_max`; у `separate` — нормализация до разделения, `regions: [{name, min:[x,y,z],
  max:[x,y,z]}]` в метрах после нормализации (не доли высоты; проверяется до запуска), `names`, `drop_small`,
  `rest_name`, `origin`, `explode`.
- `rig_humanoid` — `height_ref`, `front`, `rigid` (правила-объекты), `robe_feet`, `prune_limbs`,
  `smooth_iterations`, `objects`, `deform_test`, `intersections`, `min_confidence`, `fix_yaw`, `max_yaw_deg`;
  ключи выходов `markers_json/markers_png/poses_png`. `prepare_mixamo.lite` по умолчанию **false** (как в модуле),
  `tris/tex/weld/center/prerigged/rig_params/force_prerigged`. `import_mixamo_rig` — `retex`, `keep_animation`,
  `clip`, `loop`, `sockets`, `max_influences`.
- `retarget` — справка `root_motion` (lock: на месте только walk/run, остальные клипы сохраняют ход бёдер,
  чтобы ступни стояли; keep — как в клипе; extract — горизонтальный ход на некостную кость `root`),
  `clips[].in_place` = `true | false | 'strict'`, `clips[].locomotion`, `foot_pin`, `loop_blend`,
  `apply_transforms`, `keep_existing_actions`, `preview_cols/tile`; клипы проверяются до запуска.
- `clip_library` — действие `list`, `pattern`, `files` — пути или `{path, name, category, tags, source}`.
- `rig_creature` — `head_dir`/`facing` = `auto|−Y|+Y|−X|+X` или `[x, y]`, `weights` (auto|heat|distance),
  `tail` (auto|да|нет|число костей), `jaw`, `leg_ratios`, `voxel_res`, `symmetrize`, `snap_facing`, сегменты змеи;
  шаблоны с `octopod`. `anim_creature` — только `.blend` рига; `speed` — **м/с** для walk-loop или `{клип: м/с}`,
  по умолчанию пусто (решает шаг); множитель темпа — `tempo` (модуль его понимает, 1); `clips` по умолчанию пусто
  (все, что подходят шаблону); `stride_m/cycle_frames` числом или `{клип: …}`, походки, `attack`, `death_side`,
  `hover_m`, `pose_view`, `tile`.
- `item_kit` — размер превью `preview_size` (пусто — 384, в пакете 320), `size` — размер предмета (арбалет,
  бластеры), `forward` (`-Y` рамка предмета | `+Y` Space Quest), `budget_tris`, `sheet_cols/tile/scale/title`;
  в пакете `glb`/`blend` — списки (движок берёт первый). `item_from_mesh` — `kind`, `type`, `length_m`, `crop`,
  `tip_end`, `edge` (auto или `[x,y,z]`), `allow_over_budget`, `budget_tris`, `min_island`, `texture_max`.
- `attach_prop` — `attachments`, `fit`, `standoff` (м или auto), `thumb_hint`, `item_scale` (число или auto),
  `replace`, `refit_shield_mount`, `socket_along`, `frames_per_clip`, `preview_clip`; персонаж может быть FBX;
  `clips` — серверный параметр (см. «Разрешение входов»).
- `ship_gen` — `layout`, `thruster_frame` (thrust | exhaust | sq_legacy, по умолчанию thrust), `engine_count` 1–6,
  `wing_style` перечислением (auto), `palette_variant`, `tier`, `lods`, `preview_turrets`, `uv`, `sq_inspector`;
  `style` = фракция (модуль читает `faction`, `style` — его синоним; отдельного `faction` в реестре нет, иначе
  мастер, который выписывает умолчания генераторов, перебивал бы выбор). `turret_gen` — `ring_m`, `clips`, `lods`.
  `ship_from_mesh` — только `inputs.mesh`; `up`, `materials`, `emissive`, `target_tris`, `thruster_frame`,
  `source/generator/faction`, `uv`, превью; выход `lod_strip`.
- `render_sprites` — `forward`, `height_m`, `in_place`, `directions`, `cell/anchor`, `shadow`, `grade`,
  `max_cell_px/min_body_px/max_sheet_px`, `event_frames`, `validate_godot` …; `pixels_per_meter`, `elevation_deg`,
  `fps` по умолчанию пусто (решает профиль: iso8 30°, heroes_gates 25°). `godot_package` — `source_forward`,
  `fx_auto_scale`, `autoplay`, `sq_type`, `sq_class`, `fit_units/min_units/comment` (единицы рендера Space Quest,
  `min_units` от 0; умолчания по роли — `export.md`), `validate`, `fx_preview*`.
- Умолчания генераторов (`item_kit`, `ship_gen`, `turret_gen`) совпадают с модулями: мастер выписывает их в
  рецепт явно (`generatorParams` в `src/forge/forge-core.js`), тест это сверяет.

Пресеты (`GET /presets`): `humanoid_from_mesh` (retarget `root_motion: 'extract'` — шаг на месте, ход стоячих
клипов Mixamo, атак и смертей, которые кончаются в ~1 м, уходит на кость `root` для root motion Godot),
`humanoid_hg_sprites` (`root_motion: 'lock'`, плюс спрайты heroes_gates; **`render_sprites` идёт до `godot_package`**,
чтобы пакет взял `inputs.sprites` и положил листы в `sprites/`), `creature_auto` (скорость и темп не задаёт; размер —
из паспорта, см. ниже), `item_kit_sword`, `item_from_mesh`, `ship_procedural` и `ship_from_mesh` (шлейф `engine_trail` на маске
`socket_thruster_*`), `turret`. Все параметры пресетов есть в реестре (тест). Профили экспорта:
`godot`/`space_quest` → `godot_package`, `heroes_gates`/`iso8` → `render_sprites`.

## Конвейер (`server/forge-pipeline.mjs`)

**Источник ассета** (`POST /assets`): `job` — копия GLB завершённого задания генерации
(`data/assets/<asset.id>.glb`; задание ищется в памяти сервера, затем в `data/jobs/<id>.json`);
`asset` — последний GLB другого паспорта кузницы или модель студии (`data/assets/<id>` .glb/.obj/.stl/.fbx);
`upload` — GLB/FBX/OBJ по сигнатуре (`glTF`, `Kaydara FBX Binary` или `; FBX`, текстовый OBJ), до 300 МБ;
`params` — без файла, `source.params` подмешиваются в первый шаг-генератор (`item_kit`, `ship_gen`,
`turret_gen`, `bone_kit`): поверх параметров пресета, но под явными `steps`.

**Размер существа из паспорта** (`applyProfileSize`, при запуске): если в шаге `rig_creature` не заданы ни `height_m`,
ни `length_m`, сервер берёт `profile.height_m` (его хранит шаг «Подготовка» мастера), иначе `profile.length_m`; у
ассета-существа `cleanup` без `height_m` получает `profile.height_m`. Значения попадают в рецепт как явные параметры,
явные параметры шага важнее паспорта. Если размера нет нигде, остаётся родной масштаб файла, а после `rig_creature`
сервер сверяет габарит с шаблоном (`creatureSizeWarning`, `CREATURE_SIZE_RANGES`: высота quadruped 0,3–6 м,
winged_quadruped 0,3–12, bird 0,08–5, hexapod/octopod 0,05–6; длина serpent 0,3–40; custom — без проверки) и при
неправдоподобном размере пишет предупреждение в шаг и в задачу. Раньше `creature_auto` оставлял warhorse в 0,87 м.

**Версии.** Каждый запуск — новая папка `v00N` (создаётся атомарно `mkdir`), шаг `k` пишет в
`v00N/<kk>_<step>/`. `from` в `POST /run`: `source` (**по умолчанию**) — от источника; `latest` — от итогового
состояния последней *завершённой* версии (если её нет — от источника, с предупреждением); `v003` — от этой
версии (должна быть завершена). Экспорт всегда `from: latest`.

**Разрешение входов.** Состояние цепочки `{blend, glb, mesh, exports}`. Шаг со слотами `blend|mesh` получает
`inputs.blend`, если `.blend` есть, иначе `inputs.mesh` = текущий GLB (или исходный FBX/OBJ, если формат
подходит шагу). Шаг, выдавший `glb`/`blend`, заменяет модель целиком (старый `.blend` не переживёт новый
GLB). **Шаги экспорта (`godot_package`, `render_sprites`) модель не меняют**: их выходы (в том числе GLB пакета)
записываются в `state.exports[<шаг>]`, поэтому `render_sprites` после `godot_package` получает `.blend` рига или
анимации, а `version.final` версии с экспортом сохраняет прежние `.blend/.glb` — и следующие запуски
`from: latest`, `attach_prop`, копии ассета берут модель, а не упакованный GLB. Шаги без выходов
(`inspect`) состояние не меняют.
Особые: `godot_package` — `inputs.glb` + `inputs.manifest` (снимок паспорта) + `inputs.sprites`, если для этой
же модели раньше отработал `render_sprites` (его `sprites_json`; новый модельный шаг экспорты сбрасывает);
`render_sprites` — текущий `.blend`/модель + `inputs.manifest` (вид ассета задаёт ось: корабли, реквизит,
турели +Y); `anim_creature` — только `.blend` рига существа; в слот `mesh` подходит и FBX цепочки (выход
`convert`). `attach_prop` — `inputs.character` = текущий GLB, иначе .blend, иначе FBX (загруженный риг или
выход `convert`); `inputs.item` = последний GLB ассета из `props[0]` (или `params.prop_asset`), если не заданы
`params.attachments`. В `attachments` по HTTP предмет задаётся `asset` (UUID ассета-предмета): сервер подставляет
`item` = его последний GLB (в рецепте остаётся UUID); `item`-путь — только CLI `--direct`. `params.clips` —
серверный параметр: `library:<id>`, `category:<категория>[:<тег>]` или `{source, name, loop}` разрешаются по
библиотеке, как у `retarget`, и уходят шагу в `inputs.clips` как `{file, name, loop}`. `replace_part` и `place_parts` —
модель цепочки (`inputs.mesh`, иначе `inputs.blend`) + `inputs.part` из `part_file` (CLI) или `part_asset`; у
`place_parts` `points[].asset` разрешаются в `points[i].part` (последний GLB ассета), и без детали по умолчанию шаг
идёт, если деталь есть у каждой точки. Генераторы — без входов.
Проверка «есть ли вход у первого шага», наличие клипов для `retarget`/`attach_prop` и предметов для `attach_prop`
делается до запуска (ответ 400/404 сразу).

**Ошибки шагов.** `AFERROR` шага попадает в задачу без изменений: `result.error` = «Шаг «…» завершился ошибкой:
<текст шага>», `result.af_error` = сам текст шага, `result.trace` — трасса. Например, `render_sprites` при неверных
единицах падает до рендера с `ValueError: projected model is only … px (… fix the units with params.height_m …)`;
интерфейс показывает русскую рамку с этим текстом как есть (`humanizeError` не переписывает текст с кириллицей).

**Маски сокетов в fx.** `godot_package.fx[].socket` может быть маской (`*` — любая последовательность, `?` —
один символ): перед шагом сервер читает JSON-блок входного GLB (без Blender), берёт сокеты по тому же правилу,
что и шаг (`extras.game_socket` или имя `socket_*`), и заменяет запись маски записями по каждому совпадению
(по алфавиту). Если `params.fx` не задан, а в `fx` паспорта есть маски — разворачиваются и они. Маска без
совпадений — ошибка шага по-русски (`fx_socket_missing`) со списком сокетов модели. В рецепте паспорта
остаётся маска, в `request.json` — развёрнутый список.

**Клипы `retarget`.** `library:<id>` или `category:<категория>[:<тег>]` разрешаются по
`data/library/animations/index.json` перед шагом: из подходящих берётся первый по `id` (детерминированно);
нет категории — ошибка по-русски с подсказкой про импорт. В шаг уходит `source:'library:<id>'`, `file`
(абсолютный путь), `name` (по умолчанию категория), `loop` (по категории idle/walk/run). В рецепте
паспорта остаётся запрошенный `category:…`, а фактический выбор пишется в `resolvedClips`.

**Локальные пути.** HTTP-клиенты передают байты, а не пути: `POST /run`, `/export`, `/batch` отклоняют (400,
`no_local_paths`) параметры с `path:true` и `library`, источники клипов кроме `library:`, `category:` и голого
id клипа, клипы с ключами `file`/`path`, предметы `attachments` с `item`/`path`, `place_parts.part` и точки
`place_parts.points[]` с ключом `part` (даже относительный путь: деталь точки по HTTP — только `asset`), а также любые
строки, похожие на путь (`C:\…`, `\\server\…`, `/…`, `file:`, `..`). Последний рубеж — `_prepareParams` всегда ставит серверную библиотеку. CLI `--direct`
(`allowLocalPaths`) может всё это.

**Паспорт.** `pipeline[]` = рецепт последней *завершённой* версии (все записи `done`), а за ним — шаги
запусков, которые ещё в очереди/идут (`pending`), и последнего неудачного запуска после неё (`failed`).
Повтор записей `done` по порядку пересобирает последнюю завершённую версию; неудачный запуск больше не
затирает рецепт и миниатюру, а записи идущего запуска не пропадают, когда стартует следующий.
Статусы контракта `pending|done|failed` (отмена и пропуск = `failed` с `result.cancelled/skipped`), `result` —
весь `result.json`, `urls` — ссылки на выходы. Дополнительно (вне §8): `versions[]` (версия, база, статус,
итог), `qa.checks` (проверки шагов последних запусков; `qa.reviewed` меняется только явным PATCH),
`exports[]` (`{profile, step, version, path, url, bytes, at}`).

**Задачи.** `data/library/jobs/<id>.json`: статусы `queued|running|completed|failed|cancelled`, шаги
`queued|running|completed|failed|cancelled|skipped` с `progress`, `message`, `logTail`, `logFile`,
`request`. Запись прогресса не чаще раза в секунду, переходы — сразу; запись новой задачи — сразу и **до**
`version.json` и паспорта (версия, упоминающая задачу, всегда имеет её запись). Паспорт и `version.json`
дописываются до того, как задача станет `completed`.
- Сбой записи файла задачи (антивирус, индексатор, OneDrive держат файл; папка только для чтения) не роняет
  студию: состояние остаётся в памяти, ошибка пишется в журнал сервера, запись повторяется с паузой
  (0,5 с … 30 с) и при следующем изменении. Никакой путь кода задачи не оставляет необработанный rejection.
- Владелец задачи раз в 20 с переписывает `heartbeatAt`. Чужая незавершённая задача считается живой
  (`external`: отменить можно только там, где она запущена) только если её `pid` жив **и** пульс свежее
  2 минут; иначе она помечается `failed` («прервана: процесс… завершился (перезапуском сервера или закрытием
  окна)») вместе с шагами паспорта и версией — при старте, при `GET /jobs`, `GET /jobs/:id`, удалении ассета.
  Запись с нашим же `pid`, но не созданная этим процессом, — от прежнего процесса с тем же `pid`.
  Так переиспользованный Windows `pid` (окно Start.cmd закрыли без SIGINT) не оставляет вечных «external».
- Версия `queued/running` без записи задачи старше 2 минут при старте помечается `failed`
  («Запись задачи этой версии не сохранилась»).

**Экспорт.** После успешного `godot_package`/`render_sprites` папка `outputs.package` (или весь
`out_dir` без `request.json` и `_views`, или готовый `outputs.zip`) упаковывается в
`assets/<id>/exports/<профиль>-<версия>.zip`.

## Маршруты (сверх API.md)

- `POST /assets` принимает и multipart: `file` + поля `kind`, `name`, `source` (JSON), `profile` (JSON).
- `POST /assets/:id/run` понимает `{preset}` вместо `{steps}`; `from` по умолчанию `source`; ответ `{jobId, version, warnings}`.
- `POST /batch` принимает и multipart: `items` (JSON) + `files[]`; элемент с `source:{type:'upload', fileIndex}`.
  Локальные пути (`source.path`) работают только в CLI `--direct`: сервер не читает файлы по путям из запроса.
- `POST /clips`: поле `files[]` (или `files`), до 500 файлов (столько же принимает движок); не-FBX пропускаются и
  перечисляются в `rejected`. Файлы лежат в `data/runtime/forge/uploads/<uuid>/` (с исходными именами — из них
  строится id клипа), шаг `clip_library` копирует их в `animations/mixamo/`, папка удаляется по окончании задачи.
  Пока идёт импорт (в этом или другом процессе), второй импорт и `DELETE /clips/:id` получают 409 `busy`.
- **Замок библиотеки клипов.** Кроме этой проверки при постановке, сам шаг `clip_library` выполняется под замком
  библиотеки: одна задача библиотеки за раз. В процессе — мьютекс, между процессами (студия и CLI `--direct` делят
  `data/library/animations`) — файл `animations/.library.lock`, создаваемый с `wx` (`{pid, host, token, owner}`);
  держатель раз в 20 с обновляет его время. Файл умершего процесса или не обновлявшийся 2 минуты (переиспользованный
  pid) перехватывается сразу. Задача, ждущая замок, пишет «Ожидает библиотеку клипов…» и снимается отменой без
  следов. `DELETE /clips/:id` берёт тот же замок без ожидания (занят — 409). Так два импорта (или импорт и
  удаление) больше не перезаписывают `index.json` друг другу, даже если обе задачи успели встать в очередь.
- `GET /jobs/:jobId/steps/:index/log` — журнал шага (`?download=1`).
- `GET /assets/:id/files/<v00N|source|exports>/…` — белый список расширений (glb, gltf, fbx, blend, png,
  json, tres, tscn, gd, md, zip, txt, log), запрет `..`/обратных слэшей, проверка `realpath` внутри папки
  ассета; `zip, blend, fbx, tres, tscn, gd, log, txt, md` отдаются с `Content-Disposition: attachment`,
  остальные — по `?download=1`.
- Ошибки: `{error, code}`; коды `bad_id, not_found, bad_params, no_input, clips_missing, bad_signature,
  busy, validation, no_local_paths, fx_socket_missing, bad_glb, bad_json, …`. Битый JSON в теле запроса к
  `/api/forge/*` (его отвергает общий `express.json` до маршрутизатора кузницы) ловит обработчик ошибок,
  который `registerForge` ставит на `/api/forge`: 400 `bad_json` по-русски (слишком большое тело — 413
  `too_large`). Глобальный обработчик `index.mjs` для остальных маршрутов не тронут.

## Командная строка

```
node scripts/forge.mjs status | steps | presets | assets | show <id> | jobs | job <jobId> [--wait] | cancel <jobId>
node scripts/forge.mjs create --kind humanoid --name "Некромант" --from-glb model.glb --preset humanoid_from_mesh
node scripts/forge.mjs create --kind item --params "{\"type\":\"axe\",\"seed\":7}" --preset item_kit_sword
node scripts/forge.mjs run <id> --steps steps.json [--from latest]
node scripts/forge.mjs export <id> --profile space_quest --out D:/Godot/SpaceQuest/incoming   (zip + распаковка)
node scripts/forge.mjs batch items.json        (пути source.path — относительно файла пакета)
node scripts/forge.mjs clips | clips import <папка FBX> | clips remove <clipId>
```

Общие ключи: `--direct` (без сервера), `--json`, `--server URL`, `--no-wait`. Без `--direct` CLI ходит на
сервер с заголовком `x-astra-client: studio`; прогресс опрашивается раз в секунду. `--no-wait` вместе с
`--direct` игнорируется с предупреждением в stderr: без сервера задача живёт только в этом процессе, и ранний
выход её бы убил. Ctrl+C в `--direct` отменяет задачу (Blender снимается), в режиме сервера — только
прекращает слежение. Коды выхода: 0 — успех, 1 — ошибка задачи/сервера, 2 — неверные аргументы.

## Проверка

- `node --test tests/*.test.mjs`: **144/144** (11.10, ночь, покраска по концепту: +1 реестр `paint_from_concept`, +1 конвейер — концепт из опорной картинки генерации с исходником и кадрированием, `concept_asset`, `concept_file` только CLI, предпроверка `no_concept`; `forge-routes` ждёт 25 шагов). Раньше 142/142 (11.10, ночь: +1 реестр — `deform_gate`, `robe_settle`, `deform_qa`, `adaptive_cell` с умолчаниями модулей и проверками; 11.10: 141 с `motion_style`). Раньше 140/140 (10.10, ночь, некромант v2: +6 реестр — `place_parts`, `replace_part`,
  `rig_humanoid`, `attach_prop`, `retarget`, `separate` с умолчаниями модулей и проверками; +1 конвейер — `place_parts`:
  цель из цепочки, `inputs.part` из `part_asset`, `points[].asset` → GLB, предпроверки, пути только через CLI; +1 интерфейс —
  русские подписи перечислений; `forge-routes` ждёт 23 шага). Раньше 132/132 (10.10, ночь: +1 реестр kitbash / paint / decals / rotary, +1 конвейер kitbash после
  `ship_from_mesh` и `paint.asset`, +6 схема генерации `hazeFilter` в `tests/forge-schema.test.mjs`); раньше 124/124 (сервер кузницы — 61: `forge-steps` 14, `forge-blender` 10,
  `forge-gpu-lock` 4, `forge-pipeline` 27, `forge-routes` 6; интерфейс `forge-ui-core` 29; остальное — студия);
  10.10, вечер, +5: размер существа из паспорта и предупреждение о неправдоподобном размере (реестр и конвейер),
  `bone_kit`/`replace_part` в реестре и `inputs.part` из ассета или файла (CLI), `bone_kit` как генератор;
  тесты убирают за собой временные папки. Раунд интеграции добавил 10: сверка реестра с модулями (core, retarget,
  существа, предметы, корабли/экспорт, пресеты), `attach_prop` с FBX/несколькими предметами/клипами, спрайты в
  пакете Godot, текст `AFERROR` через настоящий раннер Blender (поддельный Blender), замок библиотеки клипов.
- Дымовой прогон всех пресетов в настоящих Blender 5.0.1 и Godot 4.5.1: `node scripts/forge-smoke.mjs`
  (`--root C:/afs` — короткая рабочая папка из-за MAX_PATH, `--only id,id` — часть случаев). Результат —
  `docs/forge/SMOKE.md` (таблица: пресет, вход, статус, секунды, ключевые проверки, ошибки с текстом шага) и
  `docs/forge/SMOKE.json`.
- Сборка `npm run build` — зелёная (только прежнее предупреждение о большом чанке).
- Реальные прогоны (Blender 5.0.1, Godot 4.5.1):
  - `place_parts` через CLI `--direct` (10.10, ночь; короткая библиотека `ASTRA_FORGE_LIBRARY=C:/afr/lib`,
    `ASTRA_FORGE_RUNTIME=C:/afr/rt`, запросы — `C:/afr/req/`): ассет `bone_kit` (`part: bone_toggle`, `gold: rings`, `aged`,
    seed 2) `342787c8-3869-4db6-a134-82de4a143bc6`, затем ассет из `work/skull_roi/runs/seed1234/replaced.glb` с шагом
    `place_parts` (`part_asset` = застёжка, две точки `[x, z]` на застёжке робы, `normal_patch` 2, `rest_percentile` 70):
    `9b720ba2-2861-48f6-9dc2-8e9e032ffe1e/v001`, 2,25 с в Blender. `inputs.part` = `part.glb` версии застёжки,
    `part_asset` в Blender не ушёл, в рецепте остался UUID. Проверки: `points_hit` 2/2, `penetration` 0 у обеих,
    `part_frame` и `no_nan_verts` зелёные; 134 540 треуг., сокеты `socket_fx_eye_l/r` цели сохранены.
  - `inspect` на `Corrected-necromancer.glb` через CLI `--direct`: ассет `440b80b2-b702-4fb7-9b94-17413416b68d`,
    `v001`/`v002` прошлого раунда и `v003` этого (задача `4d86ff02-3390-41ac-9106-9b280a23d31b`, 3,2 с):
    119 997 треугольников, превью `data/library/assets/440b80b2-b702-4fb7-9b94-17413416b68d/v003/01_inspect/preview.png`,
    журнал `data/runtime/blender/4d86ff02-3390-41ac-9106-9b280a23d31b/inspect.log`; `pipeline[]` = рецепт `v003`.
  - `create --kind ship --preset ship_procedural --direct` во временной библиотеке: маска развернулась в
    `socket_thruster_main_port` и `socket_thruster_main_starboard`, все проверки `godot_package` зелёные
    (`fx_sockets_exist`, `godot_validation`, `godot_fx_attached`, …), архив `space_quest-v001.zip`;
    `ship_gen` и пакет получили один `asset_id`; `version.final.glb` — `ship.glb` шага `ship_gen`.
    Затем `export --profile godot`: `v002` взял `ship.glb`/`ship.blend` из `v001`, не GLB пакета.
  - Настоящий `node server/index.mjs` (порт 3341, ComfyUI не запускался, временная библиотека): битый JSON на
    `/api/forge/assets` → 400 `bad_json` по-русски; `texture_source: C:/Windows/win.ini` → 400 `no_local_paths`;
    остановлен своим `/api/shutdown`. Временная библиотека удалена.

## Ограничения и что сверить интегратору

- Дымовой прогон 10.10, вечер (`docs/forge/SMOKE.md`): исправлены все сбои первого прогона — LOD2 `ship_from_mesh`
  (воксельный прокси дальнего LOD), посох некроманта после чистки (`_humanoid_lib._chain_axis`), «Animation not found»
  турели (переименование клипа в пакете), размер существа, порядок `render_sprites` → `godot_package`, `in_place`
  мастера, регистрация `bone_kit`/`replace_part`. Ниже — запись первого прогона (утро 10.10) для истории.
- Дымовой прогон 10.10, утро: все пресеты, кроме перечисленных ниже, проходят в настоящих
  Blender 5.0.1 и Godot 4.5.1, включая `turret` (узлы `pivot_*` больше не сокеты — правка модулей ships/export).
  - `ship_from_mesh` на Meshy SQ-03 с классом пресета `fighter` (бюджет ship_s) падает на проверке шага
    `tris_lod2` = 2699 при пределе 1500: цель LOD2 (≈ 1425) коллапс-децимацией не достигается. Подозрение:
    цикл LOD в `scripts/blender/steps/ship_from_mesh.py` (нет повтора/доводки до бюджета) и
    `_ship_lib.decimate_to`. Та же цепочка с `class: gunship` (как в `docs/forge/ships.md`) проходит целиком,
    включая пакет Space Quest с двумя шлейфами.
  - Некромант через пресеты гуманоида падает раньше ожидаемого «разрыва»: после `cleanup` (40 000 треуг.,
    1,8 м) `rig_humanoid` не находит посох в руке, руки асимметричны на 0,231 H → риг не строится
    (`arm_symmetry`, `landmark_confidence` 0,25). Тот же `rig_humanoid` на исходной сетке (120 тыс.) находит
    посох и честно падает на `deform_torn_area` 11,6 % / руки вверх 15,6 % (как в `docs/forge/humanoid.md`).
    То есть упрощение до 40 000 ломает распознавание предмета в `_humanoid_lib`; решать — модулю humanoid
    (устойчивость к упрощённой сетке) или интегратору (бюджет чистки в пресетах гуманоида).
- Пресет `humanoid_hg_sprites` и профиль экспорта `heroes_gates` рендерят спрайты с `in_place: 'drift'`: с новым
  `root_motion: 'lock'` смерть зомби уходит на 1,19 м и в фиксированную ячейку «Врат» 320 px не влезает
  (`cell_fit`, `frames_body_inside_cell` — ошибки шага). С `drift` прямой снос корня снимается у всех клипов,
  ступни в смерти слегка едут (так было и в HG со `lock_root_xy`).
- (исправлено 10.10 вечером) `src/forge/forge-core.js` → `retargetClips` ставил `in_place: true` каждому клипу; теперь —
  только клипам передвижения (walk/run, тег или флаг `locomotion`), у стоячих ключа нет (решает `root_motion`), явный
  выбор пользователя сохраняется (`docs/forge/ui.md`).
- (исправлено 10.10 вечером) `bone_kit` и `replace_part` в реестре, у `replace_part` слот `inputs.part` (см. «Реестр шагов»).
- (исправлено 10.10 ночью) `place_parts` в реестре, `replace_part.align: none` и новые параметры шагов v2 некроманта
  больше не идут «неизвестными» (см. «Реестр шагов», 23 шага). `docs/forge/necromancer.md` (раздел v2, «Что осталось»)
  ещё пишет, что шаг не внесён, — документ не мой, стоит поправить владельцу.
- `retarget` получает в каждом клипе лишние ключи (`requested`, `clip_id`, `file`, `category`, `skeleton`) —
  модуль их игнорирует, но это стоит держать в уме.
- Журнал шага: по заданию `data/runtime/blender/<jobId>/<step>.log`; в контракте §9 —
  `data/runtime/blender/<jobId>.log`. Нужна одна формулировка.
- В `docs/forge/API.md` (не мой файл) стоит дописать: `from` по умолчанию `source`; `gpu: 'conditional'` в `/steps`.
- `/status.gpuLock.held` показывает только этот процесс; занят ли мьютекс кем-то ещё (HG), не
  проверяется (это стоило бы ~0,3 с PowerShell на каждый опрос).
- Вне Windows замок видеокарты — пустышка с предупреждением.
- Генерация ComfyUI ждёт замок до 60 минут (например, пока идёт длинный рендер HG), затем задание
  падает с понятной ошибкой; каждый промпт добавляет ~0,2 с на запуск PowerShell-держателя.
  Чат с LLM (Ollama) замок не берёт — это вне задачи модуля.
- Задачи выполняются по одной (как и Blender), кроме GPU-шагов, которые отдают место в очереди задач на
  время ожидания видеокарты и рендера; пакет из 20 элементов идёт последовательно.
- После сна/гибернации дольше 2 минут другой процесс (например, CLI) может пометить ещё живую задачу
  сервера прерванной; сервер при следующей записи перепишет её состояние и итог версии сам.
- Прогресс внутри шага есть только там, где шаг печатает `AFLOG` с прогрессом.
- Живой захват GPU-замка одновременно с реальным рендером HG и генерацией ComfyUI не проверялся —
  проверены сериализация, брошенный мьютекс, таймаут и отмена на тестовых именах мьютекса.
- В `%TEMP%` лежат ~800 папок `af-*` от прошлых прогонов тестов (до этого раунда тесты их не удаляли);
  удалить можно вручную, когда никто не гоняет тесты.

## Фильтр дымки выхлопа (prepare_concept)

Проблема (SQ-03, `ShipSQ03Forge/README.md`, «Найдено в кузнице» п. 4): rembg u2net оставляет в альфе концепта
полупрозрачную дымку выхлопа, и Hunyuan3D достраивает её как длинные раскрытые «лепестки» сопел. Фильтр в
`scripts/prepare_concept.py` (`filter_haze`) убирает такую дымку из альфы после удаления фона (или из альфы уже
готового PNG) и до обрезки по габариту. Только альфа: непрозрачное ядро (alpha ≥ 200) не меняется.

Как он решает (все размеры относительные, разрешение не важно):

1. Ядро — крупные 8-связные области с alpha ≥ 200 (мелочь < 2 % от самой большой отбрасывается); мягкое — alpha > 5 вне ядра.
2. Мягкое открывается кругом радиусом 0,6 % от √площади ядра: тонкая антиалиасная кайма корпуса исчезает, широкие пятна остаются.
3. Пятно — дымка, если одновременно: площадь ≥ 0,3 % ядра; мягкая область касается ядра; центр пятна во внешних 20 %
   ядра вдоль главной оси (или за ядром); ≥ 50 % пятна вне выпуклой оболочки ядра; ≥ 60 % (по весу alpha) пикселей
   цвета дымки (тёмный/дымный, серый, тёплый оранжево-красный, яркое холодное свечение).
4. Дымка и её тонкие хвосты обнуляются; 2-пиксельная каёмка вокруг ядра не трогается.

Режимы (`<фон>[:haze=<auto|on|off>]`, по умолчанию `auto`):

| haze | Поведение |
|---|---|
| `auto` | фильтр только если ядро ≥ 1,25 раза шире, чем выше (корабли, техника); портретные и квадратные силуэты (персонажи) не трогаются; при фоне `keep` не работает |
| `on` | фильтр всегда (в том числе для вертикального корабля) |
| `off` | фильтра нет, поведение как раньше |

Как передать: поле `hazeFilter` (`auto` | `on` | `off`, по умолчанию `auto`) в теле `POST /api/jobs`. `generationSchema`
(`server/schema.mjs`) дописывает его к `backgroundMode`: `on`/`off` дают `auto:haze=on`, `keep:haze=off` и т. п.,
`auto` оставляет `backgroundMode` как есть; `jobs.mjs` и `preprocess.mjs` ничего не знают про фильтр. В задании
сохраняются и `hazeFilter`, и свёрнутый `backgroundMode` (переизвлечение сетки берёт его как есть). Из командной
строки: `prepare_concept.py <src> <dst> auto:haze=on <reference.png> <metadata.json>`; самопроверка —
`python prepare_concept.py --selftest` (синтетические корабль с дымкой, персонаж, `off`, корабль без дымки).

Что записывается: в метаданные подготовки (`framing` в `preparedConcept.reference`) добавлен ключ
`haze: {mode, applied, removed_px, components, reason}`; `reason` — по-английски, с размером, долей вне оболочки и
стороной корабля, где найдена дымка (или почему фильтр не сработал). Строка `Haze filter: {...}` идёт и в stdout.

Измерено на концепте SQ-03 (`ship_sq03_gunship_ref.jpg`, кадр 2000×1116) против ручной маски v1 (`C:/afq/ref/mask.png`,
шлейфы вырезаны вручную). Полный прогон `prepare_concept.py` с rembg при `haze=off` воспроизводит подготовку студии
пиксель в пиксель (`prep_ref.png`):

| Порог альфы | IoU до фильтра | IoU после |
|---|---|---|
| > 5 (то, что видит обрезка) | 0,9008 | 0,9708 |
| > 64 | 0,9678 | 0,9885 |
| > 128 (порог ручной маски) | 0,9999 | 0,9982 |
| мягкий IoU (по весу alpha) | 0,9684 | 0,9815 |

Убрано 63 136 px (8,6 % площади ядра) — обе дымки справа от сопел; колокола сопел и вся геометрия корпуса целы
(пиксели ядра не менялись). Габарит обрезки сжался с 1881×918 до 1806×851. Остаток разницы при пороге 5 — мягкая
кайма корпуса (в ручной маске её нет). На 12 концептах «Врат героев» (призрак, дракон, грифон, ангел, конь, всадники,
вампир, лич, скелет, зомби) `auto` ничего не трогает, и `on` тоже ничего не нашёл. Время фильтра — около 1,4 с на 2258×2258.

Честные ограничения:

- Настроено на одном реальном концепте (SQ-03) и синтетике; других кораблей с шлейфом под рукой не было.
- Дымка, которую rembg сделал почти непрозрачной (alpha ≥ 200), не убирается — это сознательно: отличить такой шлейф от
  гладкой тёмной панели корпуса надёжно нельзя.
- Мягкое свечение вокруг всего корпуса, слитое с дымкой в одно пятно, уходит вместе с ней; полупрозрачная деталь на конце
  корабля (стекло, плавник, силовое поле) для фильтра неотличима от дымки — ставьте `off`.
- Вертикальный корабль (нос вверх/вниз) в `auto` не фильтруется — нужен `on`.
- Остаются мягкие клочки у нижней стороны корпуса (тень, не выхлоп) и тонкая кайма; на ≤ 2 px у края ядра фильтр не режет.
- Эффект на форму (IoU силуэта 0,88 → 0,97 в v1) получен с ручной альфой; повторный прогон Hunyuan3D с автоматической
  альфой в этом раунде не делался — альфа при пороге 128 совпадает с ручной на 0,998.
