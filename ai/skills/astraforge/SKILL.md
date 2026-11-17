---
name: astraforge
description: Локальная 3D-студия владельца AstraForge («Астрофорж», «кузница ассетов») — единый цех игровых ассетов для всех игр владельца («Врата Героев», Space Quest, «Душа»/SOULBOUND и любые следующие), ни одной игре не подчинён. Картинка или текст → 3D-модель (Pixal3D, Hunyuan3D) → ракурсы → риг (Mixamo-кости) → клипы (Quaternius CC0, Mixamo) → предметы в руках → спрайты и пакеты для Godot 4.5 и Unity 6 (URP); 2D по референсу (вкладка «2D»: ракурсы, части тела для 2D-рига, кадры анимации, эмоции, раскадровки, позы из 3D, перерисовка в стиле, FLUX.2/Qwen-Image/SDXL локально). Используй, когда просят сгенерировать или собрать 3D-модель, юнита, персонажа, существо, корабль, турель, оружие; сделать риг, анимации, спрайты для игры, ассеты для Godot; построить ракурсы (виды сзади/слева/справа) по одной картинке; нарисовать 2D-персонажа, 2D-спрайты, кадры 2D-анимации, части тела для cutout-рига, раскадровку, эмоции, перерисовать в другом стиле (пиксель-арт, аниме, рисованный); запустить, проверить или починить студию, Pixal3D, Hunyuan, MV-Adapter, Blender-конвейер «Кузница»; передать ассет в «Врата Героев», Space Quest, «Душу»/SOULBOUND или подключить к студии новую игру; а также «установи студию», «поставь AstraForge с нуля», «перенеси на другой компьютер». Триггеры - «3D-модель», «AstraForge», «Астрофорж», «кузница», «сгенерируй модель/юнита/корабль/персонажа», «риг», «анимации», «спрайты для игры», «ассеты для Godot», «ассеты для Unity», «префаб Unity», «Pixal3D», «Hunyuan», «ракурсы», «2D», «2D-спрайты», «раскадровка», «покадровая анимация», «пиксель-арт», «части тела», «по референсу», «установи студию», «перенеси на другой компьютер». Эффекты, частицы и VFX-текстуры — другой скилл astraforge-vfx.
---

# AstraForge — локальная 3D-студия владельца

Веб-студия на этом компьютере (Windows, RTX 4070 12 ГБ): **концепт (картинка/текст) → 3D → риг → клипы → предметы → эффекты → пакет Godot / спрайты**, и параллельно **2D по референсу** (вкладка «2D», `docs/art2d.md`). Всё локально и бесплатно:
React + three.js → Express `127.0.0.1:3210` → очередь → ComfyUI (Hunyuan3D, SDXL, MV-Adapter на :8190; Pixal3D на :8191) и Blender 5.0.1 без окна; проверка пакетов — настоящий Godot 4.5.1.
Приложение: `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge` (ниже **APP**; сам скилл лежит в `APP/ai/skills/astraforge`, в `~/.claude/skills` — ссылка-junction, см. `references/install.md` §8; git `master`, актуальный коммит — `git log -1`, приватный GitHub `Snodrod/AstraForge`, версия 0.3.0; сведения сверены с кодом и машиной 17.10.2026). Библиотека ассетов и клипов — `C:\AstraForge\library`.
Тексты и интерфейс — по-русски; вопросы владельцу — только по-русски и коротко.

**Эффекты, частицы, VFX-текстуры, флипбуки, вкладки «Эффекты» и «VFX» — скилл `astraforge-vfx`** (его не дублируем). Игровая 2D-графика по референсу (ракурсы, части тела, кадры анимации, раскадровки, стили) — **вкладка «2D» этой студии** (раздел ниже). Разовые картинки вне игр — `codex-image` или `local-image-generation`.

## Роль в играх: единый цех ассетов

Решение владельца (17.10.2026): **AstraForge отвечает за создание всех моделей и игровых элементов во всех играх** —
«Врата Героев», Space Quest, «Душа»/SOULBOUND и каждая следующая. Скилл не подчинён ни одной игре. Ответственность делится так:

| Кто | За что отвечает |
|---|---|
| **AstraForge (этот скилл)** | *как* делается ассет: концепт, ракурсы, 3D, риг, клипы, предметы, эффекты, рендер, пакет; выдача, которая **с первого раза проходит контракт игры** (профиль экспорта и параметры под её тесты) |
| **Игра** | только *что* принять — контракт (размеры кадра, оси, имена, бюджеты, формат реестра, тест реестра, лицензии) — и *как* файлы попадают в её репозиторий |
| **Роль игры** (`art` во «Вратах» и Space Quest) | перенос пакета в свою копию, тесты игры, отчёт, ревью — по правилам репозитория |

Своих 3D-конвейеров игры не заводят: чего-то не хватает игре — новый профиль, параметр или рецепт студии. Контракт
игры не подгоняем под студию, студию — под контракт. Новая игра подключается по `references/games.md` §0.

## Когда звать этот скилл

Любая работа с моделями/ассетами для игр владельца: «сделай модель/юнита/корабль», «зариг», «анимируй», «спрайты для Врат», «пакет для Godot», «ракурсы», «подключи новую игру к студии», «почему не стартует студия», «поставь/перенеси студию».
Не звать: разовые картинки не для игр, видео-монтаж, код и данные самих игр (боёвка, экраны, баланс — у них свои роли и правила, `references/games.md`).

## Шаг 0. Проверь состояние (только чтение, ~10 с)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\doron\.claude\skills\astraforge\scripts\af_status.ps1"   # [-App <папка>] [-NoVersions] [-Json]
```
Таблица «есть / нет / выключено / работает»: приложение, порты (3210, 8190, 8191, 3211, 11434; 8188 — чужой, только информация), Node/Blender/Godot, веса Hunyuan/Pixal3D/SDXL/MV-Adapter, Ollama и модели,
библиотека и клипы, VFX-программы. «Студия выключена» — нормальный результат, не ошибка. Скрипт ничего не запускает и не скачивает. Подробный снимок машины — `references/inventory.md`.

## Запуск и остановка

| Действие | Команда |
|---|---|
| Запустить (обычно это делает владелец) | `Start.cmd` в APP или `powershell -NoProfile -ExecutionPolicy Bypass -File "<APP>\scripts\Start.ps1" -NoBrowser`; адрес http://127.0.0.1:3210 (`/api/health` → `{"app":"AstraForge"}`) |
| Остановить | `Stop.cmd` (убивает только процессы студии; **ComfyUI :8188 владельца и Ollama остаются**) |
| Логи | `<APP>\data\runtime\server.log`, `server-error.log`, `comfy.log`, `pixal3d.log`; шаги Blender — `<runtime>\blender\<jobId>\<шаг>.log` |

Не запускай `node server/index.mjs` «для проверки»: он поднимает ComfyUI на видеокарте. Pixal3D стартует сам по первому заданию (холодный старт 1–2 мин). Порты по умолчанию 3210 (студия), 8190, 8191, 3211; `Start.ps1`/`Stop.ps1` рассчитаны именно на 3210.

## Карта студии

**Вкладки** (левая колонка, 10): *Создать* (концепт, **Ракурсы**, выбор движка Pixal3D/Hunyuan, «Создать 3D-модель» / «Создать 3D по ракурсам») · *Кузница* (мастер Подготовка→Скелет→Движения→Предметы→Эффекты→Экспорт,
«Задачи», «Пакет», «Приёмка») · *Кости* (старый браузерный риг) · *Текстуры* (UV, PBR, кисть, сравнение с референсом) · *Анимация* (ключи, вращение, WebM) · *Эффекты* и *VFX* (→ `astraforge-vfx`) ·
*Спрайты* (iso 8 направлений, «все клипы в GLB») · *AI* (помощник Ollama/OpenAI/Anthropic) · *Tripo* (облако, платно — без решения владельца не запускать).

**CLI** (из APP; нужен запущенный сервер, либо `--direct` — тогда пути только из переменных `ASTRA_*`, не из `config\paths.json`):
```
node scripts/forge.mjs status | steps | presets | assets | show <id> | jobs | job <id> [--wait] | cancel <id>
node scripts/forge.mjs create --kind humanoid|creature|item|ship|prop --name "Имя" (--from-glb f.glb | --from-job <jobId> | --from-asset <id> | --params '{}') [--preset <id> | --steps steps.json]
node scripts/forge.mjs run <assetId> (--steps steps.json | --preset <id>) [--from source|latest|v003]
node scripts/forge.mjs export <assetId> --profile godot|space_quest|heroes_gates|iso8|unity|unreal|bevy|vrm1 [--out <папка>] [--to-unity <проект Unity> [--build]]
node scripts/forge.mjs batch items.json | clips list | clips import <папка FBX> | clips remove <id>
node scripts/views/views_generate.mjs --input front.png --out <папка> --provider codex|mvadapter     # ракурсы
node scripts/views/views_3d.mjs --views <папка> --out mesh.glb --engine pixal3d|hunyuan|auto [--seed N]  # 3D по видам
node scripts/forge-concepts.mjs --dir <папка концептов> --profile heroes_gates [--dry]               # пачка «концепты → юниты Врат»
```
**Конвейер Кузницы — 35 шагов Blender** (`forge.mjs steps`): работа с сеткой — `inspect cleanup convert separate replace_part place_parts sculpt face_match face_fix_loop extract_props assemble_parts kitbash`; риг, движение и цвет — `rig_humanoid prepare_mixamo import_mixamo_rig retarget motion_style rig_creature anim_creature cloth_sim clip_library paint_from_concept`; генераторы и листы — `item_kit item_from_mesh attach_prop bone_kit ship_gen turret_gen ship_from_mesh render_sprites`; экспорт — `godot_package unity_package unreal_package bevy_package vrm_package`; 11 готовых пресетов. Каждый запуск = новая версия `v00N` паспорта ассета (не перезаписывается), результат шага — `outputs` + `checks`.
Список шагов с назначением, API, паспорта, раскладка данных — `references/studio.md`.

**Профили экспорта:** `godot` (папка `<id>/` с GLB, `.tscn`, FX) · `space_quest` (+ запись `models.json`; `fit_units`/`min_units` задавать в единицах рендера, игра берёт только GLB — `games.md` §3) · `heroes_gates` (листы спрайтов + запись `data/sprites.json`) · `iso8` (8 направлений) · `unity` (FBX + текстуры + `af_unity.json`; импортёр `com.astraforge.unity` сам собирает префаб, проверка в Unity без окна — `references/unity.md`) · `unreal` (FBX + текстуры + `af_unreal.json` для плагина-импортёра UE5 — `docs/product/unreal.md`) · `bevy` (тот же GLB, что у godot, + паспорт `af_bevy.json`; с Rust на машине — headless-проверка в Bevy с кадром превью — `docs/forge/bevy.md`) · `vrm1` (персонаж одним `.vrm` — VRM 1.0 через VRM-аддон; шаг `vrm_package`, пресет `humanoid_vrm`; **что у нас проверено, а что пока нет — таблица в `docs/forge/vrm_package.md`**, маркетинг движков не обещаем). `.vrm` принимается и **на вход** (обязательна декларация VRMC в контейнере; конвейер читает его как glb — тестировано). Студия сама **не пишет** в чужие проекты (`--to-unity` — только по просьбе владельца).

## 2D по референсу (вкладка «2D», `docs/art2d.md`)

Локально на ComfyUI студии :8190: **FLUX.2 klein 9B** (рисует по 1–4 референсам; лицензия **некоммерческая** — говорить владельцу), **Qwen-Image** (Apache-2.0, только по тексту), **SDXL** (черновики, img2img).
GGUF-веса требуют узла `ComfyUI-GGUF` в белом списке (`server/runtime.mjs`) — после обновления студию перезапустить, иначе `art2d.mjs status` покажет «нет узлов UnetLoaderGGUF».
Рецепты: `concept turnaround parts animation expressions storyboard poses3d restyle`; 11 стилей (пиксельные — с настоящей пикселизацией); образец стиля картинкой; листы `default`/`heroes_gates` (320, якорь 160,272)/`hd`; экспорт Godot: `SpriteFrames .tres` или `character_cutout.tscn`.
```
node scripts/art2d/art2d.mjs status | styles | recipes | list
node scripts/art2d/art2d.mjs make --recipe animation --action walk --character hero.png --style pixel --sheet heroes_gates --godot
node scripts/art2d/art2d.mjs make --recipe poses3d --character hero.png --poses <кадры 3D-клипа> --style cel   # самый ровный путь к анимации
node scripts/art2d/art2d.mjs redo <id> <кадр> --new-seed | resume <id> | godot <id>
```
Наборы — `APP\data\art2d\<id>\` (`set.json` с промптами, seed и временем каждого кадра). Кадр 2D можно отправить в «Создать» как концепт для 3D. Ограничения и план (4B Apache-2.0, ControlNet-позы, Skeleton2D) — `docs/art2d.md`.

## Типовой путь «картинка → юнит в игре»

1. Концепт: PNG 3:4, персонаж во весь рост, **T-поза, без оружия в руках**, светлый фон (`codex-image` или SDXL в студии).
2. «Ракурсы»: из вида спереди сделать слева/сзади/справа (ChatGPT — чистовик, MV-Adapter — черновик без сети).
3. 3D по четырём видам в **Pixal3D** (≈ 4 мин, ≈ 10 ГБ VRAM; только форма) → GLB.
4. Кузница: `cleanup → paint_from_concept → rig_humanoid → retarget (Quaternius/Mixamo) → motion_style → render_sprites / godot_package`. После `cleanup` **смотреть превью** (рваные сетки Pixal3D требуют `voxel_remesh_m: 0.004`, целые — нет).
5. Ворота: красные `checks` останавливают шаг; осанка клипов (`posture.py`) и превью — до рендера; Godot 4.5.1 headless; вкладка «Приёмка».
6. Экспорт профилем игры **с параметрами её контракта** (для «Врат» — `--params` из `games.md` §2: ячейка 320, якорь 160,272; для Space Quest — §3: `fit_units`/`min_units` в единицах рендера, `sq_type`) → передача **ролью игры** по её правилам (`references/games.md`).
Подробный рецепт, команды и примеры `steps.json` — `references/studio.md` и `references/games.md`.

## Куда читать дальше (по задаче)

| Задача | Файл |
|---|---|
| **Перед сдачей любого ассета**: брак, который находил владелец (покраска, лишние глаза, кроны, скелеты, прыжки, мост), и обязательные листы приёмки | `references/quality-lessons.md` |
| **Перед любым заданием Кузницы** — рецепт и грабли класса ассета (что принимали и что браковали); **после** — вердикт в журнал; периодически — сводка | `references/recipes.md` (генерируется) и скилл **`astraforge-learn`** |
| Поставить с нуля / на другой ПК, ключи мастера, `paths.json`, переменные `ASTRA_*`, перенос библиотеки, проверка после установки | `references/install.md` |
| Что именно и откуда скачивается (URL, версии, размеры, sha256, лицензии, порты, кто использует) | `references/components.md` |
| Что реально стоит на этой машине сейчас (версии, пути, веса, модели Ollama, содержимое `C:\AstraForge`) | `references/inventory.md` |
| Устройство, вкладки, все шаги, CLI, API, паспорт, версии, библиотека, `data\` | `references/studio.md` |
| Роль студии в играх и подключение новой игры (§0), профили экспорта, контракты и передача в «Врата Героев» / Space Quest / «Душу», ворота качества | `references/games.md` |
| Экспорт в **Unity**: профиль `unity`, импортёр `com.astraforge.unity` (URP/Built-in/HDRP, Humanoid/Generic, LOD, сокеты, Particle System, ветер, спрайты 8 направлений), проверка в Unity без окна, отправка в проект, MCP `unity_*` | `references/unity.md` |
| Ошибки, грабли Windows/Git Bash/PowerShell, Pixal3D, риг, осанка, Godot; расхождения документации и реальности | `references/troubleshooting.md` |
| 2D: движки, рецепты, стили, листы, экспорт Godot, ограничения, план развития | `APP/docs/art2d.md` |
| Эффекты, частицы, VFX-текстуры, флипбуки, генераторы Simon Schreibt | скилл **`astraforge-vfx`** |
| Ассет в игру целиком: проект Unity / Godot в фоне, отправка, логика под ассет (управление персонажем), тесты без окон, MCP `UnityMCP` и `godot` | скилл **`astraforge-integrator`** (агент `astraforge-integrator`) |
| Первоисточники в APP | `README.md`, `ARCHITECTURE.md`, `docs/forge/GUIDE.md` (руководство), `docs/FORGE-CONTRACT.md` (контракт), `docs/forge/API.md`, `docs/forge/pixal3d.md`, `views.md`, `export.md`, `THIRD_PARTY_NOTICES.md` |
| История и решения | Obsidian `C:\Dorn\DopsMedia\00 Dops Media\Проекты\astraforge-кузница.md`, `astraforge-vfx.md`; память Claude `astraforge-*.md`, `pixal3d-engine.md`, `unit-posture-gate.md` |

## Из Claude Code: MCP, панель, Pixel Art (27.10.2026)

- **MCP-сервер `astraforge`** (`ai/mcp/server.mjs`, зарегистрирован в Claude Code в пользовательском scope): 66 инструментов —
  `studio_status/start/open`, `asset_*`, `generate_3d`, `jobs_*`, `views_*`, `forge_*` (steps, presets, create, run, export, batch,
  clips; самообучение — feedback, recipes, journal, plan, recipe_pin, learn_note), `sprites_render` (профили iso8|heroes_gates|custom|pixel), `fx_presets`, `fx_texture_generate`, `projects_*`, `vfx_*`,
  `sound_*` (status, generate sfx|loop, list, bind, export — вкладка «Звук», локальные MOSS-SoundEffect и ACE-Step);
  ресурсы `astraforge://status`, `astraforge://skill`. Предпочитай их вместо curl к `/api`. Список и регистрация — `ai/mcp/README.md`.
- **Панель в окне Claude Code** (`ai/claude-plugin`, мод по `plugin-authoring`): состояние студии, движки, очередь заданий с отменой,
  кнопки «Запустить студию / Движок / Pixal3D», команда `/astraforge [open|start|status]`. Живой 3D-вид — только встроенный браузер
  приложения (`preview_start` с `http://127.0.0.1:3210`): панель-мод не умеет WebGL/iframe. На новой машине мод копируется в
  `~/.claude/dev-mods/<session>/astraforge` или подключается `--plugin-dir`.
- **Pixel Art** (`docs/forge/pixel.md`): профиль `render_sprites profile=pixel` (палитра, дизеринг, контур; детерминированно);
  `scripts/pixel/pixel_gen.mjs` — сцены и предметы по тексту через ComfyUI 8188 владельца (SDXL + LoRA pixel-art-xl, лицензия
  CreativeML OpenRAIL-M, промпт по-английски); `scripts/pixel/pixelize.py` — любая картинка → пиксель-арт; Pixelorama (MIT) во вкладке «VFX».

- **Скульптинг** (28.10.2026): руками — вкладка «Скульпт» (SculptGL, MIT, со своего порта 3211; «Открыть в скульпте» →
  кисти → «Вернуть в сцену»; форма ложится на исходные вершины, UV и риг сохраняются, пока число вершин не менялось;
  `docs/forge/sculpt.md`). Из контекста — шаг Кузницы `sculpt` и MCP-инструменты `sculpt` / `sculpt_transfer`: операции smooth,
  relax, inflate/deflate, flatten, pinch/expand, grab, remesh, subdivide, decimate, symmetrize, transfer; области all/sphere/box/
  vertex_group/bone с затуханием и симметрией X; координаты мировые, как в `inspect` (`docs/forge/sculpt-steps.md`). Скульпт из
  SculptGL с другой топологией (dyntopo, ремеш) возвращай на ригованную модель через `sculpt_transfer`.

## Самообучение (31.10.2026)

Каждый шаг Кузницы пишет строку в журнал производства (`C:\AstraForge\library\learning\journal.jsonl`: класс ассета,
параметры, проверки, превью, время); вердикты («Приёмка» → «Журнал и рецепты», MCP `forge_feedback`, CLI `learn feedback`)
студия сводит в **рецепт класса** — лучшие параметры шагов — и **грабли**. Новый ассет класса стартует с рецепта: он
заполняет параметры, которых нет в шагах (явные главнее; `--no-recipes` отключает). Цикл агента — скилл
**`astraforge-learn`**: перед заданием `forge_recipes`, после — сверка с концептом и `forge_feedback`, периодически
`learn digest` → `references/recipes.md`. Устройство — `docs/forge/LEARN.md`.

## Правила (нарушать нельзя)

1. **Загрузки — только с согласия владельца.** Перед любой установкой/скачиванием покажи список, размеры и лицензии (`components.md`) и дождись «да». Мастер установки не прогоняй целиком «для проверки»:
   только `-ScanOnly` / `-DryRun` (полный прогон переписывает ярлык рабочего стола и запускает студию).
2. **Не трогай** ComfyUI на 8188 (`D:\ComfyUI` — пользовательский) и Ollama; `data\` студии; `data\vault.json` (ключи DPAPI, секрет); чужие рабочие копии игр. Не публикуй ключи и токены.
3. **Видеокарта одна** (12 ГБ): генерации, рендер Blender на GPU и пайплайн «Врат» идут по очереди через замок `Global\HG_GPU_RENDER`; Pixal3D и Hunyuan одновременно не работают. Не запускай тяжёлое без нужды.
4. **Godot — только 4.5.1** (`C:\Dorn\Game Dev\Godot_v4.5.1-stable_win64_console.exe`), не 4.7. Пути короткие (≤ 260 символов): библиотека `C:\AstraForge\library` не переезжает (пути в паспортах абсолютные).
5. **Платное и ручное:** Tripo/Meshy — только по решению владельца; клипы Mixamo скачивает владелец; ChatGPT-ракурсы отправляют картинку в OpenAI (скажи об этом).
6. **Игры:** сервер и CLI студии в репозитории игр не пишут. В репозиторий игры с правилами агентов (`heroes-gates*`, `space_quest*`) файлы кладёт агент **в копии её роли `art`** по этому скиллу и по правилам игры (ветка `agent/art`, `run-tests.ps1`, отчёт `reports/art/`; лицензии — `assets/LICENSES.md` во «Вратах», манифест и `THIRD_PARTY_NOTICES.md` в Space Quest); хуки не обходить. В `dusha` и других репозиториях без правил агентов — только с ведома владельца.
7. **Честность:** подгонка силуэта и проекция фото — не «точная копия» и не PBR; «ok» в статусе шага не заменяет просмотр превью; нейросетевая геометрия мягкая.
8. **Среда Claude:** в Git Bash вместо `python` — `py`; `git -C`/`git -c` запрещены — работай через `cd`; все `.ps1`/`.cs` — UTF-8 с BOM; `curl`/`tar` — из System32; из Git Bash не запускай `Setup.exe /extract`.
9. Для Hunyuan3D лицензия Tencent запрещает использование в ЕС, Великобритании и Южной Корее; nvdiffrast/nvdiffrec_render (в окружении Pixal3D) некоммерческие — студия их не вызывает, текстурирование Trellis2 не использовать.
10. Закончил кусок — коротко отчитайся по-русски: что сделано, чем проверено (цифры), что осталось; полезные находки допиши в Obsidian `astraforge-кузница.md` (раздел «Что сделано»).
