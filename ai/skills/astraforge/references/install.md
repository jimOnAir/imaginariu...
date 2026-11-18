# AstraForge: установка с нуля на новом Windows-ПК

Все факты — из `installer\Install.ps1`, `installer\pixal3d\pixal3d.ps1`, `installer\mvadapter\mvadapter.ps1`, `scripts\Start.ps1`, `README.md`, `installer\setup\Setup.cs`.
APP = папка приложения. На машине владельца это `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge` (там уже всё стоит, см. `inventory.md`);
на новом ПК ставьте в короткий путь `C:\AstraForge`. Список компонентов с URL — `components.md`.

## 0. Требования

| Что | Значение |
|---|---|
| ОС | Windows 10/11 x64. Права администратора **не нужны** (по `README.md` и шапке `Install.ps1`; Ollama ставится в профиль пользователя `%LOCALAPPDATA%\Programs\Ollama`) |
| Видеокарта | NVIDIA для 3D по картинке: Hunyuan3D — от 8 ГБ (лучше 12); MV-Adapter — от 8 ГБ (на 8 ГБ только 512 px), комфортно 10+; **Pixal3D — RTX 30/40/50 (compute_cap ≥ 8.0), от 8 ГБ с предупреждением, лучше 10+** (пик ≈ 9,5–10,8 ГБ при 4 видах); меньше 8 ГБ Pixal3D/MV-Adapter мастер не предлагает. Без NVIDIA интерфейс и Blender работают, ставится CPU-PyTorch. Эталон владельца: RTX 4070 12 ГБ (драйвер 616.92, compute 8.9), i9-13900KF, 63,7 ГБ ОЗУ, Windows 11 Home 10.0.26200 |
| ОЗУ | требований в файлах установщика нет (мастер её не проверяет); эталон 64 ГБ; Qwen 27B частично выгружается в ОЗУ |
| Диск | базово 20–40 ГБ, с Pixal3D ещё ≈ 46–52 ГБ (на диске установки Pixal3D нужен запас: оценка + 3,3 ГБ). Мастер сам считает потребность по каждому диску и отказывается при нехватке |
| Путь | **короткий, латиницей**. Blender/Godot ломаются на путях > 260 символов; Setup.exe требует папку ≤ 60 символов; мастер предупреждает, если путь Pixal3D длиннее 90 |
| Сеть | нужна для загрузок (≈ 25 ГБ базово; ≈ 42 ГБ Pixal3D). Прерванная загрузка докачивается повторным запуском |
| Инструменты | `curl.exe` и `tar.exe` из `System32` (есть в Windows 10/11; **не** из Git/MSYS), Windows PowerShell 5.1 |

## 1. Получить код (три способа)

**А. Репозиторий (приватный) `Snodrod/AstraForge`, ветка `master`** (актуальный коммит — `git log -1`; 17.10.2026 — `a7d5cfc`). Нужен доступ владельца:
```powershell
gh auth login                                   # аккаунт с доступом к репозиторию
gh repo clone Snodrod/AstraForge C:\AstraForge  # PowerShell; путь короткий
```
Папка с `.git`, созданная другим пользователем Windows, даёт «dubious ownership» → `git config --global --add safe.directory C:/AstraForge`
(на машине владельца так сделано для папки Codex-песочницы). В клоне нет `node_modules`, `dist`, `config`, `runtime`, моделей и библиотеки — всё это ставит мастер.

**Б. Всем — один файл `AstraForge-Setup-<версия>.exe`** (бесплатно, MIT). С версии 0.4 (28.10.2026) установка **автономная**:
окно Setup → лицензия → папка → (с 0.4.8) распаковка и проверка компьютера `Install.ps1 -ScanList` → шаг «Что установить»: список программ и моделей с тем, что найдено (версия, путь) — «есть», «обновить» (старая версия ComfyUI, файл модели другого размера, нет загрузчика GGUF), «нет — скачать», «недоступно» (причина); кнопки «Быстрая / Полная — всё / Облегчённая» ставят галочки (по умолчанию «Полная», без NVIDIA «Облегчённая»), Node.js, интерфейс и Blender не снять, зависимости отмечаются сами; ставится ровно отмеченное: `-Auto -Only <ids>` (`-Only none` — ничего), всё в папку программы; проверка окна без загрузок — `ASTRA_SETUP_DRYRUN=1`. Папка (по умолчанию `C:\AstraForge`, если занята чужим — `C:\AstraForgeStudio`; путь ≤ 60 символов) → состав
«Быстрая» (≈ 30 ГБ) или «Полная» (≈ 95 ГБ); без видеокарты NVIDIA (с 0.4.7) окно до загрузки предупреждает, что 3D по картинке и SDXL
не заработают, и по умолчанию выбирает «Облегчённую» (≈ 3 ГБ, профиль `lite`), за «Быструю»/«Полную» переспрашивает → «Установить» → один общий прогресс «Подготовка студии… N%» с названием текущего шага →
«Запустить AstraForge». Вопросов больше нет. Кнопка «Лицензии…» показывает `THIRD_PARTY_NOTICES.md` и `LICENSE` из архива до установки.
Сборка: `powershell -ExecutionPolicy Bypass -File installer\build-release.ps1 [-Out <папка>]` → по умолчанию `..\AstraForge-release\` (exe + `.sha256`;
внутри приложение, `dist`, `node_modules` без dev-пакетов; собирает системный `csc.exe` из `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`; нужен
собранный `dist`). С 0.4 сборка **по белому списку**: из `data\` едут только узлы ComfyUI, `.claude`/`.codex` исключены, а если в архив попадут личные
данные — сборка падает (до 0.4 в exe по ошибке попадали `data\views` и рабочие копии `.claude`, exe весил 481 МБ вместо 47 МБ).
Тестовая сборка 0.4.0: `C:\AFrel-test\AstraForge-Setup-0.4.0.exe`, 46,9 МБ, 6901 файл, 115 МБ после распаковки.
Файл не подписан: Windows покажет «Система Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае».
Проверка сборки без окна (**из PowerShell, не из Git Bash** — `/extract` там превращается в путь и открывается окно):
`Start-Process .\AstraForge-Setup-0.4.0.exe -ArgumentList '/extract','C:\afx' -Wait`.

**В. Копия папки с другого ПК**: без `data\models`, `data\vault.json` (ключи DPAPI привязаны к пользователю Windows), `config\paths.json`, `data\runtime\node.pid`; затем мастер.

## 2. Мастер установки

Запуск: двойной клик по **`Установить AstraForge.cmd`** в корне APP (он вызывает `powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer\Install.ps1 %*` и ждёт клавишу)
или напрямую из PowerShell:
```powershell
cd C:\AstraForge
powershell -NoProfile -ExecutionPolicy Bypass -File installer\Install.ps1 -ScanOnly
```
Журнал — `installer\install.log`; скачанное — `installer\downloads\` (повторно не качается; можно удалить после установки).
Мастер **интерактивный** (`Read-Host`), вопросы по-русски: «Д/н». Setup.exe запускает его в **автономном режиме** (ниже).

### Автономный режим (с 0.4): `-Auto -Profile quick|full|lite`
- Ни одного вопроса. Состав — профиль из `installer\manifest.json` → `profiles` (`quick`: node, npm, blender, comfy, hy2, u2net, hymv, sdxl, mvadapter, godot, clips;
  `full`: ещё hy21, ollama, llm, vlm, vfx, pixal3d, pixal3dw, flux2, qwenimg (движки вкладки «2D», с 0.4.7: GGUF-веса в
  `data\models\unet|text_encoders|vae` + узел ComfyUI-GGUF в `data\runtime\custom_nodes`; до 0.4.7 не ставились — FLUX.2 и Qwen-Image были серыми); `lite` (с 0.4.7, ПК без NVIDIA): node, npm, blender, godot, clips, vfx — без ComfyUI
  и моделей формы/картинок). Обязательное ставится всегда (в `lite` ComfyUI, hy2, u2net не обязательны); уже стоящее находится и пропускается.
- Без NVIDIA мастер до плана печатает блок «Нет видеокарты NVIDIA» с названиями адаптеров из реестра; в окне `Установить AstraForge.cmd` спрашивает
  «Поставить облегчённый набор?» (по умолчанию да). `config\paths.json` → `profile: lite`, докачка после обновлений идёт тем же профилем.
  Проверка ветки на ПК с NVIDIA: `ASTRA_INSTALL_NO_GPU=1` (мастер, вместе с `-DryRun`) и `ASTRA_SETUP_NO_NVIDIA=1` (окно Setup.exe).
- Все адреса, размеры и sha256 загрузок — **`installer\manifest.json`** (веса Hunyuan3D, SDXL, u2net сверяются по sha256 с 28.10.2026; Pixal3D и MV-Adapter — свои манифесты рядом).
- В stdout строки `##PROGRESS <0-100>|<шаг>`, в конце `##DONE` или `##FAILED <id,id>` (код 1). Setup.exe переводит их в общий прогресс 5–100 % (первые 5 % — распаковка).
  Сбой компонента не останавливает остальные; повтор — «Установить AstraForge.cmd» или `-Only <id>`.
- **Проверка в чистой папке на занятом ПК** (28.10.2026): `ASTRA_INSTALL_ISOLATED=1` — уже стоящее ищется только в папке приложения и по явным `ASTRA_BLENDER`,
  `ASTRA_COMFY_DIR`, `ASTRA_GODOT`, `ASTRA_PIXAL3D_DIR`; ярлык на рабочем столе не создаётся. `ASTRA_INSTALL_MANIFEST=<файл>` подменяет манифест (малые файлы
  с локального `python -m http.server` вместо весов). **Осторожно:** с `ASTRA_COMFY_DIR=D:\ComfyUI` шаг `comfydeps` доставляет пакеты в `.venv` владельца
  (28.10 так добавился `xatlas 0.0.11`, остальное не менялось).
- nvdiffrast/nvdiffrec_render (некоммерческая лицензия NVIDIA) с 0.4 **не ставятся**; `patch_trellis2.py --site-packages` делает их импорт необязательным в узлах
  Trellis2 и в колёсах `o_voxel`, `utils3d`. Проверено 28.10: пакет узлов с закрытыми nvdiffrast/meshlib грузится, все 15 узлов формы на месте (80 узлов всего).
  Neon Flames (без лицензии) `Install-VfxTools.ps1` больше не скачивает.

### Ключи
| Ключ | Что делает |
|---|---|
| `-ScanOnly` | только показать, что есть и чего нет (GPU, Node, npm, Blender, ComfyUI, веса, Godot, Ollama и модели, клипы, MV-Adapter, Pixal3D); ничего не меняет, выход 0 |
| `-DryRun` | пройти мастер (вопросы задаются), показать план и итог по дискам, **ничего не скачивать и не менять** |
| `-Yes` | без вопросов: берутся **ответы по умолчанию** (см. таблицу ниже). Дополнительные компоненты с ответом «н» по умолчанию (`hy21`, `sdxl`, `vfx`, `pixal3d`) так **не поставятся** — их нужно называть через `-Only` |
| `-Only a,b,c` | поставить заново только эти компоненты, вопросы не задаются; **перечисляйте в порядке установки** (иначе, например, `clips` не найдёт Blender, а `mvadapter` — SDXL) |

Полный список id для `-Only` (в `README.md` нет `vfx` — он есть в `Install.ps1`):
`node, npm, blender, comfy, comfydeps, hy2, hymv, hy21, sdxl, u2net, godot, clips, ollama, llm, vlm, mvadapter, pixal3d, pixal3dw, pixal3dtest, vfx`.

| id | Что делает | Зависит от |
|---|---|---|
| `node` | Node.js v22.23.3 в `runtime\node`, пишет `node` в paths.json | — |
| `npm` | `npm ci` + `npm run build` в APP | `node` |
| `blender` | Blender 5.0.1 в `runtime\blender`, пишет `blender` | — |
| `comfy` | ComfyUI v0.33.2 в `runtime\ComfyUI`, `uv`, Python 3.12, PyTorch, библиотеки; пишет `comfyDir` | — |
| `comfydeps` | только недостающие Python-библиотеки у уже стоящей ComfyUI | готовая ComfyUI |
| `hy2` / `hymv` / `hy21` / `sdxl` | веса в `data\models\checkpoints\` (4,9 / 4,9 / 7,4 / 6,9 ГБ) | — |
| `u2net` | `data\models\background\models\u2net\u2net.onnx` | — |
| `godot` | Godot 4.5.1 в `runtime\godot`, пишет `godot` | — |
| `clips` | 86 клипов Quaternius/ActionForge: загрузка, перевод в FBX и импорт в библиотеку | **Blender** |
| `ollama` | `OllamaSetup.exe` тихо; пишет `ollama` | — |
| `llm` | `ollama pull qwen3:4b` (или 8b, 14b) по видеопамяти + запись `provider/ollamaModel/ollamaUrl` в `data\config.json` | `ollama` |
| `vlm` | `ollama pull qwen3-vl:8b` (в `config.json` ничего не пишет) | `ollama` |
| `mvadapter` | узел MV-Adapter + правки, пакеты Python в `.venv` ComfyUI, веса 3,6 ГБ, `sdxl-config`; перезапуск студии после | `comfy`, `sdxl` |
| `pixal3d` | движок Pixal3D (Python embed, ComfyUI 0.39.0, узлы Trellis2, PyTorch 2.8.0+cu128, FlashAttention, колёса, utils3d, правка узла) + пробный запуск; пишет `pixal3dDir` | NVIDIA, место |
| `pixal3dw` | веса Pixal3D, MoGe-2, NAF, DINOv3 (из timm) + преобразование | `pixal3d` |
| `pixal3dtest` | пробный запуск ComfyUI на 8191 и проверка узлов Trellis2 | `pixal3d`, `pixal3dw` |
| `vfx` | `scripts\vfx\Install-VfxTools.ps1 -Root <vfxTools>`; пишет `vfxTools` | — |

Типовой порядок для чистой машины (всё, кроме тяжёлого Pixal3D):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\Install.ps1 -Yes -Only node,npm,blender,comfy,hy2,u2net,godot,clips,sdxl,hymv,mvadapter,ollama,vlm
# позже, если нужен Pixal3D (≈ 46 ГБ):
powershell -NoProfile -ExecutionPolicy Bypass -File installer\Install.ps1 -Yes -Only pixal3d,pixal3dw,pixal3dtest
```

### Что мастер спрашивает (интерактивно) и ответ по умолчанию
Обязательное (без вопросов, в плане): `node` (если нет Node ≥ 22.12), `npm` (нет `node_modules\express` или `dist\index.html`), `blender`, `comfy`/`comfydeps`, `hy2`, `u2net`.
Дополнительное, по порядку: Hunyuan3D-2mv — **Д**; Hunyuan3D-2.1 — н; SDXL — н; Godot 4.5.1 — **Д**; клипы Quaternius — **Д**; генераторы VFX — н;
MV-Adapter — Д, только если SDXL уже стоит и нет предупреждения о 8 ГБ (иначе н; согласие добавляет SDXL в план); Ollama + LLM — Д, только если в Ollama вообще нет моделей;
qwen3-vl:8b — Д, если ≥ 8 ГБ VRAM и Ollama есть или ставится; Pixal3D — н. В конце «Итого» (загрузка, место по дискам, лицензии; для Hunyuan — предупреждение про ЕС/Великобританию/Южную Корею;
для Pixal3D — про nvdiffrast/PyMeshLab), затем «Начать установку?» [Д]. Сбой компонента → вопрос «Продолжить с остальными?».
В конце: проверка (`Scan` повторно), ярлык `AstraForge.lnk` на рабочем столе (→ `Start.cmd`, иконка `assets\astraforge.ico`), вопрос «Запустить AstraForge сейчас?».

**Как безопасно проверять мастер:** только `-ScanOnly` / `-DryRun` или подключение «точкой» (`. .\installer\Install.ps1` возвращается до мастера). Полный прогон
переписывает ярлык на рабочем столе, пишет `config\paths.json` и запускает студию; владелец полный прогон с реальными загрузками делать не велел.

### Что мастер пишет: `config\paths.json`
Ключи: `node`, `blender`, `comfyDir`, `godot`, `ollama`, `library`, `forgeRuntime`, `pixal3dDir`, `vfxTools` (и вручную можно `pixal3dUrl`). Файл в git не входит.
**Читает его `scripts\Start.ps1`**, который переносит значения в переменные среды (если они не заданы пользователем) и затем запускает `node server\index.mjs`:

| Ключ paths.json | Переменная | Значение по умолчанию, если нет ни того, ни другого (код) |
|---|---|---|
| `blender` | `ASTRA_BLENDER` | `C:/Program Files/Blender Foundation/Blender 5.0/blender.exe` |
| `godot` | `ASTRA_GODOT` | поиск `Godot_v*-stable_win64[_console].exe` в `C:/Program Files/Godot`, `C:/Godot`, `C:/Dorn/Game Dev`, `%LOCALAPPDATA%/Programs/Godot` (рантайм-папку `runtime\godot` код **не** смотрит) |
| `comfyDir` | `ASTRA_COMFY_DIR` | `D:/ComfyUI` |
| `library` | `ASTRA_FORGE_LIBRARY` | `C:\AstraForge\library` (Windows) |
| `forgeRuntime` | `ASTRA_FORGE_RUNTIME` | `C:\AstraForge\runtime`; мастер ставит `<APP>\data\runtime\forge`, если `C:\AstraForge\runtime` ещё нет или APP лежит в `C:\AstraForge` |
| `pixal3dDir` | `ASTRA_PIXAL3D_DIR` | `C:/AstraForge/ComfyUI-Pixal3D` (мастер по умолчанию: `<APP>\runtime\ComfyUI-Pixal3D`) |
| `pixal3dUrl` | `ASTRA_PIXAL3D_URL` | `http://127.0.0.1:8191` (только локальный http) |
| `vfxTools` | `ASTRA_VFX_TOOLS` | `C:\AstraForge\tools\vfx` (мастер: `<APP>\runtime\vfx`) |
| `node` | — | `Start.ps1` берёт путь сам; иначе `node.exe` из PATH; иначе **жёстко прописанный** `C:\Users\doron\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` (мусор от Codex, на другом ПК не существует) |

**Ловушка:** `paths.json` не видят `node scripts\forge.mjs --direct`, `scripts\views\*.mjs` и прямой `node server\index.mjs` — им нужны переменные `ASTRA_*` (или значения по умолчанию из таблицы).
На машине владельца `config\paths.json` **нет вообще**, работают значения по умолчанию и совпадение путей (`D:\ComfyUI`, `C:\AstraForge\…`, Blender в Program Files).

Прочие переменные: `PORT` (порт сервера, по умолчанию 3210; но `Start.ps1`/`Stop.ps1` проверяют именно 3210), `ASTRA_FORGE_URL` (адрес сервера для CLI), `ASTRA_COMFY_URL` (по умолчанию `http://127.0.0.1:8190`),
`ASTRA_OLLAMA_URL`, `ASTRA_QA_VLM` (`qwen3-vl:8b`), `ASTRA_BLENDER_CONCURRENCY` (1), `ASTRA_FORGE_JOB_CONCURRENCY`, `ASTRA_GPU_MUTEX` (`Global\HG_GPU_RENDER`), `ASTRA_VFX_WEB_PORT` (3211),
`ASTRA_SQ_ROOT` (`C:/Dorn/Dops media/space_quest`, только чтение), `ASTRA_FORGE_REVIEW_STATE|ROLES|DECISIONS` (вкладка «Приёмка»), `ASTRA_CODEX_CONCURRENCY` (1), `ASTRA_SDXL_CONFIG`,
`CUSTOM_LLM_API_KEY`, `TRIPO_API_KEY` (не обязательны; `scripts/start.sh` читает gitignore-нутый `.env` рядом с собой, но приложение само `.env` **не читает** — переменные задают в среде до запуска).

## 2б. Компоненты студии (с 0.4.10)

- С 0.4.10 в студии есть окно «Компоненты студии» (`server/components.mjs` + `src/ComponentsPanel.jsx`):
  тот же список, что `Install.ps1 -ScanList`, галочки и наборы, докачка отмеченного в фоне `-Auto -Profile -Only`;
  открыть — «О программе → Компоненты студии».

## 3. Ручные шаги (мастер их не делает)

- **Клипы Mixamo** — скачивает владелец на mixamo.com (аккаунт Adobe): FBX Binary, **Without Skin**, 30 к/с; затем `node scripts\forge.mjs clips import <папка>` или перетаскивание во вкладке «Кузница → Движения».
  Загрузку персонажа на сайт Mixamo готовит шаг `prepare_mixamo`; сама кузница в сеть не ходит.
- **Наборы Quaternius** (Universal Base Characters, Modular Outfits Fantasy) — архивы даёт владелец; кладутся в `<library>\kits\quaternius`.
- **ChatGPT-ракурсы** — приложение Codex (Microsoft Store, `OpenAI.Codex`) с входом через ChatGPT; без него остаётся локальный MV-Adapter.
- **VFX**: установщики PixaFlux, KumoWorks, Slate запускает пользователь кнопкой во вкладке «VFX»; Pseudo Volume Generator (itch.io) и бесплатные «заказы» Gumroad/the orange box — руками.
- **Ключи** (свой OpenAI-совместимый эндпоинт, Tripo) — по желанию, в «Подключениях». Tripo платный: без решения владельца не запускать.
- Hugging Face: мастер **не использует токены**; если репозиторий потребует вход, скачайте файл вручную в путь из `components.md`.

## 4. Проверка после установки

```powershell
# 1. состояние (только чтение) — таблица есть/нет/выключено
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\astraforge\scripts\af_status.ps1" -App C:\AstraForge
# 2. запуск без браузера (скрытый процесс node; лог data\runtime\server*.log; PID data\runtime\node.pid)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\AstraForge\scripts\Start.ps1 -NoBrowser
curl.exe -s http://127.0.0.1:3210/api/health          # {"app":"AstraForge","version":"0.4.0"}
curl.exe -s http://127.0.0.1:3210/api/status          # ollama, comfy.ready, gpu, pixal3d{installed,running,missing}
# 3. кузница: Blender, Godot, библиотека, очередь, замок GPU
node C:\AstraForge\scripts\forge.mjs status
# 4. ракурсы: codex.available, mvadapter.ready
node C:\AstraForge\scripts\views\views_generate.mjs --status
# 5. Pixal3D (при запущенном 8191)
C:\AstraForge\ComfyUI-Pixal3D\python_embeded\python.exe -I C:\AstraForge\ComfyUI-Pixal3D\tools\smoke_test.py --port 8191
# 6. тесты Node без Blender (298 на 17.10.2026 по записям владельца)
cd C:\AstraForge; npm test
```
Остановка: `Stop.cmd` (или `scripts\Stop.ps1`): POST `/api/shutdown`, затем убивает только Python с `data\runtime\input` и `--port 8190`, а также ComfyUI-Pixal3D, запущенный студией
(метка `data\runtime\pixal3d-temp`); **основной ComfyUI на 8188 и Ollama остаются**. Pixal3D, запущенный вручную батником, не трогается.

Тесты Blender (долго, запускают Blender): `blender -b --factory-startup --python scripts\blender\tests\run_tests.py -- [модуль]`; интеграционный
`tests\integration\blender.test.mjs` в `npm test` не входит; дымовой прогон всех пресетов в настоящих Blender и Godot — `node scripts\forge-smoke.mjs` (≈ 5 мин, пишет `docs\forge\SMOKE.md`).

Если `npm` в PATH сломан: `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run build`. Режим разработки: `npm run dev` (Vite внутри сервера).

## 5. Обновление
`git pull` (в Claude-среде без `git -C`/`git -c`: сначала `cd` в папку) → `npm ci` → `npm run build` → `Stop.cmd` → `Start.cmd` (реестр шагов читается при старте сервера: «студия не знает маршрут» = запущена до обновления).
Данные (`data\`, библиотека) не трогать.

## 6. Перенос библиотеки `C:\AstraForge\library` и данных

Состав на машине владельца (17.10.2026): `assets` — 532 паспорта, ≈ 35 ГБ; `jobs` — ≈ 560 записей, 33 МБ; `animations` — 91 МБ (86 Quaternius + 38 Mixamo + `index.json`);
`kits` — 419 МБ; `rigs` — 1,7 МБ; `props` — 84 КБ; `batches`, `trash`. Для **нового ПК обычно достаточно** `animations`, `kits`, `rigs`, `props` (≈ 0,5 ГБ); `assets` — только если нужны старые ассеты.
```powershell
robocopy C:\AstraForge\library D:\backup\library /E /COPY:DAT /R:1 /W:1       # на новом ПК — обратно, в тот же путь
```
- **Пути в паспортах абсолютные** (`asset.json` → `exports[].path`, `v001\version.json` → `outputs.*` содержат `C:\\AstraForge\\library\\…`). Кода пересчёта путей в движке нет
  (`server\forge-pipeline.mjs` не содержит перемещения). Поэтому библиотеку кладите в **тот же путь**; иначе задайте `library`/`ASTRA_FORGE_LIBRARY` и считайте старые версии ассетов
  «только для чтения» (новые прогоны `from: source` работают; поведение `from: latest` на старых версиях при другом пути не проверялось).
- Прежняя копия `<APP>\data\library.moved-2026-10-11` — остаток переноса 11.10, удалять можно.
- Данные студии (проекты, генерации, ассеты, виды): `<APP>\data\{assets,jobs,projects,exports,views,tripo,python,models}`; не удалять; `data\vault.json` не копировать.
- Pixal3D переносится копированием всей папки (≈ 46 ГБ, Python портативный, кэши внутри); после — `pixal3dtest` или `smoke_test.py`.
- Рабочие скрипты бойцов `C:\AstraForge\incoming\…` (в git их нет) переносятся отдельно — см. `games.md`.

## 7. Если мастер недоступен — ручной минимум

1. Node ≥ 22.12 → в APP `npm ci`, `npm run build`.
2. Blender 5.0.1 (zip) → путь в `ASTRA_BLENDER`.
3. ComfyUI v0.33.2 (zip) + `uv venv --python 3.12 .venv` + `uv pip install --python .venv\Scripts\python.exe torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128`
   + `-r requirements.txt` + `rembg onnxruntime numba scikit-image xatlas` → `ASTRA_COMFY_DIR` (должны быть `.venv\Scripts\python.exe`, `main.py`, `comfy_extras\nodes_hunyuan3d.py`).
4. Веса по таблице `components.md` в `data\models\checkpoints\` и `data\models\background\models\u2net\`.
5. `Start.cmd`. Студия сама поднимет ComfyUI на 8190, если в `data\models\checkpoints` лежит `hunyuan3d-dit-v2.safetensors` (иначе «Подключения» → запуск 3D-движка).

## 8. Скилы для LLM (Claude Code и другие)

Скилы лежат в самом репозитории: `ai/skills/astraforge` и `ai/skills/astraforge-vfx` (описание — `ai/skills/README.md`).
После клонирования подключите их к Claude Code ссылками, чтобы их видела любая сессия (cmd, права администратора не нужны):

```bat
mklink /J "%USERPROFILE%\.claude\skills\astraforge" "<APP>\ai\skills\astraforge"
mklink /J "%USERPROFILE%\.claude\skills\astraforge-vfx" "<APP>\ai\skills\astraforge-vfx"
mklink /J "%USERPROFILE%\.claude\skills\astraforge-integrator" "<APP>\ai\skills\astraforge-integrator"
mklink /J "%USERPROFILE%\.claude\skills\astraforge-learn" "<APP>\ai\skills\astraforge-learn"
copy "<APP>\ai\agents\astraforge-integrator.md" "%USERPROFILE%\.claude\agents\"
```

Интегратор с движками (`astraforge-integrator`, агент того же имени) использует ещё два MCP-сервера: `UnityMCP`
(MCP for Unity 10.3.0) и `godot` (Godot MCP). Их регистрирует команда `node <APP>\scripts\engines\af_engine.mjs
mcp-register` — идемпотентно, scope user. Unity-пакет MCP ставится в проект командой `engine_project_create` или
`af_unity_send.mjs --with-mcp` — только с согласия владельца на версию. Подробности — `docs/forge/engines.md`.

Затем добавьте в `%USERPROFILE%\.claude\CLAUDE.md` раздел «Игры и 3D-ассеты: AstraForge» (текст — в Obsidian, заметка
«AstraForge — установка с нуля»), чтобы сессии в проектах игр сами шли в эти скилы. Другим LLM отдайте папку
`ai/skills/astraforge` как есть: это обычные markdown-файлы, начинать с `SKILL.md`.
