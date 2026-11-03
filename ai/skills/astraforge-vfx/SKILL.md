---
name: astraforge-vfx
description: Визуальные эффекты в AstraForge — частицы на модели (огонь, дым, искры, аура, шлейф двигателя, магия, ударная волна), генерация VFX-текстур и флипбуков прямо в студии, генераторы из базы Simon Schreibt «Textures for VFX» (Material Maker, PixaFlux, KumoWorks, Slate и др.), экспорт эффектов в Godot 4.5. Используй, когда просят сделать, добавить, поправить или выгрузить эффект для модели, юнита или корабля; сгенерировать текстуру для эффекта, шум, флипбук; скачать или добавить генераторы текстур (в том числе из базы Notion); доработать вкладки «VFX» или «Эффекты» AstraForge. Триггеры: «эффект», «VFX», «частицы», «партиклы», «текстура для эффекта», «флипбук», «шлейф», «аура», «вкладка Эффекты», «генераторы текстур», «Textures for VFX», «Simon Schreibt».
---

# AstraForge: VFX-текстуры и эффекты на модели

AstraForge — локальная 3D-студия владельца (React + three.js + Express :3210). В ней две вкладки для эффектов:
**«Эффекты»** — эмиттеры частиц на модели с живым предпросмотром, генератором текстур и экспортом в Godot;
**«VFX»** — каталог 31 внешнего генератора текстур с запуском. Формат эффектов один со «Кузницей»:
`astraforge-fx/1`. История и решения — Obsidian `00 Dops Media/Проекты/astraforge-vfx.md`.

## Где что лежит

| Что | Где |
|---|---|
| Студия, git | `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge` (дальше APP) → приватный GitHub `Snodrod/AstraForge`, ветка `master` |
| Запуск / остановка | `APP\Start.cmd` / `Stop.cmd` → http://127.0.0.1:3210 |
| Описание для людей | `APP\docs\vfx-tools.md` |
| Внешние генераторы | `C:\AstraForge\tools\vfx` (`ASTRA_VFX_TOOLS`): `apps\`, `downloads\` (установщики), `web\`, `textures\` (готовые PNG, видны в обеих вкладках), `_catalog\` (выгрузка базы) |
| Каталог генераторов | `APP\server\vfx-tools-catalog.json` |
| Вкладка «VFX» | `server\vfx-tools.mjs` (API `/api/vfx-tools`, веб-генераторы на отдельном порту 3211), `src\VfxPanel.jsx` |
| Эффекты: ядро | `src\fx-core.js` — пресеты, нормализация, аналитические частицы, встроенные текстуры, `.tscn`, ZIP (`buildFxPackage`), `fxAutoPlacement` |
| Эффекты: отрисовка и сцена | `src\fx-runtime.js` (патч прототипа `StudioScene`: `addFx`, `updateFx`, `fxList`, `triggerFx`, `fxAutoPlace`), `src\FxPanel.jsx` |
| Генератор текстур | `src\fx-textures.js` (+ `fx-textures.worker.js`), `src\FxTextureLab.jsx` |
| Пресеты (источник) | `APP\scripts\blender\data\fx_presets.json`; копия для браузера `src\fx-data.js` |
| Эталон Godot | `APP\scripts\blender\steps\_export_lib.py`: `make_fx_texture`, `fx_scene_text`; монтаж — `scripts\blender\godot\af_fx_mount.gd` |
| Установка генераторов | `APP\scripts\vfx\Install-VfxTools.ps1` (`-DryRun`, `-Only a,b`); в мастере установки — пункт `vfx` |
| Скрипты этого скилла | `scripts\notion_db_export.py`, `scripts\check_server.mjs`, `scripts\godot-check\` |

## Сценарий 1. Сделать эффект для модели (работа в студии)

1. Студию запускает владелец (`Start.cmd`); сам не запускай `server/index.mjs` без нужды — он поднимает ComfyUI на видеокарте.
2. Выбрать деталь или кость → вкладка «Эффекты» → пресет (12 пресетов «Кузницы» + «Пустой»). Эффект встаёт под деталью,
   сам масштабируется по модели; двигательные (`engine_trail`, `thruster_glow`) — на заднюю грань детали, выхлопом назад.
3. Править параметры (испускание, форма, движение, вид, текстура, флипбук, свет), двигать маркер гизмо W/E/R.
4. Текстура: встроенная (soft, spark, star, smoke, ring), «Из папки VFX», «С диска» или «Создать текстуру в генераторе»
   (10 типов, 20 рецептов, флипбуки 2×2/4×4/8×8) → «Использовать в эффекте».
5. Сохранить проект; «ZIP для Godot 4.5» → `fx/*.tscn`, `fx/textures/`, `fx_bindings.json`, `af_fx_mount.gd`, README.

Подбирая параметры за пользователя, держись полей `_fields` из `fx_presets.json`: в Godot уходят только они.

## Сценарий 2. Добавить или обновить генераторы из базы Notion

1. Выгрузить базу: `py -3 -I scripts/notion_db_export.py <url страницы notion.site> <папка> --filter Type=generator`
   (без авторизации, через `loadCachedPageChunkV2` → `queryCollection`; spaceId берётся из блока страницы). База Simon Schreibt:
   `https://simonschreibt.notion.site/Textures-for-VFX-Database-2c72eccccfa84a0eae927d778ad746cc`, 264 записи, 31 генератор (на 16.10).
2. По каждой ссылке определить вид: `desktop` (портативный exe), `installer`, `web-local` (open source сайт, кладём к себе),
   `file`, `web-online`, `store` (бесплатно, но через заказ с e-mail), `paid`, `guide`. Лицензию проверять (GitHub API `license.spdx_id`).
3. **Перед скачиванием** показать владельцу список: файл, источник, размер — и дождаться «да». Качать только с официальных сайтов.
   Установщики не запускать: их запускает владелец кнопкой «Установить». Заказы с e-mail (Gumroad $0, магазины) — делает владелец.
4. Добавить запись в `vfx-tools-catalog.json` (поля: `id, name, author, kind, license, url, tags, ru, local, download`) и проверить
   `Install-VfxTools.ps1 -DryRun`, затем `-Only <id>` на временной папке (`-Root`).
5. itch.io «назови свою цену»: в браузере «Download Now» → «No thanks, just take me to the downloads», затем со страницы
   `POST /<игра>/file/<upload_id>?source=game_download&after_download_lightbox=1&as_props=1` (тело `csrf_token`) — в ответе `url`,
   живёт 60 с, сразу `curl`. Положить zip в `downloads` и `Install-VfxTools.ps1 -Only <id>`.

## Сценарий 3. Доработать код вкладок

- Сначала прочитать нужные файлы из таблицы; стиль кода — плотный однострочный JSX/JS, интерфейс по-русски.
- Пресеты менять в `scripts/blender/data/fx_presets.json`, затем синхронизировать копию: `FX_SYNC=1 node --test tests/fx-core.test.mjs`
  (Vite не отдаёт `scripts/**` браузеру — поэтому копия).
- `.tscn` должен оставаться побайтно равным `fx_scene_text` из `_export_lib.py` — тест это сверяет; меняешь одно — меняй оба.
- Проверка без ComfyUI: `npm run build`, затем `node scripts/check_server.mjs` из папки скилла (`ASTRA_APP` — путь студии,
  `CHECK_PORT` — порт, по умолчанию 3299; PID в `%TEMP%\astraforge-check.pid`) → открыть http://127.0.0.1:3299 во встроенном браузере.
  В нём настоящие `/api/vfx-tools` и `/api/assets`: кнопки «Запустить»/«Установить» реально запускают программы — не нажимать без просьбы.
- Проверка Godot: `node scripts/godot-check/gen.mjs <папка>` → `godot --headless --path <папка> --import` →
  `godot --headless --path <папка> --script check.gd` → строка `FXCHECK {...}` с `"errors":[]`, код выхода 0.
  Godot: `C:\Dorn\Game Dev\Godot_v4.5.1-stable_win64_console.exe` (только 4.5.1).
- Тесты: `npm test` в APP (на 17.10 — 298 из 298). Большие правки отдавать субагентам с жёстким разделением файлов.

## Правила и подводные камни

- **Изоляция веб-генераторов.** Чужие страницы отдаются только сервером на 127.0.0.1:3211 (`ASTRA_VFX_WEB_PORT`), никогда с
  origin студии: иначе их JS получит API студии вплоть до запуска программ.
- **Метрические пресеты.** Без `fxAutoPlacement` эффект на модели студии почти невидим; масштаб эмиттера = размер частиц.
- **Эмиттер** — `Object3D` в `content` с чистым JSON в `userData.fx`; частицы, маркер и свет — в оверлее вне `content`
  (не попадают в GLB и `toJSON`).
- **Лицензии.** Внешние программы в сборку не входят. Neon Flames без лицензии — только личное использование.
  Fateloom и ссылки Flipped Normals на 16.10 мертвы.
- **PowerShell-скрипты** студии — UTF-8 с BOM; curl и tar брать из System32; в Git Bash вместо `python` — `py`.
- **Git.** Папку создал пользователь песочницы Codex; путь добавлен в глобальный `safe.directory`. `git -c ...` и `git -C ...`
  в этой среде запрещены правилами — работать через `cd`. Коммит после зелёного `npm test`, пуш в `origin master`
  только с согласия владельца.
- Все вопросы и отчёты владельцу — по-русски, коротко; после работы дописать изменения в Obsidian
  (`00 Dops Media/Проекты/astraforge-vfx.md`, раздел «Что сделано»).
