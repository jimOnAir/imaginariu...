# Imaginarium Forge — контракт модулей (10.10.2026)

Этот документ — общий договор для всех новых модулей «кузницы»: Blender-воркер, авториг, Mixamo, существа,
предметы, корабли, спрайты, экспорт в Godot, паспорт ассета, пакетный режим, интерфейс мастера.
Меняется только основной сессией. Модули, которые ему не соответствуют, не принимаются.

## 1. Зачем

Существующая студия (React + three.js + Express + собственный ComfyUI 8190) делает геометрию из картинки и
текста, но риг, веса и анимация в ней эвристические и живут только в браузере. Кузница добавляет
воспроизводимый серверный конвейер на Blender 5.0 без окна: чистка → риг → клипы (Mixamo и процедурные) →
предметы в руках → эффекты → экспорт в Godot и спрайты. Всё локально, без облака.

## 2. Раскладка файлов

| Путь | Что |
|---|---|
| `scripts/blender/imaginarium_run.py` | единая точка входа в Blender: `-- <step> <request.json>` |
| `scripts/blender/imaginarium_common.py` | общие помощники: аргументы, импорт/экспорт GLB/FBX, нормализация, отчёт |
| `scripts/blender/steps/<step>.py` | один шаг конвейера = один модуль с функцией `run(req) -> dict` |
| `scripts/blender/tests/` | самопроверки шагов на синтетике и на ассетах с диска |
| `server/blender.mjs` | запуск Blender, очередь, таймауты, разбор результата, журналы |
| `server/forge.mjs` | паспорта ассетов, конвейер, библиотека клипов, маршруты `/api/forge/*` |
| `scripts/forge.mjs` | командная строка: сборка паспорта, пакеты |
| `src/forge/` | интерфейс мастера (React) |
| `<library>/assets/<id>/` | паспорт `asset.json` и версии `v001/…` |
| `<library>/animations/` | библиотека клипов: `index.json` и файлы клипов |
| `<library>/kits/` | наборы деталей (тела, одежда, оружие, детали кораблей), если появятся |
| `docs/` | этот контракт, отчёты модулей, аудит |

`<library>` — библиотека кузницы: по умолчанию `C:\Imaginarium\library` на Windows (короткие пути: Blender и Godot ломаются за пределом 260 символов), переопределяется `IMAGINARIUM_LIBRARY`; журналы Blender и рабочие файлы — `C:\Imaginarium\runtime` (`IMAGINARIUM_RUNTIME`). В git библиотека не попадает. Файлы проекта вне перечисленных модули не трогают; `server/index.mjs`,
`src/App.jsx` и `package.json` правит только интегратор (одна строка подключения на модуль).

## 3. Вызов шага Blender

```
"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
    --python scripts/blender/imaginarium_run.py -- <step> <request.json>
```

Путь к Blender: переменная `IMAGINARIUM_BLENDER`, иначе путь выше. Для шагов, которым нужен исходный .blend,
запрос содержит `inputs.blend`; `imaginarium_run.py` открывает его сам (`bpy.ops.wm.open_mainfile`).

`request.json`:
```json
{
  "step": "rig_humanoid",
  "inputs": {"mesh": "abs/path/model.glb"},
  "params": {"height_m": 1.8},
  "out_dir": "abs/path/out"
}
```

Шаг пишет `out_dir/result.json` и последней строкой stdout печатает `IMAGINARIUM_RESULT {json}` (одна строка).
При ошибке — `IMAGINARIUM_ERROR {"step":..., "error":..., "trace":...}` и код выхода 1.

`result.json`:
```json
{
  "ok": true,
  "step": "rig_humanoid",
  "outputs": {"glb": "...", "blend": "...", "preview": "...png"},
  "stats": {"tris": 48000, "bones": 65},
  "checks": [{"name": "unweighted_vertices", "ok": true, "value": 0, "limit": 0}],
  "warnings": ["..."]
}
```

Все пути в запросе и ответе абсолютные. Шаг не пишет за пределы `out_dir` (кроме временной папки ОС).
Пути держать короче 260 символов (MAX_PATH Windows ломает Blender). Шаг, который запускает Godot,
перенаправляет `APPDATA`/`LOCALAPPDATA` дочернего процесса внутрь `out_dir` (`_export_lib.godot_env`),
чтобы Godot не писал кэш и настройки в профиль пользователя. Для проверок проектов Space Quest и «Врат»
брать только Godot 4.5.1 (`IMAGINARIUM_GODOT` или `C:/Dorn/Game Dev/Godot_v4.5.1-stable_win64_console.exe`), не 4.7.
Каждый выход `.glb` сопровождается `.blend` для пересборки, если шаг меняет сцену.
`checks` — машинные проверки качества; `ok:false` в любой проверке с `"severity":"error"` делает весь
шаг `ok:false`. Предупреждения не валят шаг.

## 4. Система координат и масштаб

- Blender: Z вверх, метры, 1 BU = 1 м. Трансформы применены (масштаб 1, поворот 0), низ на `z = 0`,
  центр по X/Y в нуле.
- **Персонажи и существа** смотрят в **−Y** Blender (как Mixamo): glTF с `export_yup=True` даёт +Z вперёд.
- **Корабли, турели, станции, реквизит Space Quest** — по контракту Space Quest: нос **+Y** Blender,
  в glTF нос **−Z**, правый борт +X, зеркало по `X = 0`, корень в геометрическом центре корпуса.
- Профиль экспорта может развернуть персонажа носом в −Z для Godot (`forward_axis` профиля);
  направление всегда пишется в паспорт и в метаданные экспорта.
- Рост по умолчанию: человек 1.8 м; существа и корабли — из параметров паспорта.

## 5. Скелеты

**Человекоподобные — имена Mixamo**, чтобы клипы Mixamo ложились без переименования:
`mixamorig:Hips, Spine, Spine1, Spine2, Neck, Head, HeadTop_End, LeftShoulder, LeftArm, LeftForeArm,
LeftHand, RightShoulder, RightArm, RightForeArm, RightHand, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase,
LeftToe_End, RightUpLeg, RightLeg, RightFoot, RightToeBase, RightToe_End` (25 основных) плюс пальцы
`{Left,Right}Hand{Thumb,Index,Middle,Ring,Pinky}{1..4}` (40) — пальцы необязательны (`params.fingers`).
Поза покоя — та, в которой пришла сетка (A, T или руки вниз); перенос клипов учитывает разницу поз (§7).

**Существа — шаблоны** (`quadruped`, `bird`, `winged_quadruped`, `hexapod`, `octopod`, `serpent`, `custom`).
Имена: `root`, `pelvis`, `spine_01..`, `neck_01..`, `head`, `jaw`, `tail_01..`, ноги
`leg_<front|mid|mid2|back>_<l|r>_<1..3>` и `paw_<front|mid|mid2|back>_<l|r>`, крылья `wing_<l|r>_<1..3>`.
Сложенные крылья подгоняются вдоль бока и помечаются в `rig.json` как `folded` (полёт для них не строится).
Полный список каждого шаблона — в `docs/forge/creatures.md` (пишет модуль существ).

## 6. Точки крепления (сокеты)

Одно соглашение для всех типов — соглашение Space Quest: пустышка `socket_<вид>_<место>`
(ASCII, snake_case, без точек) с custom property `game_socket` = то же имя (уходит в glTF extras),
плюс `kind` и при необходимости `size_class` ("S"/"M"/"L"). Помощник: `imaginarium_common.add_socket`.
Родитель — кость (`parent_type = BONE`) или объект.

| Тип | Сокеты |
|---|---|
| человек | `socket_mount_hand_r`, `socket_mount_hand_l`, `socket_mount_shield_r`, `socket_mount_shield_l`, `socket_mount_back`, `socket_mount_hip_l`, `socket_mount_hip_r`, `socket_fx_head`, `socket_fx_chest` |
| существо | `socket_fx_head`, `socket_fx_mouth`, `socket_mount_back` (седло), `socket_fx_tail` |
| предмет | `socket_grip_main` (точка хвата), `socket_grip_off` (вторая рука, если есть), `socket_fx_tip` |
| корабль | виды Space Quest: `turret`, `launcher`, `thruster`, `utility`, `cargo`, `docking`, `sensor`, `mount`, `muzzle`, `fx`; риг турели `socket_mount → pivot_yaw → pivot_pitch → socket_muzzle_01…` |

Щитовой сокет `socket_mount_shield_<side>` — ребёнок кости кисти: рамка сокета руки × подогнанный поворот
и отступ, рассчитанные один раз на персонажа по каноническому щиту (+Z вверх, −Y — лицевая сторона,
хват — ручка в центре тыльной стороны). Любой щит меняется совмещением его `socket_grip_main` с этим сокетом.

Ориентация. У сокета руки и у `socket_grip_main` предмета одинаковая рамка: локальная **+Z** — вдоль
клинка или древка от кисти, локальная **−Y** — лезвие/лицевая сторона. Крепление предмета = совмещение
`socket_grip_main` предмета с `socket_mount_hand_*`. У кораблей — правила Space Quest: локальная +Y —
«наружу» для турели, локальная −Z — вперёд для сопла и дула. Узлы рига турели `pivot_yaw`/`pivot_pitch` —
не сокеты: у них extras `axis` и `range_degrees`, без `game_socket`.

Пока владелец не решил иначе: рамка сопла по умолчанию `thrust` (glTF −Z — направление тяги, то есть
вперёд корабля); варианты `exhaust` и `sq_legacy` доступны через `params.thruster_frame`. На сокетах сопел
пишется `mount_d_m` (диаметр среза сопла, м) — по нему масштабируются эффекты. Бластеры по умолчанию
в рамке предмета (дуло −Y); носом +Y по правилу реквизита Space Quest — `params.forward = '+Y'`.

Ось эффектов: локальная +Y узла эффекта в Godot = +Z сокета в Blender = «наружу»; дула Space Quest
стреляют вдоль −Z Godot (= +Y Blender).

## 7. Клипы и Mixamo

Библиотека: `<library>/animations/index.json`:
```json
{"clips": [{"id": "mixamo-sword-idle", "name": "Sword idle", "category": "idle",
  "source": "mixamo", "file": "mixamo/mixamo-sword-idle.fbx", "skeleton": "mixamo",
  "frames": 60, "fps": 30, "root_motion": false, "tags": ["sword"], "imported_from": "…"}]}
```
Категории: `idle, walk, run, attack, cast, hit, death, jump, emote, fly, other`. Процедурные клипы существ
имеют источник `procedural:<clip>` (из `anim_creature/clips.json`). Идентификатор клипа задаёт папку:
`mixamo-<slug>` лежит в `mixamo/`, `fbx-<slug>` — в `fbx/`.

Режимы «на месте»: `in_place: true` снимает прямой сдвиг бёдер от начала к концу клипа и оставляет
покачивание (иначе ступни скользят); `in_place: 'strict'` снимает всё горизонтальное движение бёдер.
При `root_motion: 'lock'` на месте проигрываются только клипы передвижения (walk/run или тег
`locomotion`); стоячие клипы сохраняют движение бёдер, чтобы ступни не скользили. `extract` переносит
горизонтальное движение на некостную кость `root` для root motion в Godot. В `clips.json` пишутся
`foot_skate_cm`, `foot_skate_src_cm` и пороги.
Перенос — по алгоритму `hg_retarget.py` из «Врат Героев» (поправка покоя на кость, корень × отношение
высоты бёдер, снятие горизонтального сдвига корня по выбору). Каждый клип в выходном GLB — отдельная
анимация glTF с именем клипа; зацикленные клипы получают суффикс `-loop` (так их узнаёт импорт Godot). Процедурные клипы существ и кораблей кладутся так же.
Загрузка персонажа в Mixamo и скачивание с сайта — только руками владельца или с его явного согласия:
кузница готовит FBX для загрузки и принимает скачанные файлы, но сама в сеть не ходит.

## 8. Паспорт ассета `asset.json`

```json
{
  "id": "uuid", "name": "Некромант", "kind": "humanoid|creature|item|ship|prop",
  "created": "iso", "updated": "iso",
  "source": {"type": "image|text|params|import", "image": "...", "prompt": "...", "params": {}},
  "profile": {"height_m": 1.8, "template": "quadruped"},
  "pipeline": [{"step": "cleanup", "params": {}, "status": "done|failed|pending",
                "result": {}, "version": "v002", "at": "iso"}],
  "clips": [{"id": "idle", "source": "library:mixamo-sword-idle|procedural:walk",
             "loop": true, "in_place": true, "trim": [1, 60]}],
  "props": [{"asset": "uuid", "socket": "socket_mount_hand_r"}],
  "fx": [{"preset": "engine_trail", "socket": "socket_thruster_main_l", "params": {}}],
  "exports": [{"profile": "godot|heroes-gates-sprites|space-quest", "path": "...", "at": "iso"}],
  "qa": {"checks": [], "reviewed": false}
}
```
Пересборка = прогон `pipeline` по порядку с теми же параметрами. Версии не перезаписываются.
`qa.reviewed` ставит только человек.

## 9. Очередь и видеокарта

Шаги Blender идут через одну очередь `server/blender.mjs` (по умолчанию 1 одновременно,
`IMAGINARIUM_BLENDER_CONCURRENCY`). Шаги, рендерящие на GPU (`render_sprites`, `preview` в Cycles), берут
тот же замок, что генерация в ComfyUI 8190, чтобы не делить 12 ГБ с Hunyuan. Таймаут шага по умолчанию
15 минут, рендер — 60 минут. Журнал шага: `data/runtime/blender/<jobId>/<step>.log`.

## 10. Проверки и отчёт

Каждый модуль приносит:
1. Самопроверку в `scripts/blender/tests/test_<module>.py`: функции `test_*()` без аргументов, падают
   через `assert`; временные файлы — только в `tempfile.mkdtemp()`. Тесты на реальных ассетах с диска
   называются `test_real_*` и сами пропускаются (`return`), если файла нет. Общий прогон:
   `blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- [module]`;
   из Node — `tests/integration/blender.test.mjs` (пропускается, если Blender не найден; в `npm test` не входит).
2. Прогон на реальном ассете с диска с картинкой-превью и числами в `docs/forge/<module>.md`.
3. Честный список ограничений. Нельзя выдавать подгонку силуэта за анатомию и проекцию фото за PBR.

Быстрые тесты `npm test` (34 существующих) должны оставаться зелёными.
