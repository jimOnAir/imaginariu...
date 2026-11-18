# Инструменты интегратора: три MCP-сервера и CLI

`APP` = `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\Imaginarium`. Все три сервера зарегистрированы в
Claude Code в scope user — их видит любая сессия. Проверка — `engine_status`, восстановление —
`engine_mcp_register`.

## 1. `imaginarium` — студия и движки (`APP/ai/mcp/server.mjs`)

| Группа | Инструменты | Когда |
|---|---|---|
| Студия | `studio_status`, `studio_start`, `studio_open` | начало работы; запуск сервера 3210 (ComfyUI 8188 владельца не трогается) |
| Генерация 3D | `asset_upload`, `generate_3d`, `jobs_list`, `job_get`, `job_cancel` | картинка или текст → GLB (Pixal3D / Hunyuan, локально) |
| Генеративный сервис | `generator_status`, `generator_nodes`, `generator_graphs`, `generator_run`, `generator_restart` | бэкенд-диагностика (ComfyUI, GPU, очередь), классы узлов, список графов, запуск с ожиданием, перезапуск сервиса; границы семьи — раздел «Границы семейства generator_*» в `ai/mcp/README.md` |
| Ракурсы | `views_status`, `views_create`, `views_generate`, `views_get`, `views_cancel` | виды сзади и сбоку по одной картинке, затем 3D по четырём видам |
| Кузница | `forge_steps`, `forge_presets`, `forge_assets`, `forge_asset_show`, `forge_create`, `forge_run`, `forge_job(s)`, `forge_job_cancel`, `forge_batch`, `clips_list`, `clips_import`, `sculpt`, `sculpt_transfer` | чистка, риг, клипы, предметы, ткань, корабли — скилл **imaginarium** |
| Экспорт | `forge_export` (`godot`, `space_quest`, `heroes_gates`, `iso8`, `unity`, `unreal`), `forge_export_fetch` | пакет под движок; `out` — ждать и скачать |
| Спрайты | `sprites_render` (`iso8`, `heroes_gates`, `custom`, `pixel`) | 2D и изометрия |
| Эффекты | `fx_presets`, `fx_texture_types`, `fx_texture_generate`, `vfx_tools`, `vfx_textures`, `vfx_tool_launch` | скилл **imaginarium-vfx** |
| Звук | `sound_status`, `sound_generate` (`sfx` — эффект по описанию, `loop` — петля на `bars` тактов), `sound_list`, `sound_bind`, `sound_export` | озвучка ассета: шаги, удар, заклинание, фоновая петля; файлы WAV/OGG без служебных меток; `sound_export {engine:"bevy"}` — банк `assets/imaginarium/sounds/<slug>/` + манифест `ima_sounds.json` для крейта imaginarium_bevy; удаления нет — корзина `data/sound/trash` |
| Проекты студии | `projects_list`, `project_get` | сцены редактора студии — это не проекты движков |
| **Движки** | `engine_status`, `engine_project_create`, `engine_project_link`, `engine_send`, `engine_scaffold`, `engine_test`, `engine_mcp_register` | проекты Unity, Godot, Unreal и Bevy в фоне: создать, привязать, положить пакеты, логика по шаблону, тесты без окон (Bevy — headless cargo-проверка пакета крейтом) |
| Unity-пакеты | `unity_status`, `unity_send`, `unity_check` | точечная работа с пакетами Unity и проверочным проектом студии |

## 2. `UnityMCP` — живой редактор Unity (MCP for Unity 10.3.0, CoplayDev, MIT)

- Сервер `uvx --from mcpforunityserver==10.3.0 mcp-for-unity --transport stdio` подключается к мосту редактора
  (`127.0.0.1:6400`).
- Мост стартует с редактором, если в проекте стоит пакет `com.coplaydev.unity-mcp` и включён stdio. Это делают
  `engine_project_create` (`withMcp`) или `imaginarium_unity_send.mjs --with-mcp`.
- **Работает, только пока проект открыт в Unity.** Телеметрия выключена: `UNITY_MCP_DISABLE_TELEMETRY` и
  EditorPrefs.

| Группа | Инструменты |
|---|---|
| Сцена и объекты | `manage_scene` (get_hierarchy, load, save…), `find_gameobjects`, `manage_gameobject` (create, в том числе `prefab_path`; modify, delete), `manage_components`, `manage_prefabs`, `manage_camera`, `manage_physics` |
| Ассеты и вид | `manage_asset`, `manage_material`, `manage_shader`, `manage_texture`, `manage_graphics`, `manage_vfx`, `manage_animation`, `manage_ui`, `manage_probuilder`, `import_model`, `import_model_file` |
| Код | `create_script`, `manage_script`, `apply_text_edits`, `script_apply_edits`, `validate_script`, `delete_script`, `find_in_file`, `get_sha`, `manage_script_capabilities`, `manage_scriptable_object`, `execute_code` |
| Редактор | `manage_editor` (play, pause, stop…), `execute_menu_item` (меню **Imaginarium →** пересборка, импорт, проверка), `refresh_unity`, `read_console`, `manage_packages`, `manage_tools`, `set_active_instance`, `unity_reflect`, `unity_docs` |
| Тесты и сборка | `run_tests`, `get_test_job`, `manage_build`, `manage_profiler`, `batch_execute` |
| Облако (без решения владельца не звать) | `generate_image`, `generate_model`, `generate_audio`, `blender_bridge` |

## 3. `godot` — Godot MCP (Vollkorn-Games, MIT, `C:\Dorn\Dops media\tools\godot-mcp`)

`GODOT_PATH` = Godot 4.5.1 console. Сцены и скрипты меняются headless-процессами Godot — **окон нет**.

| Группа | Инструменты | Окно |
|---|---|---|
| Проект | `get_project_info`, `list_projects`, `get_godot_version`, `edit_project_settings`, `manage_autoloads`, `list_input_actions`, `get_uid`, `update_project_uids` | нет |
| Сцены | `create_scene`, `add_node`, `remove_node`, `rename_node`, `reparent_node`, `duplicate_node`, `instantiate_scene`, `set_node_properties`, `get_node_properties`, `get_scene_tree`, `connect_signal`, `add_to_group`, `save_scene`, `validate_scene`, `batch_operations` (быстрее) | нет |
| Скрипты | `write_script`, `read_script`, `validate_script`, `attach_script` | нет |
| Ресурсы и анимация | `load_sprite`, `create_resource`, `create_tileset`, `set_cells`, `export_mesh_library`, `create_animation_player`, `add_animation`, `set_collision_layer_mask` | нет |
| Анализ | `get_scene_insights`, `get_node_insights`, `capture_screenshot` (статичный рендер сцены) | нет |
| Игра вживую | `run_interactive`, `send_key_sequence`, `game_state`, `evaluate_expression`, `game_screenshot`, `run_and_capture`, `run_project`, `launch_editor` | **да — только по просьбе владельца** |
| Тесты GUT | `run_tests` (если в проекте стоит GUT) | нет |
| Asset Library | `search_assets`, `install_asset` | загрузка — только с «да» владельца |

## 4. CLI (когда MCP нет или нужна командная строка)

```
node APP/scripts/engines/imaginarium_engine.mjs status
node APP/scripts/engines/imaginarium_engine.mjs create --engine unity|godot --name "<Игра>" [--with-mcp] [--renderer gl_compatibility]
node APP/scripts/engines/imaginarium_engine.mjs link --path "<проект>" [--name "<Игра>"]
node APP/scripts/engines/imaginarium_engine.mjs send --project "<Игра>" --engine unity|godot <пакет|zip> ...
node APP/scripts/engines/imaginarium_engine.mjs scaffold --project "<Игра>" --engine … --kind player --asset <asset_id>
node APP/scripts/engines/imaginarium_engine.mjs test --project "<Игра>" --engine … [--shots] [--playmode]
node APP/scripts/engines/imaginarium_engine.mjs mcp-register
node APP/scripts/forge.mjs export <assetId> --profile unity|godot [--direct] [--to-unity <проект> --build]
py -I APP/scripts/unity/unity_check.py <пакет> ... --out <папка>
```

- Реестр проектов: `C:\Imaginarium\engines\projects.json`. Отчёты тестов и кадры: `C:\Imaginarium\engines\reports\<игра>_<время>\`.
- Рабочий Unity-проект студии с MCP: `C:\Imaginarium\unity\ImaginariumUnity`.
- Проверочные проекты: `C:\Imaginarium\unity\ImaginariumUnityCheck` (URP), `ImaginariumUnityCheckBuiltIn`.
