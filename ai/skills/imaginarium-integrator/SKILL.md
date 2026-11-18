---
name: imaginarium-integrator
description: Интегратор Imaginarium ↔ игровые движки в Claude Code — один агент управляет 3D-студией Imaginarium (концепты, 3D-ассеты, риг, анимации, эффекты, спрайты), Unity, Godot и Bevy. Создаёт и привязывает проекты движков в фоне, отправляет ассеты в нужный движок, выстраивает под них логику (управление персонажем, сцены, тесты), тестирует всё в фоне без окон, оптимизирует под платформу и отчитывается. Используй, когда говорят «запускаем Imaginarium», «сделай игру / прототип в Unity / в Godot / в Bevy», «персонаж (ассет, модель, юнит) для игры в Unity / Godot», «отправь ассет в Unity / Godot / Bevy», «создай / привяжи проект Unity / Godot / Bevy», «собери сцену / уровень в движке», «протестируй проект», «настрой логику под персонажа», «интегратор», «агент Imaginarium», а также при любой задаче, где ассет из студии должен заработать в движке. Само создание ассета — скилл imaginarium, эффекты — imaginarium-vfx; этот скилл ведёт всю цепочку и движки.
---

# Imaginarium Integrator — студия + Unity + Godot + Bevy из Claude Code

Imaginarium в Claude Code — это интегратор. Владелец пишет, что нужно («персонаж-лучник для игры в Unity»), а
агент проводит всю цепочку:

**концепт → 3D → риг и клипы → эффекты → пакет под движок → проект движка → логика под ассет → тесты в фоне → отчёт.**

Принципы:

- **Фон по умолчанию.** Unity — только `-batchmode`, Godot — только `--headless`. Кадры Godot снимаются из окна
  за пределами экрана. Окна редакторов не открываем: владелец работает за этим же компьютером.
- **Живой редактор — только если он уже открыт** (или владелец просит). Тогда работаем через MCP редактора,
  batchmode в этот момент невозможен.
- **Один язык с владельцем — русский**, коротко. Время — по Бали.
- Писать в проекты движков владельца — только по его просьбе. Проекты, созданные агентом, лежат в
  `C:\Imaginarium\engines\projects\`.

## Чем управляешь (три MCP-сервера + CLI)

| Сервер | Что | Главное |
|---|---|---|
| `imaginarium` | студия: генерация 3D, ракурсы, Кузница (риг, клипы, предметы, эффекты, экспорт), спрайты, VFX, звук — **и движки** | `forge_*`, `generate_3d`, `views_*`, `sprites_render`, `fx_*`, `sound_*` (озвучка ассета: `sound_status`, `sound_generate`, `sound_list`, `sound_bind`, `sound_export`); генеративный сервис: `generator_status`, `generator_nodes`, `generator_graphs`, `generator_run`, `generator_restart` (глаголы управления движком-плагинами, редактор графов и `learn_*` в этой ветке не реализованы — границы семьи описаны в `ai/mcp/README.md`); движки: `engine_status`, `engine_project_create`, `engine_project_link`, `engine_send`, `engine_scaffold`, `engine_test`, `engine_mcp_register`; Unity-пакеты: `unity_send`, `unity_check` |
| `UnityMCP` | живой редактор Unity (MCP for Unity 10.3.0, 48 инструментов); работает, пока проект открыт в Unity | `manage_scene`, `manage_gameobject` (`create` с `prefab_path`), `manage_prefabs`, `manage_script`, `manage_material`, `execute_menu_item` (меню **Imaginarium**), `run_tests`, `read_console`, `manage_build` |
| `godot` | Godot MCP (75 инструментов): сцены, узлы, скрипты, ресурсы, анимации — headless-процессами Godot; интерактивный прогон игры | `create_scene`, `add_node`, `instantiate_scene`, `write_script`, `attach_script`, `validate_script`, `validate_scene`, `batch_operations`, `get_scene_tree`; `run_interactive` / `send_key_sequence` — **только по просьбе**: открывают окно игры |

CLI-дубли (когда MCP недоступен или нужен прямой запуск):

- `node <APP>/scripts/engines/imaginarium_engine.mjs status | projects | create | link | send | scaffold | test | mcp-register`;
- `node <APP>/scripts/forge.mjs …`;
- `node <APP>/scripts/unity/imaginarium_unity_send.mjs …`.

Здесь `APP` = `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\Imaginarium`. Полная карта инструментов —
`references/tools.md`.

## Шаг 0. Начало каждой работы (секунды)

1. `engine_status` (или `imaginarium_engine.mjs status`): редакторы, лицензия Unity, MCP-серверы, реестр проектов.
   - Нет `UnityMCP` или `godot` → `engine_mcp_register`; инструменты появятся в **новой** сессии. Другие
     запущенные Claude иногда перезаписывают `~/.claude.json` и теряют записи — тогда повторить регистрацию.
   - Лицензия Unity устарела или batchmode пишет «No valid Unity Editor license» → попросить владельца войти
     в Unity Hub. Пароли не вводить.
2. `studio_status` (MCP `imaginarium`): работает ли студия на 3210. Выключена — `studio_start`, если нужна
   генерация или Кузница. Экспорт и проверку пакетов можно делать и без сервера: `forge.mjs --direct`.
3. Какой движок? Если владелец не сказал — спросить **один раз** коротко: Unity (URP), Godot 4.5 или Bevy 0.20 (Rust нужен только для headless-проверок и сборки; проект и пакеты живут и без него). Если у
   игры уже есть проект в реестре — взять его.

## Главный путь: «ассет для игры в движке»

1. **Проект.**
   - Нет проекта — `engine_project_create {engine, name}`. Unity: URP, импортёр и MCP за ~70 с. Godot:
     `project.godot` и импорт за ~3 с. Bevy: cargo-проект из шаблона интегратора (плеер-стартер +
     path-зависимость на крейт `imaginarium_bevy`) — секунды; «редактор» здесь — сам `cargo`.
   - У владельца есть свой проект — `engine_project_link {path}`.
2. **Ассет** — по скиллу **imaginarium**: концепт → ракурсы → 3D (Pixal3D) → Кузница (cleanup, риг, клипы,
   предметы) → эффекты (imaginarium-vfx) → **приёмка по `quality-lessons.md`**. Готовый ассет из библиотеки
   берём как есть: `forge_assets` / `forge_asset_show`.
3. **Пакет под движок** — экспорт профилем движка:
   - Unity: `forge_export {assetId, profile:"unity", out}`. Внутри шаг `unity_package` сам проверит пакет в
     Unity — 71 проверка, «нет розового», размер как в Godot.
   - Godot: `forge_export {profile:"godot"}`, проверка в Godot 4.5.1.
   - Bevy: `forge_export {profile:"bevy"}` — GLB + паспорт `ima_bevy.json`; шаг `bevy_package` при наличии
     Rust сам прогоняет пакет через headless-проверку (крейт играет паспорт) и снимает превью-кадры
     (`bevy_check`, `bevy_shots`, `bevy_log`, `bevy_forward`); без Rust — пакет тот же, минус проверка.
   - Спрайтовая игра: сначала `sprites_render` (iso8 / pixel), затем экспорт подхватит листы.
4. **В проект:** `engine_send {project, engine, sources:[папка пакета или zip]}`.
5. **Логика под ассет:**
   - Играбельный персонаж — `engine_scaffold {kind:"player", assetId}`: управление + смоук-тесты.
   - Bevy: запуск — одна строка `app.add_imaginarium_asset("assets/imaginarium/<asset_id>/ima_bevy.json")`
     (автостарт клипа, бленды, эффекты в сокетах, хот-релоад модели); звуки — `sound_export
     {engine:"bevy"}` (банк `assets/imaginarium/sounds/<slug>/` + `ima_sounds.json`), `ImaginariumSoundPlugin`
     и `play_sound("attack")`; стартер движения — `engine_scaffold`/шаблон (`src/player.rs`).
   - Остальное пишешь сам кодом движка поверх компонентов Imaginarium: `ImaginariumSockets`, `ImaginariumFxMount`,
     `ImaginariumAnimations`, `ImaginariumSprite8Dir` в Unity; `ima_fx_mount.gd`, `AnimationPlayer` в Godot.
   - Рецепты по видам ассетов (NPC, существо, реквизит с огнём, дерево, корабль, спрайты, оружие в руке) —
     `references/recipes.md`.
6. **Сцена или уровень:**
   - Godot — инструментами `godot` (`create_scene`, `instantiate_scene`, `add_node`) или файлом `.tscn`.
   - Unity в фоне — редакторным скриптом с `-executeMethod`. Если редактор открыт — `UnityMCP`
     (`manage_scene`, `manage_gameobject create prefab_path`).
   - Главную сцену прописать в проекте: в Godot `run/main_scene`, в Unity — EditorBuildSettings.
7. **Тесты в фоне:** `engine_test {project, engine, shots:true}`.
   - Unity: проверка пакетов + EditMode (`playMode:true` — ещё PlayMode).
   - Godot: все сцены грузятся и работают 120 кадров + `res://tests/run_tests.gd`.
   - Красное — чинить и повторять; тесты не ослаблять.
8. **Отчёт владельцу:** что сделано, где проект, цифры тестов, кадры (`SendUserFile`), что не проверено.

## Оптимизация (что делать по умолчанию)

| Платформа | Персонаж | Реквизит | Текстуры | Прочее |
|---|---|---|---|---|
| ПК (Unity URP, Godot Forward+) | 15–40 тыс. треугольников | до 15 тыс., LOD от 3000 | 2048 | LOD у статики (`unity_package` делает сам), тени |
| Мобильные и веб (Godot `gl_compatibility`, Unity URP Mobile) | 5–10 тыс. | 1–3 тыс. | 1024 | эффекты не больше 64–128 частиц, без следов частиц в GL Compatibility |
| Пиксель / 2D | спрайты `pixel` / `iso8` | — | Point-фильтр без сжатия | 1 м = 1 единица (PPU = px/м) |

- Бюджет задаётся в Кузнице (`cleanup target_tris`, `lod_*` у `unity_package`), а не правкой в движке.
- Вес пакета: FBX и PNG. Текстуры больше нужного — уменьшать в студии.
- Скорость сборки: несколько ассетов — одним `engine_send` и одним `engine_test`. Unity стартует 15–25 с на
  каждый запуск.

## Правила

1. Загрузки, сторонние пакеты движков и новые версии MCP — только с явного «да» владельца на конкретный пакет
   и версию. Облачные генераторы (`generate_*` у `UnityMCP`, Meshy, Tripo) — только по решению владельца: 3D
   делает Imaginarium локально.
2. Не трогать ComfyUI на 8188, `data\` студии, ключи. Игры с правилами агентов («Врата Героев», Space Quest)
   получают ассеты только через их роль `art` — скилл **imaginarium**, `references/games.md`.
3. Не открывать окна без нужды:
   - Godot MCP `run_project` / `run_interactive` / `launch_editor` — только по просьбе;
   - Unity GUI — только если владелец сам работает в редакторе.
4. Проект открыт в Unity → batchmode не запускать (заблокирован). Работать через `UnityMCP` или попросить
   закрыть.
5. Честность: «тесты зелёные» — только с цифрами из отчёта. Скриншот — не «игра готова». Ограничения называть.
6. Публикация, сборки для магазинов, выкладка — только по слову владельца.

## Куда читать дальше

| Нужно | Файл |
|---|---|
| Все инструменты трёх MCP-серверов и CLI, когда что брать | `references/tools.md` |
| Рецепты «ассет → движок → логика» по видам ассетов, сцены, шаблоны кода | `references/recipes.md` |
| Тесты в фоне, отчёты, ошибки и что с ними делать | `references/testing.md` |
| Экспорт в Unity подробно (импортёр, оси, материалы, проверки) | скилл **imaginarium**, `references/unity.md`; `APP/docs/forge/unity.md` |
| Экспорт в Godot (пакеты, сокеты, эффекты) | `APP/docs/forge/export.md` |
| Создание ассетов, Кузница, качество | скилл **imaginarium** (`quality-lessons.md` перед сдачей) |
| Эффекты и VFX-текстуры | скилл **imaginarium-vfx** |
| Шаблоны кода (Unity C#, Godot GDScript) | `templates/unity/Game/…`, `templates/godot/…` |
