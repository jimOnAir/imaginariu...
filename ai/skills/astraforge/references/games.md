# AstraForge → наши игры: роль студии, контракты, профили экспорта и путь ассета в проект

AstraForge — **единый цех ассетов для всех игр владельца** (решение 17.10.2026): модели, риг, клипы, предметы, эффекты, спрайты
и пакеты Godot для «Врат Героев», Space Quest, «Души»/SOULBOUND и любой следующей игры делает студия, ни одной игре не подчиняясь.
Игра задаёт **контракт приёмки** и **путь передачи**; студия выдаёт то, что этот контракт проходит.

Сервер и CLI студии в репозитории игр не пишут. Пакеты и записи реестров лежат в
`C:\AstraForge\library\assets\<id>\exports\` и `…\v00N\<kk>_<шаг>\`. В репозиторий игры их переносит агент **в рамках правил этого репозитория**
(роль, ветка, хуки, тесты, отчёт). Источники: `docs/forge/GUIDE.md`, `docs/forge/export.md`, `AGENTS.md` и `agents/*.md` игр, `assets/LICENSES.md`.

## 0. Подключить новую игру

1. **Найти контракт в репозитории игры** (только чтение): арт-дирекция (камера, масштаб, рост, палитры), формат записи реестра
   ассетов, тест реестра и его числа, бюджеты, оси и имена, реестр лицензий, правила агентов (`AGENTS.md`, `agents/art.md`) — кто и как кладёт файлы.
2. **Выбрать профиль экспорта** (`godot`, `iso8`/`custom`, или похожий на `heroes_gates`/`space_quest`) и подобрать параметры,
   с которыми выдача сразу проходит тест игры. Не хватает параметров — новый профиль в студии (`EXPORT_PROFILES` в `server/forge-steps.mjs`,
   шаги `render_sprites`/`godot_package`) с тестом студии; это работа в репозитории AstraForge, не в игре.
3. **Раздел игры в этом файле**: путь, движок, контракт числами, команда экспорта с параметрами, путь передачи, ворота игры.
4. **Пробный ассет**: экспорт → перенос в копию роли игры → тест реестра игры зелёный. Расхождения студии и контракта чинить в студии.
5. **Обновить**: список игр в `SKILL.md`, заметку Obsidian «AstraForge — интеграция с играми», при необходимости — бриф роли `art`
   игры (через её интегратора, предложением `reports/art/infra-*.md`).
6. Репозиторий без правил агентов (как `dusha`) — передача по его документации и с ведома владельца.

## 1. Профили экспорта (`POST /api/forge/assets/:id/export`, `forge.mjs export --profile …`)

| Профиль | Шаг | Что выдаёт | Для кого |
|---|---|---|---|
| `godot` | `godot_package` | папка `<asset_id>/`: `<asset_id>.glb` (байт-в-байт), `<asset_id>.tscn` (Node3D + экземпляр GLB `model` + `af_fx_mount.gd`), `af_fx_mount.gd`, `fx/<пресет>.tscn` (GPUParticles3D) + `fx/textures/`, `README.md`, `af_package.json`; проверка настоящим Godot 4.5.1. Все пути внутри относительные: папку кладут в любой каталог проекта (проверено `res://packages/<id>/`) | любой Godot 4 |
| `space_quest` | `godot_package` | то же + **`space_quest_models_entry.json`** (`id`, `comment`, `path: res://assets/models/<sq_type>/<id>.glb`, `forward_axis`, `up_axis: +Y`, `fit_units`, `min_units` — **единицы рендера, не метры**; без параметров — по роли (`sq_class`/`kind`), §3); GLB (только LOD0: ступени `*_lod1/2.glb` шагов кораблей в пакет не идут) с носом −Z, сокетами `socket_<вид>_<место>`, материалами `SQ_*`, `COL_SIMPLE`. Игра берёт из пакета только GLB и запись | Space Quest |
| `heroes_gates` | `render_sprites` | листы `<клип>.png` (+ `_nw`, `_se` — игра их пока не читает, §2) по 4 столбца, 12 к/с, `sprites.json`, `<asset_id>_frames.tres`, **`heroes_gates_sprites_entry.json`** (запись `data/sprites.json`, группа `units`), `preview.png`, `preview_frames.png`, `godot_check.json`; ZIP `exports\heroes_gates-v00N.zip` | «Врата Героев» |
| `iso8` | `render_sprites` | 8 направлений (S, SW, W, NW, N, NE, E, SE), EEVEE, камера 30° (2:1); для Душа/Dusha и общих нужд. Профиль `custom` задаётся шагом (`directions: [[имя, yaw°],…]`, `elevation_deg`) | любой 2D |

Параметры профиля `heroes_gates` (`docs/forge/export.md`): ортокамера 25°, 100 px/м (игра показывает с `display_scale` 0,725), Cycles OptiX 64 spp с ловцом теней (≈ 0,6 с/кадр),
`kind: unit` — по умолчанию ячейка **наименьшая из 320 → 384 → 448 px** (якорь 160/272, 192/328, 224/384, при падении тела к камере якорь поднимается; `adaptive_cell: true`) —
**контракт «Врат» этого не принимает, для игры экспорт с `adaptive_cell: false`, §2**; `kind: hero` — 448 (224/384); клипы idle, walk, attack, hit, death, cast, shoot;
12 кадров (hit 6, герой idle/cast 16); `event_frames` по умолчанию attack 6, cast 6, shoot 8 (с предупреждением — точный кадр удара задавайте сами); направления: база −25° к камере, `nw` 135°, `se` −45°,
остальное зеркалит игра; нормировка роста по первому кадру idle. Модель, не влезающая и в 448 px, падает на проверке `cell_fit` до отдачи. `in_place: drift` для пресета HG.
`godot_package`: `forward_axis -Z`, `source_forward` по виду ассета (корабли/реквизит/турели −Z, люди/существа/предметы +Z), `fx` (12 пресетов, авто-масштаб по сокету/классу/габариту, ось выхлопа сопел по геометрии),
имена клипов подгоняются под импорт Godot (`pitch_cycle-loop` → `pitch_cycle-cycle`, итог в Godot `pitch_cycle` с петлёй).

## 2. «Врата Героев» — `C:\Dorn\Dops media\heroes-gates` (Godot 4.5.1, GDScript)

Мультиагентная разработка; правила — `AGENTS.md` (главнее любого промпта, кроме прямых слов владельца Артёма Доронина), `CLAUDE.md`, `agents/<роль>.md`, `agents/QUICKSTART.md`.

- **Роли и копии**: `art` → `C:\Dorn\Dops media\heroes-gates_worktrees\art`, ветка `agent/art` (`.agent` = `art`); интегратор — `heroes-gates\` (`main`). Роль `art` владеет
  `assets/`, `art/`, `tools/art/`, `data/sprites*.json`, `data/audio*.json`, `tests/cases/test_art*`, `reports/art/` (`tools/agents/ownership.txt`). `data/creatures*.json` — роль `combat`,
  `game/`, `locale/` — `ui`. Нужна правка в чужой области — описать в отчёте, не делать.
- **Запреты**: нет слияния в `main` из веток ролей (только `tools/agents/merge.ps1`, ворота: зелёные тесты, `VERDICT: APPROVE` ревью); нет `--no-verify`, `rebase -i`, `commit --amend`, `reset --hard` по показанным коммитам;
  нет правок чужих копий и `git -C <чужой путь>`; `AGENTS.md`, `CLAUDE.md`, `agents/`, `docs/`, `tools/agents/`, `.claude/` правит интегратор.
- **Ассеты и лицензии**: коммерческая лицензия обязательна; никаких ассетов «Героев 3» и чужих игр; каждый файл — запись в `data/sprites.json` и `assets/LICENSES.md` (тест `tests/cases/test_art_registry.gd`
  проверяет, что упомянут каждый PNG/JPG из `assets/`); исходники (`.blend`, FBX Mixamo, архивы) в git не кладут; файл > 1 МБ — только с объяснением в отчёте; > 95 МБ хук блокирует.
- **Стиль** — `docs/ART_DIRECTION.md`: «как Герои 3» на своих 3D-моделях (пререндер), чуть героические пропорции, палитры Ордена (сталь, синее/белое, золото) и Нежити (кость, серо-зелёная плоть, ржавое железо, бирюзово-фиолетовое свечение),
  рост человека 1,8 м (скелет 1,75, зомби 1,7), концепт — один персонаж во весь рост, A/T-поза, светлый фон. «Оружие в руке» в `ART_DIRECTION.md` §2 —
  для прежнего пути через Mixamo; для студии концепт без оружия, оружие ставит `attach_prop`.
- **Реестр**: `data/sprites.json` — `version, px_per_meter, display_scale (0.725), obstacle_display_scale, units, heroes, obstacles, effects, projectiles, battlefields, portraits, ui_atlas, …, forms`.
  Запись юнита: `{cell:[320,320], anchor:[160,272], source, anims:{<клип>:{sheet:"res://assets/units/<id>/<клип>.png", count, cols, fps, loop, event_frame?}, …}}`, ключ = id существа из `data/creatures.json`.
  Файлы: `assets/units/<id>/{idle,walk,attack,hit,death}.png` (+ `shoot` у стрелков). Листов и ключей `_nw`/`_se` в игре нет.
- **Контракт приёмки** — тест `tests/cases/test_art_registry.gd` (проверено 17.10.2026): у каждой записи `units` ровно `cell [320,320]`
  и `anchor [160,272]` (герои `[448,448]`, `[224,384]`); `fps` 12, `cols` 4; `loop` только у idle, walk, fly; кадров: юниты hit 6, остальные 12,
  герои idle и cast 16 — **по имени анимации**, поэтому `idle_nw` и т. п. валят тест; `event_frame` обязателен у attack, shoot, cast и лежит внутри клипа;
  каждый PNG/JPG из `assets/` упомянут в `assets/LICENSES.md` и есть в реестре; существо с записью убирается из `STUB_UNITS` и вписывается в `UNITS` того же теста.
- **Экспорт под контракт** (`forge.mjs export` = заново `render_sprites` от последней версии с параметрами профиля + `--params`):
  `node scripts\forge.mjs export <ассет> --profile heroes_gates --params hg.json`, `hg.json` =
  `{"kind":"unit","asset_id":"<id существа>","in_place":"drift","adaptive_cell":false,"cell":[320,320],"anchor":[160,272],"event_frames":{"attack":<кадр удара>}}`.
  Без `adaptive_cell:false` ячейка вырастет или якорь поднимется (образец `00fd45a6…\v001\06_render_sprites`: якорь 160,261) — тест красный.
  Не влезает в 320 — `cell_fit` красный ещё в студии: правим позу, оружие, рост, а не контракт. Студия не сжимает листы палитрой: лист > 1 МБ объяснять в отчёте (цель ≤ 1,5 МБ).

### Путь ассета «концепт → модель → риг → клипы → приёмка → пакет → передача роли art»

1. **Концепт.** PNG 3:4: персонаж во весь рост, **T-поза, лицом вперёд, без оружия в руках** (оружие и щит в руках путают боковые виды; предметы потом вырезаются или ставятся `attach_prop`), нейтральный светлый фон.
   Генерация «через GPT» — скилл `codex-image` (Codex, без API-ключа); текст→картинка локально — SDXL в студии.
2. **Ракурсы.** Вкладка «Создать → Ракурсы» (ChatGPT для чистовых, MV-Adapter для черновиков) или `node scripts\views\views_generate.mjs --input front.png --out views\codex --provider codex`; недостающее — свои файлы в слотах.
3. **3D.** Pixal3D по 4 видам (≈ 4 мин): кнопка «Создать 3D по ракурсам» или `node scripts\views\views_3d.mjs --views views\codex --out mesh.glb --engine pixal3d --seed 1000`.
   Сетки Pixal3D бывают рваными: смотреть превью, а не только статус (подробности — `troubleshooting.md`).
4. **Ассет Кузницы.** `node scripts\forge.mjs create --kind humanoid --name "Имя" --from-glb mesh.glb --steps steps.json` (пример рецепта в `studio.md`; или `--preset humanoid_hg_sprites`).
   Клипы — `library:quaternius-*` (CC0) и `library:mixamo-*`; пачка из папки концептов — `scripts\forge-concepts.mjs --dir <папка> --profile heroes_gates` (читает `roles.json`).
5. **Приёмка (ворота до рендера).** (а) встроенные `checks` шагов (разрывы сетки `deform_torn_area`, бюджет, рост, `cell_fit`, масштаб спрайта, Godot-загрузка) — красная проверка останавливает шаг;
   (б) **осанка** клипов Quaternius: после `retarget` `posture.py` (на этой машине `C:\AstraForge\incoming\units_1013\_tools\posture.py`) ставит ключицы к позе покоя +6°, руку на +4° вперёд, ворота: кисти снаружи бёдер и не перед тазом,
   ключицы в стойке ≤ 18°, в ходьбе в среднем ≤ 15°; провал — **рендер не запускать** (`armfix_unit.sh` делает это сам, код 3);
   (в) превью-ролик в Godot (`preview.sh`) и локальная проверка `qwen3-vl:8b` (`_tools\vlm_check.py`: короткие вопросы да/нет, `think:false`, `num_ctx 16384`) — подсказка, главное — цифровые ворота;
   (г) вкладка «Кузница → Приёмка»: концепт рядом с анимацией, «Одобрить / На доработку / Брак», решения в `review_decisions.json`; (д) проверка Godot 4.5.1 headless в `godot_package` (только 4.5.1, не 4.7).
6. **Экспорт.** `node scripts\forge.mjs export <assetId> --profile heroes_gates --params hg.json` (спрайты под контракт, см. «Экспорт под контракт» выше) и при необходимости `--profile godot` (3D-сцена).
   Берутся `C:\AstraForge\library\assets\<id>\exports\heroes_gates-v00N.zip` или папка `v00N\<kk>_render_sprites\`.
7. **Передача в игру — делает агент роли `art` в её копии** (`C:\Dorn\Dops media\heroes-gates_worktrees\art`, ветка `agent/art`, прочитать `.agent`, `agents/art.md`, `agents/QUICKSTART.md`, `docs/ART_DIRECTION.md`):
   - `pwsh tools/agents/sync.ps1`; положить **только базовые** листы `<клип>.png` в `assets/units/<id>/`; слить запись `heroes_gates_sprites_entry.json` в группу `units` файла `data/sprites.json`
     без ключей `*_nw`/`*_se`; в `tests/cases/test_art_registry.gd` перенести id из `STUB_UNITS` в `UNITS`;
     добавить строку происхождения в `assets/LICENSES.md` (генератор, модель, лицензия клипов — CC0 Quaternius / Mixamo по условиям Adobe, «в игру идут только отрендеренные кадры»);
   - `pwsh tools/agents/run-tests.ps1` (зелёный на HEAD), коммит `art: <заголовок>`, отчёт `reports/art/<дата>-<тема>.md` (что было → что стало → как проверено → что не сделано; числами);
   - дальше ревью (`agent/review`), приёмка и слияние — интегратор через `merge.ps1`. Привязка спрайта к существу в `data/creatures*.json` — работа роли `combat`, не `art`.
   Сама студия и Claude вне роли `art` в `heroes-gates*` не пишут.

На этой машине есть рабочий конвейер бойцов (не в git, пути зашиты): `C:\AstraForge\incoming\units_1013\` — `make_refs.sh` (картинки: убрать оружие, вид сзади через codex-image), `prep_mv.py` (rembg + общий кадр),
`gen_mv.py` (Hunyuan3D-2mv), `_tools\run_pixal3d.py` (Pixal3D), `build_unit.sh` (cleanup → paint_from_concept → paint_back → rig_humanoid → fix_weights), `final_unit.py`, `armfix_unit.sh` (осанка → convert → модель фильма → превью → vlm_check),
`preview.sh`; и `C:\AstraForge\incoming\lowpoly\tools\` (`run_q.py`, `qchar.py`, `grip_solve.py`, `clip_audit.py`, `fist.py` …) для low-poly бойцов Quaternius. Это инструменты выпусков роликов, а не часть студии; на другом ПК их нет.

Решения владельца по стилю бойцов (из памяти): клипы брать из сборок «варвара»/Quaternius, **удар в прыжке (Mixamo Power Slash) отменён**; скелеты — только на основе скелета-воина C01; хват оружия — расчётом по скелету с пальцами;
для людей `cleanup target_tris` ≈ 24 000 (10 000 даёт «кашу» на лице); лоу-поли — `qchar.py --lowpoly 0.35 --flat`, палитра из эталона; красный скелет `forge_skeleton_v005` — основа для роликов (ракурс 3/4 спереди).

## 3. Space Quest — `C:\Dorn\Dops media\space_quest` (Godot 4.5.1, детерминированная симуляция)

- Правила — `AGENTS.md`, `CLAUDE.md`, `agents/art.md`: модели производит студия, в репозиторий их переносит роль **`art`** («3D Asset Director», `C:\Dorn\Dops media\space_quest_worktrees\art`, ветка `agent/art`).
  Проектный навык игры `sq-3d-factory` — это **контракт приёмки** Space Quest (оси, имена, бюджеты, ворота), студия его выполняет. Область: `3d/`, `3d models/`, `tools/art/`,
  `prototype/assets/`, `prototype/data/models.json`, `prototype/data/attachments*.json`, `game/rendering/`, `design/concepts/`, `.claude/skills/sq-3d-*`. **`prototype/sim/` модели не знает** (инварианты И2/И26), `external/` — только чтение.
  Брифы (`agents/*.md`, `.claude/agents/*.md`, `AGENTS.md`) правит только интегратор Space Quest прямым коммитом в `main`; роли и чужие сессии — предложением.
- **Бриф роли `art`** на 17.10.2026 всё ещё ссылается только на `sq-3d-factory` (Meshy — «USE NOW», свои генераторы). Предложение интегратору с готовым текстом правок
  (AstraForge — производство, `sq-3d-factory` — контракт, команда экспорта, перенос, ворота) написано 17.10.2026: `reports/art/infra-astraforge.md` — пока лежит в заметках сессий
  `C:\Users\doron\AppData\Roaming\Claude\side-session-notes\local_793b1cb7-1f29-442c-ab3c-34eaf820506f\space_quest-infra-astraforge.md`, в репозиторий игры его кладёт интегратор или роль `art`.
- **Контракт моделей** (читать перед выдачей): `.claude\skills\sq-3d-factory\SKILL.md` и `references\naming_and_axes.md` (оси, имена, сокеты, материалы `SQ_*`), `budgets.md` (бюджеты по классам),
  `quality_gates.md` (15 ворот), `manifest.schema.json`, инспектор `scripts\glb_inspect.py --class <класс> --strict`; решения владельца: корпус — одна цельная модель; ливрея через 9 общих материалов флота;
  сокеты ищутся по `extras.game_socket`; имена ASCII snake_case; превышение бюджета = красная сборка.
- Оси: Blender нос `+Y`, верх `+Z`; GLB нос `−Z`, верх `+Y`. Сокет `socket_<вид>_<место>` (`turret, launcher, thruster, utility, cargo, docking, sensor, mount, muzzle, fx`) + `extras.game_socket`, `kind`, `size_class S/M/L`;
  риг турели `socket_mount → pivot_yaw → pivot_pitch → socket_muzzle_01…` с `axis`/`range_degrees` на пивотах. Рамка сопла по умолчанию `thrust`; `mount_d_m` на соплах для масштаба эффектов.
- Бюджеты (LOD0/1/2 тр.): `ship_s` ≤ 20 000/6 000/1 500; `ship_m` ≤ 40 000/12 000/3 000; `ship_l` ≤ 60 000/18 000/5 000; `turret` ≤ 9 500/2 500/700; `module` ≤ 3 000/900/250; `drone` ≤ 4 000/1 200/400;
  у игры 15 классов в инспекторе (`glb_inspect.py` `BUDGETS`, проверено 17.10.2026; `ship_capital` > 300 м в `budgets.md` не определён): ещё `station_core` 40 000, `station_module` 25 000, `prop`, `asteroid`, `weapon_missile` и банки MultiMesh `asteroid_kit`, `debris_kit`, `structure_kit` (6 000 на меш), `drone_kit` (4 000 на меш) — у банков бюджет на самый тяжёлый меш, а не на файл (подробно — `budgets.md`).
  С 17.10.2026 все 15 есть и в студии (`_ship_lib.py` `SQ_BUDGETS`, банки с `per_mesh`; сверку держит тест `test_sq_budgets_match_inspector`).
- Что даёт Кузница: пресеты `ship_procedural` (`ship_gen`: 9 классов, 4 стиля, seed), `ship_from_mesh` (меш Pixal3D/Hunyuan → корабль, покраска по концепту, броня, надписи, LOD, коллизия), `turret`, шаг `kitbash`;
  экспорт `--profile space_quest` (+ запись `space_quest_models_entry.json`). Образец рецепта: `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\ShipSQ03Forge\v2\recipe\steps_v2.json`.
- **Экспорт под контракт** (из папки студии): `node scripts\forge.mjs export <ассет> --profile space_quest --params sq.json`, `sq.json` =
  `{"asset_id":"<id>","kind":"ship","sq_type":"<папка в assets/models>","fit_units":<ед. рендера>,"min_units":<ед. рендера>,"comment":"<что это, генератор, зерно, рецепт>"}`.
  `fit_units`/`min_units` — **в единицах рендера**, лучше явно, по соседям той же роли в `models.json`: корабли 3,4 / 0,6 (`ship_sq03_gunship`), турели 1,5 / 0,12, модули 0,3 / 0,05, станция кузницы 20 / 0, дроны 2 / 0,15, банки 1 / 0.
  Без них студия (с 17.10.2026) берёт эти же числа по роли — `"sq_class": "station"` (или класс бюджета: `station_core`, `structure_kit`…), иначе по `kind` — и предупреждает; `min_units` 0 принимается.
- Передача: роль `art` Space Quest кладёт **только `<id>.glb`** (≤ 5 МБ) в `prototype/assets/models/<sq_type>/` (`ships`, `modules`, `forge` — модели пилота 17.10, …), запись — в массив `models` файла `prototype/data/models.json`
  (`schema_version` 1, 148 записей с `path` на 17.10.2026; поля `id, comment, path, forward_axis, up_axis, fit_units, min_units`); привязки (`bindings`, `hull_bindings`, `station_models`, `structure_models`) — только по задаче.
  Манифест студии (схема игры) → `3d/production/<тип>/<id>.json`, рецепт → `3d/definitions/forge/<id>_steps.json` без абсолютных путей; генератор формы — в манифест и `THIRD_PARTY_NOTICES.md` (Hunyuan3D 2.1 — Tencent Community, решение владельца перед выпуском).
  Ворота из копии роли: `glb_inspect.py --class <класс> --strict`, `node tools/art/validate_glb.mjs` (0 ошибок, предупреждения — в отчёт), импорт headless и `prototype/tests/probe/probe_art_model.gd <id>`, `pwsh tools/agents/run-tests.ps1`,
  рубрика `sq-3d-review` < 90 → статус `prototype`; отчёт `reports/art/…`, дальше ревью и слияние интегратором. Дефекты, найденные при пилоте SQ-03 (выхлоп вверх, свечение в палитру фракции, огни на стволе, дымка выхлопа) исправлены.
- **Пилот волны 1 (в `main` игры с 17.10.2026, `ff495ce`):** станция MINING `sq_station_mining_v1` (33 366 тр.), постройка `sq_mining_platform_v1` и дрон `sq_mining_drone_v1` (банк: `forge_*_lod0..2`, один материал, цвет в вершинах) в `res://assets/models/forge/`.
  Путь: концепт ChatGPT → Hunyuan3D 2.1 → `ship_from_mesh` (`sockets: false`, класс подменён: станция `ship_l`, постройка и дрон `ship_m`/`ship_s`) → **доводчик игры** `3d/source/generators/sq_forge_finish_v1.py` (режимы `bank` и `model`: палитра флота, огни, сокеты, `COL_SIMPLE`) — профиль `space_quest` не использовался.
  Рубрика 83–86 у роли, 70–78 у ревьюера: статус `prototype`, детали концепта (перила, трубы, панели) теряются. Запросы роли к студии — `reports/art/infra-forge-pilot-requests.md` (F1–F7), см. ниже.

### Расхождения студии и контракта Space Quest (проверено 17.10.2026; чинить в студии, контракт игры не подгонять)

Проходит: `glb_inspect.py --class ship_m --strict` — PASS у пакетов `ship_sq03_gunship_v2` (39 396 тр., 9 поверхностей, 9 материалов, 2,54 МБ, 27 узлов, 16 сокетов) и `ship_sq03_gunship_hy21_forge` (35 279 тр., 1,13 МБ, 19 узлов);
Khronos Validator 0 ошибок (у v2 2 предупреждения `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` — по контракту, касательных нет); нормали PNG, альбедо JPEG; нос −Z, верх +Y, `COL_SIMPLE-convcolonly`, сокеты с `extras.game_socket`/`kind`/`size_class`; ливрея ловит `sq_armor*` по префиксу.

1. ~~**`fit_units`/`min_units` в метрах — модель исчезает**~~ — **исправлено 17.10.2026** (аналог ячейки 320 / якоря 160,272 у «Врат»). Было: `godot_package.py` без параметров писал длину в метрах и 15 % от неё (v2: 64,83 / 9,725; в игре у SQ-03 3,4 / 0,6),
   а `SQModelLibrary._instance` отдаёт примитив при `units < min_units` (виды просят 10 — ангар, 14 — полёт и бой, 20 — станции): модель длиннее ~93 м пропадала в полёте, станция 300 м (`min_units` 45) — везде.
   Стало: умолчания по роли в единицах рендера (`sq_class`, иначе `kind`; корабль 3,4 / 0,6, турель 1,5 / 0,12, модуль 0,3 / 0,05, станция 20 / 0, дрон 2 / 0,15, банк 1 / 0, прочее 1 / 0; умолчание `min_units` не больше `fit_units`) с предупреждением;
   проверки `sq_min_units_visible` (> 10 — предупреждение, > 20 — ошибка) и `sq_fit_not_below_min`; схема сервера принимает `min_units` = 0; итог — `af_package.json` → `sq_units` (`docs/forge/export.md`, «Единицы Space Quest»).
2. **Пакет несёт `.tscn`, `af_fx_mount.gd`, `fx/`, README, `af_package.json`, а игра читает только GLB** по `models.json`; в `prototype/game/` нет обращений к `socket_thruster*`, `socket_fx*`, GPUParticles3D — эффекты студии в кадр Space Quest не попадают.
   Подключить эффекты в игре — задача роли `art` (`game/rendering/`, врезка в `sq_space_view_3d.gd` через `flight`), не студии.
3. **Классы бюджета** — ~~в студии 4 из 17~~ **исправлено 17.10.2026**: `SQ_BUDGETS` несёт все 15 классов инспектора (у игры их 15, не 17), банки с `per_mesh` — `budget_checks` судит самый тяжёлый меш (`glb_summary` → `worst_mesh_*`), пределы сверяет тест с `glb_inspect.py`.
   Открыто: шаги кораблей строят только `ship_s/m/l` и `turret` (схема `kitbash` — `ship_s/m/l`); нет пресетов станции/постройки/дрона, сокетов `dock`, `line_in`, `line_out`, `drill`, `power`, `cargo` и **режима «банк»** (один меш на ступень `<mesh>_lod0..2`, один материал `SQ_Structure`, цвет и свет в `COLOR_0`, UV = шероховатость/металличность — шейдер `sq_structure.gdshader`). Это F1 и F2.
4. **LOD**: шаги кораблей и турелей пишут `*_lod1.glb`/`*_lod2.glb` отдельными файлами, пакет несёт только LOD0 — для одиночного корабля верно (ступени строит импортёр Godot), для MultiMesh явные ступени нужны внутри одного GLB (п. 3).
5. **Материалы вне таблицы библиотеки игры**: студия вводит `SQ_ArmorPlain` и `SQ_Armor<Регион>`; ливрея работает по префиксу, но ворота 5 игры требуют имена из `naming_and_axes.md` — семейство вписывает роль `art` в свой навык (предложено).
6. **Узлы корпуса 32 или 24**: инспектор игры — 32, `budgets.md` — 24; студия считает 24 предупреждением (`strict_nodes`; с 17.10 и дрон ≤ 8, станционный модуль ≤ 16 из той же строки). v2 = 27. Решает контракт игры (предложено роли `art`).
7. **Инспектор берётся из интеграционной копии** (`SQ_ROOT` = `C:/Dorn/Dops media/space_quest`); для свежих классов роли — `ASTRA_SQ_ROOT=C:\Dorn\Dops media\space_quest_worktrees\art`.
8. **Покраска по концепту**: пороги по умолчанию `dark 0,17`, `steel_max 0,42` (`ship_from_mesh.py` `PAINT_THRESHOLDS`), для стиля SQ замерено 0,32 / 0,52 (F4); пятнистая разметка на крупных цилиндрах (F5);
   `paint.image` с путём по HTTP отклоняется (`no_local_paths`, F3) — рецепты пилота шли `--direct` с абсолютными путями. F6 — наборы `kitbash` для станций и построек (перила, лестницы, фермы, трубы, панели) — главный путь к рубрике ≥ 90; F7 — хеш сырого GLB генерации в паспорте.
   На 17.10.2026 F1–F7 открыты (17.10 в студии исправлены только п. 1 и классы бюджета п. 3).
- Эффекты кораблей (шлейф двигателя, свечение сопла, навигационные огни, вспышка выстрела) — пресеты `fx_presets.json`; редактор — вкладка «Эффекты» → скилл `astraforge-vfx`. GL Compatibility не поддерживает следы частиц (`trail_enabled`).

## 4. «Душа» / Dusha — `C:\Dorn\Dops media\dusha` (Godot 4.5, Android + Windows) и SOULBOUND — `C:\Dorn\Dops media\soulbound_mvp`

- **Dusha** (выживалка, герой создаётся в редакторе, 67 форм эволюции, 16 врагов): решение 24.09.2026 — **пререндер 3D в спрайты** (`docs/3D-ПЕРЕХОД.md`, `art3d/README.md`): концепт (ComfyUI) → модель (сейчас Meshy, ≈ 30 кредитов) →
  Blender (`art3d/<id>/<id>.blend` — исходник) → риг и клипы Mixamo (звери/летуны — свои `rig_quad`/`rig_fly`) → 8 сторон × клипы, камера сверху 45–60°, стиль чиби; свои скрипты `tools/art3d_*.py`. В репозитории **нет AGENTS.md**.
  Что применимо из AstraForge: **геометрия без платных кредитов** (Pixal3D/Hunyuan вместо Meshy; для чиби и четвероногих не проверялось), чистка/упрощение, `render_sprites` с профилем `iso8` или `custom`
  (`directions`, `elevation_deg` 45–60, `pixels_per_meter`, `cell`), `retarget` клипов Mixamo на гуманоидный скелет, процедурные клипы существ `rig_creature` + `anim_creature`. Готовую интеграцию (`AnimSet`, `CharacterRig`, сборку Android) студия не делает;
  выдача — листы PNG + `sprites.json` + `.tres`, дальше их подключает работа Dusha по её документации. Известная особенность из `art3d`: у чиби Mixamo-авториг проводит руки сквозь голову — правка плечевых костей.
- **SOULBOUND MVP** (симулятор жизни существа, Godot 4.5, 2D): 3D-конвейера нет и в MVP он не нужен; из студии применимы разве что картинки существ/стадий эволюции через `codex-image` и текст-в-картинку SDXL.
  Требования к ассетам в `README.md`/`docs` проекта не заданы.
- Для обоих проектов действуют общие запреты: чужие/нелицензионные ассеты не использовать; секреты (`Api key\*.txt`) не печатать; платные кредиты (Meshy, Tripo) — только с решения владельца.

## 4а. «Квартал 30» (зомби-оборона) — `C:\Dorn\Dops media\зомби` (Godot 4.5.1, изометрия, пиксель-арт)

Правила проекта — `зомби/AGENTS.md` (эталон стиля `концепты/ЭТАЛОН_стиль_игры.png`: тёплая сепия, плотная застройка, мешки и турели
на крышах, орда заливает перекрёсток). Репозитория git нет, ролей нет — файлы кладёт агент сессии сам, с ведома владельца.
- **Дома** — не Pixal3D, а процедурные `scripts/buildings/city_bldg.py` (8 стилей: panel khrush tower school admin shop hotel brutal;
  стены 0,3 м с проёмами, плиты, перегородки, мебель, балконы, подъезды, крыша) → `mesh_fracture.py --grid grid.json` (куски = комнаты,
  срез кольцом, `--split` блоков на ребро, средний цвет `col`) → `game/art/gen_<стиль><seed>/fracture/`. Пачка: `зомби/tools/gen_city.sh`.
  Материалы по ролям (`S_panel/S_brick/S_plaster/S_concrete/S_trim/S_glass/S_roof`, `M_slab/M_interior/M_rubble`) — узор рисует игра шейдером.
- **Пропсы** — `props_gen.py` (машины из деталей, фонари, остановки, ежи, баррикады, гнездо пулемёта); **зомби/турели** — Кузница
  (`rig_humanoid` → `retarget` mixamo-zombie-* → `render_sprites profile=pixel`, `elevation_deg` как у камеры игры, 8 направлений).
- **Приёмка:** кадр из движка рядом с эталоном; разрушение — стенд `game/lab/destroy_lab.tscn`; автопрогон `-- --autotest --quit`.

## 5. Чек-лист перед тем как объявить ассет «готов для игры»

1. `result.json` каждого шага `ok:true`, нет красных `checks`; превью **просмотрено** (статус `ok` не гарантирует, что чистка не съела тело).
2. Для людей: ворота осанки пройдены, `qwen3-vl` / глаза на контактном листе (идёт-бьёт-умирает), разрывы клипов в допуске (`motion_style`: 1 % основное, 8 % руки над головой, 4 % мантия).
3. Профиль выбран под игру и **выдача проходит её контракт** (для «Врат»: ячейка 320, якорь 160,272, только базовые листы — §2; для Space Quest: `glb_inspect.py --class <класс> --strict` и Validator из копии роли, `fit_units`/`min_units` в единицах рендера, в игру — только GLB — §3);
   Godot 4.5.1 проверка зелёная (`godot_check.json`: сцена загружена, петли, сокеты, FX, `godot_engine_errors` пусто).
4. Лицензии записаны (клипы CC0/Adobe, модели Hunyuan — ЕС/Великобритания/Корея недоступны; nvdiffrast у Pixal3D только для некоммерческого — AstraForge им не пользуется).
5. Файлы переданы через цикл роли игры; отчёт с числами.
