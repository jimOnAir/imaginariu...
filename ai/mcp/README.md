# AstraForge MCP

MCP-сервер (stdio) для локальной 3D-студии AstraForge. Claude Code и любой другой MCP-клиент управляют студией
инструментами: генерация 3D, ракурсы, Кузница (риг, клипы, экспорт), спрайты, эффекты, проекты, VFX.
Сервер ничего не делает сам: каждый инструмент — вызов настоящего HTTP API студии (`127.0.0.1:3210`) с заголовком
`x-astra-client: studio` и без Origin. Blender и Godot напрямую не вызываются, только через студию.

## Установка и запуск

```
cd <APP>\ai\mcp
npm install
npm test                 # 24 теста на фейковой студии, видеокарта и студия не нужны
node server.mjs          # stdio: сам по себе ничего не печатает, ждёт MCP-клиента
```

`<APP>` = `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge`. Зависимости (`@modelcontextprotocol/sdk`, `zod`)
ставятся только в `ai/mcp`, `package.json` студии не затронут. Нужен Node 20+.

Переменные окружения:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ASTRA_URL` | `http://127.0.0.1:3210` | адрес студии |
| `ASTRA_APP` | две папки выше `server.mjs` | папка приложения (скилл, `Start.ps1`, пресеты эффектов, `src/fx-textures.js`) |

## Регистрация в Claude Code

```
claude mcp add astraforge -- node "C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge\ai\mcp\server.mjs"
```

или вручную в `~/.claude.json` (`C:\Users\doron\.claude.json`):

```json
{
  "mcpServers": {
    "astraforge": {
      "command": "node",
      "args": ["C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge\ai\mcp\server.mjs"]
    }
  }
}
```

После регистрации перезапустите сессию Claude Code; инструменты появятся как `mcp__astraforge__<имя>`.

## Если студия выключена

Инструменты вернут ошибку: «Студия AstraForge не отвечает (…). Запустите Start.cmd в папке студии или вызовите инструмент
studio_start». `studio_start` запускает `scripts/Start.ps1 -NoBrowser` и ждёт `/api/health` до 90 с. Эффекты
(`fx_presets`, `fx_texture_generate`, `fx_texture_types`) от студии не зависят.

## Инструменты

Длинные списки принимают `limit` (по умолчанию 20, максимум 200) и `offset`. Долгие операции: `wait` + `timeoutSec`
(опрос раз в 2–3 с; по таймауту возвращается текущее состояние, задача продолжается на сервере). Ответ — компактный JSON,
длиннее 60 000 символов обрезается с пометкой.

| Группа | Инструмент | Что делает |
|---|---|---|
| Студия | `studio_status` | health + движки (Pixal3D, ComfyUI), Ollama, GPU, Blender/Godot/очередь Кузницы |
| | `studio_start` | запускает студию через `Start.ps1`, ждёт `/api/health` |
| | `studio_open` | URL интерфейса и подсказка открыть его во встроенном браузере (ничего не запускает) |
| Ассеты | `asset_upload` | PNG/JPG/WEBP/GLB/OBJ/STL → `POST /api/assets` (multipart) |
| | `asset_info` | тип, размер, имя файла у ассета или экспорта |
| | `asset_download` | скачать `/api/assets/:id`, `/api/exports/:id` или любой `/api/...` в папку |
| Генерация 3D | `generate_3d` | `POST /api/jobs`: imageId / prompt / viewSetId, движок pixal3d / hunyuan / auto, quality, seed |
| | `jobs_list`, `job_get`, `job_cancel` | список заданий, одно задание (с `wait`), отмена |
| Генеративный сервис | `generator_status` | бэкенд генерации: ComfyUI (готовность чекпойнта, чекпойнты), Pixal3D, GPU/RAM, докачка, счётчики очереди |
| | `generator_nodes` | классы узлов отвечающего ComfyUI (`contains`, `limit`/`offset`) |
| | `generator_graphs` | графы этого бэкенда: концепт SDXL, Hunyuan (по картинке / 2.1 / по ракурсам), Pixal3D — с классами узлов |
| | `generator_run` | генерация через `POST /api/jobs` с `wait`; задание видно в `jobs_list`, итог с `asset` и `validation` |
| | `generator_restart` | перезапуск ComfyUI, поднятого студией; чужой на порту не трогает — ответ это говорит |
| Ракурсы | `views_status` | готовность провайдеров codex и mvadapter |
| | `views_create` | набор ракурсов из концепта |
| | `views_generate` | достроить ракурсы (codex / mvadapter, slots, seed…) |
| | `views_get`, `views_cancel` | набор и задача (с `wait`), отмена |
| Кузница | `forge_steps`, `forge_presets` | реестр шагов (33) и готовые конвейеры; с `step` / `id` — полные описания |
| | `forge_assets`, `forge_asset_show` | паспорта ассетов, версии, экспорты |
| | `forge_create` | паспорт из `fromGlb` / `fromJob` / `fromAsset` / `params`, опционально сразу `preset` или `steps` |
| | `forge_run` | конвейер на ассете: `preset` или `steps`, `from` source / latest / v003 |
| | `forge_job`, `forge_jobs`, `forge_job_cancel` | задача (с `wait`), последние задачи, отмена |
| | `forge_export` | профиль godot / space_quest / heroes_gates / iso8 / unity / unreal / bevy / vrm1; с `out` ждёт и скачивает архив |
| | `forge_export_fetch` | скачать и распаковать готовые архивы экспорта |
| | `forge_batch` | пакет по `items.json` |
| | `forge_recipes` | рецепт и грабли класса ассета (Markdown или JSON) — читать перед заданием |
| | `forge_plan` | что сделает запуск: итоговые параметры шагов с подставленным рецептом, без новой версии |
| | `forge_journal` | журнал производства: версии ассетов с превью и вердиктом (`pending`) или отдельные запуски шагов |
| | `forge_feedback` | вердикт на версию: принято / на доработку / брак, оценка, теги брака, комментарий; `targets` — пачке |
| | `forge_recipe_pin`, `forge_learn_note` | закрепить рецепт класса (решение владельца); заметка класса: путь, грабли, совет |
| | `clips_list`, `clips_import` | библиотека клипов; импорт папки FBX |
| Unity | `unity_status` | редакторы Unity Hub, проекты Hub, проверочный проект студии, дата лицензии, версия импортёра |
| | `unity_send` | положить пакеты профиля unity (папки или zip) в проект Unity: импортёр в `Packages/`, ассет в `Assets/AstraForge/<id>/`; `build` — собрать префабы в batchmode |
| | `unity_check` | проверка пакетов в проверочном URP-проекте одним запуском Unity: отчёт, скриншоты, `contact_sheet.png` |
| Движки | `engine_status` | Unity (версии, лицензия), Godot, MCP-серверы `UnityMCP` / `godot`, реестр проектов |
| | `engine_project_create`, `engine_project_link` | проект Unity (batchmode, URP, импортёр, MCP) или Godot (headless) в фоне; привязка проекта владельца |
| | `engine_send`, `engine_scaffold` | пакеты студии в проект; логика под ассет по шаблону (`player`: управление + тесты) |
| | `engine_test`, `engine_mcp_register` | тесты без окон (Unity batchmode, Godot headless, кадры); регистрация `UnityMCP` и `godot` |
| Спрайты | `sprites_render` | шаг `render_sprites`: profile iso8 / heroes_gates / custom / pixel, directions, clips, fps, pixels_per_meter, `params` как есть |
| Скульпт | `sculpt` | шаг `sculpt`: `ops` (smooth, relax, inflate, flatten, grab, remesh, symmetrize…) с областью `region` (сфера, коробка, группа вершин, кость) и симметрией; ждёт результат, возвращает проверки и сводку; риг, веса и UV сохраняются |
| | `sculpt_transfer` | перенос формы с OBJ/GLB (экспорт вкладки «Скульпт») на модель ассета; файл загружается ассетом-источником |
| Эффекты | `fx_presets` | 12 пресетов эффектов Кузницы (`fx_presets.json`) |
| | `fx_texture_types`, `fx_texture_generate` | генератор текстур `src/fx-textures.js` (без DOM): PNG в файл, детерминированно по seed |
| Проекты | `projects_list`, `project_get` | сохранённые проекты и краткая сводка (объекты, кости, эффекты) |
| VFX | `vfx_tools` | каталог 31 генератора с доступностью |
| | `vfx_textures` | готовые текстуры; `importName` копирует в ассеты студии |
| | `vfx_tool_launch` | запустить инструмент на компьютере владельца |
| Звук | `sound_status` | звуковой движок: установлены ли MOSS-SoundEffect (эффекты) и ACE-Step (петли), чего не хватает, события для привязки, пресеты длин/темпов |
| | `sound_generate` | `POST /api/sound/tasks`: `kind=sfx` — эффект по описанию (1–30 с), `kind=loop` — петля на `bars` тактов при `bpm`; с `wait` дожидается и отдаёт запись библиотеки |
| | `sound_list` | библиотека звука проекта (фильтры `kind`, `query`; есть ли WAV/OGG) |
| | `sound_bind` | привязать звук к событию ассета (`footstep`, `impact`, `spell`…); пустой `soundId` снимает |
| | `sound_export` | звуковой набор ассета файлами в папку + `missing` с причиной (звук в корзине — это видно) |

### Границы семейства `generator_*`

Генеративным сервисом этой ветки управляет ComfyUI (плюс отдельный ComfyUI Pixal3D на :8191), и семья
перечисляет именно его. Эти глаголы здесь сознательно не реализованы и не появятся:

| Глагол | Причина |
|---|---|
| `generator_plugins`, `generator_plugin_new`, `generator_plugin_install`, `generator_plugin_toggle` | управление самим генеративным движком относится к отложенной линии AstraForge Engine (ADR-0004); ComfyUI студии работает с зафиксированным набором узлов (`--disable-all-custom-nodes`), узлы и модели ставит `installer/install.sh`, не MCP |
| `generator_graph_edit` | правка сохраняемых графов завязана на owner-режим, а механизм лицензий и owner-режим в этой ветке исключены |
| `generator_learn_status`, `generator_learn_run`, `generator_learn_activate` | самообучение и LoRA отложены вместе с линией движка |

### Границы семейства `sound_*`

Семья повторяет вкладку «Звук»: два локальных генератора (MOSS-SoundEffect v2 — эффекты, ACE-Step 1.5 —
музыкальные петли), библиотека проекта и привязки звуков к событиям ассета. Чего в ней сознательно нет:

| Глагол | Причина |
|---|---|
| `sound_delete` | удаление звука в этой ветке — всегда перемещение в корзину (`data/sound/trash`), а не стирание; агенту это право не даётся, файлы возвращает человек одним перемещением |
| `sound_import` | библиотека — то, что здесь сгенерировано; чужие файлы через MCP не заводятся (для этого есть файловая папка проекта) |
| `sound_install` | веса (≈21 ГБ) и venv ставит `installer/install.sh -Only sound`, а не агент: `sound_status` честно говорит, чего не хватает |
| `sound_play` | прослушивание — дело человека в интерфейсе; звук в библиотеке уже лежит файлами |

Ресурсы MCP: `astraforge://status` (health + status студии, JSON) и `astraforge://skill` (текст `ai/skills/astraforge/SKILL.md`).

## Типовой путь

1. `studio_status` (при необходимости `studio_start`).
2. `asset_upload` концепта → (`views_create` → `views_generate` → `views_get wait`) → `generate_3d` → `job_get wait`.
3. `forge_create` с `fromJob` и `preset` (рецепты: `forge_presets`) → `forge_job wait`.
4. `sprites_render` или `forge_export` (`out` — папка), результат — в папке и в паспорте (`forge_asset_show`).

Генерация 3D и рендер спрайтов занимают видеокарту (одна задача за раз, студия сама ставит в очередь и берёт замок GPU).
