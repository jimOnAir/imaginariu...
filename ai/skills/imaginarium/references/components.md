# Imaginarium: опись компонентов (что, какой версии, откуда, куда, кто использует)

Источники: `installer\Install.ps1` (APP = `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\Imaginarium`), `installer\pixal3d\manifest.json`,
`installer\pixal3d\requirements-lock.txt`, `installer\mvadapter\manifest.json`, `THIRD_PARTY_NOTICES.md`, `scripts\vfx\Install-VfxTools.ps1`,
`server\vfx-tools-catalog.json`, `package.json`, `server\*.mjs`. Ссылки и размеры взяты из файлов, **живость ссылок на 17.10.2026 не проверялась**
(скачивать при составлении описи запрещено). «Мастер» = `installer\Install.ps1`; id компонента — для `-Only` (см. `install.md`).
Размер «скачать / на диске»; sha256 приведён там, где он записан в файлах установщика (для остального мастер сверяет только размер).

Где ставится по умолчанию: `<APP>` — папка приложения (по умолчанию мастер ставит в неё же: `<APP>\runtime\…`, `<APP>\data\models\…`).

## 1. Программы

| id | Компонент | Версия / тег | Откуда (URL) | Размер | Лицензия | Куда | Кто использует / порт |
|---|---|---|---|---|---|---|---|
| `node` | Node.js | v22.23.3 (нужно ≥ 22.12; на машине владельца системный v26.7.0) | `https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip` | ≈ 32 МБ | MIT | `<APP>\runtime\node\node.exe` | сервер студии `server\index.mjs`, CLI `scripts\forge.mjs`; порт 3210 |
| `npm` | npm-зависимости + сборка интерфейса | `package-lock.json`; `npm ci` + `npm run build` (Vite 7) | npmjs.com | ≈ 250 МБ | MIT/ISC/Apache/BSD пакетов | `<APP>\node_modules`, `<APP>\dist` | интерфейс и сервер |
| `blender` | Blender | 5.0.1 (сборка 2025-12-16) | `https://download.blender.org/release/Blender5.0/blender-5.0.1-windows-x64.zip` | ≈ 401 МБ | GPL-3.0-or-later | `<APP>\runtime\blender\…\blender.exe` (у владельца `C:\Program Files\Blender Foundation\Blender 5.0\`) | все шаги Кузницы (`imaginarium_run.py`), рендер спрайтов; переменная `IMAGINARIUM_BLENDER` |
| `godot` | Godot | 4.5.1-stable (только он; не 4.7) | `https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_win64.exe.zip` | 76 685 794 Б | MIT | `<APP>\runtime\godot` (у владельца `C:\Dorn\Game Dev\Godot_v4.5.1-stable_win64[_console].exe`) | проверка пакетов `godot_package`/`render_sprites` без окна; `IMAGINARIUM_GODOT` |
| — | uv (ставит сам мастер при `comfy`/`comfydeps`/`mvadapter`) | **latest** (не закреплён) | `https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip` | — | MIT/Apache-2.0 | `<APP>\runtime\uv\uv.exe`; Python в `runtime\python`, кэш `runtime\uv-cache` | создаёт `.venv` Python 3.12 для ComfyUI, ставит пакеты |
| `comfy` | ComfyUI студии | v0.33.2 | `https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.33.2.zip` | ≈ 6 ГБ вместе с Python 3.12 и PyTorch (оценка мастера) | GPL-3.0 | `<APP>\runtime\ComfyUI` (у владельца `D:\ComfyUI`, ключ `comfyDir`) | Hunyuan3D, SDXL, MV-Adapter; **порт 8190** (студия запускает сама, см. ниже) |
| `comfydeps` | Python-пакеты ComfyUI | PyTorch **без закрепления** версий: `torch torchvision torchaudio` с `https://download.pytorch.org/whl/cu128` (нет NVIDIA — `…/cpu`); затем `requirements.txt` ComfyUI и `rembg onnxruntime numba scikit-image xatlas` (тоже без закрепления) | pytorch.org, PyPI | ≈ 1 ГБ (если ComfyUI уже есть) | BSD-3 / MIT / Apache | `.venv` ComfyUI | на машине владельца в `D:\ComfyUI\.venv`: Python 3.12.11, torch 2.11.0+cu128, torchvision 0.26.0, torchaudio 2.11.0, numpy 2.5.2, transformers 5.15.1, huggingface_hub 1.28.0, diffusers 0.40.0, accelerate 1.15.0, peft 0.21.2, timm 1.0.30, trimesh 5.1.1, rembg 2.0.81, onnxruntime 1.29.0, numba 0.67.0, scikit-image 0.26.0 |
| `ollama` | Ollama | 0.40.4 на машине владельца | `https://ollama.com/download/OllamaSetup.exe` (тихая установка `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES`) | 1 578 217 944 Б | MIT | `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`; модели — `OLLAMA_MODELS` (у владельца `D:\ollama-models`) | LLM-помощник, проверка qwen3-vl; **порт 11434** |
| `pixal3d` | ComfyUI-Pixal3D (движок) | см. раздел 3 | см. раздел 3 | загрузка ≈ 5,5 ГБ, на диске ≈ 12 ГБ (оценка) | MIT (Pixal3D, TRELLIS.2), BSD-3 (PyTorch, FlashAttention) + особые (раздел 3) | `<APP>\runtime\ComfyUI-Pixal3D` (ключ `pixal3dDir`; у владельца `C:\Imaginarium\ComfyUI-Pixal3D`) | форма по 1–4 видам; **порт 8191** |
| `vfx` | Генераторы VFX-текстур | каталог из 31 записи (раздел 7) | см. раздел 7 | ≈ 330 МБ (оценка мастера; у владельца на диске 495 МБ) | разные | `<APP>\runtime\vfx` (ключ `vfxTools`; у владельца `C:\Imaginarium\tools\vfx`) | вкладка «VFX»; веб-генераторы на **порту 3211** |
| — | Собственный узел ComfyUI `ImaginariumMesh` (Marching Cubes) | в репозитории | `data\runtime\custom_nodes\ImaginariumMesh\__init__.py` (**не терять**) | малый | MIT (код Imaginarium) | в git (исключение в `.gitignore`: `!data/runtime/custom_nodes/`) | извлечение поверхности Hunyuan3D |
| `mvadapter` | Узел ComfyUI-MVAdapter + пакеты | 1.0.2, коммит `9d6d8afeff135d81a31f16dde5291d8b40dbb0a4` | `https://github.com/huanngzh/ComfyUI-MVAdapter/archive/9d6d8afeff135d81a31f16dde5291d8b40dbb0a4.zip` + правки Imaginarium из `installer\mvadapter\patch` (`imagi_views.py`, `utils.py`, `nodes.py`, `__init__.py`) | ≈ 0,2 ГБ (узел + пакеты) | Apache-2.0 | `<APP>\data\runtime\custom_nodes\ComfyUI-MVAdapter` (в git-клоне он уже лежит целиком, вместе с правками; в Setup.exe его нет — мастер ставит заново) | ракурсы локально; в белом списке запуска ComfyUI студии |

Python-пакеты MV-Adapter (в `.venv` ComfyUI студии, **без обновления уже стоящих**, ограничения = текущий `pip freeze`):
`diffusers==0.40.0`, `accelerate==1.15.0`, `peft==0.21.2`, `timm==1.0.30`, `trimesh==5.1.1`, `antlr4-python3-runtime==4.9.3`,
`importlib_metadata==9.0.1`, `zipp==4.1.1`, плюс без версий `omegaconf einops kornia scikit-image opencv-python-headless safetensors`.
Конфиги SDXL (без весов) строит `scripts\views\make_sdxl_config.py` в `<APP>\data\models\mvadapter\sdxl-config`.

Как студия запускает свой ComfyUI (`server\runtime.mjs`): `python.exe main.py --listen 127.0.0.1 --port 8190 --extra-model-paths-config data\runtime\models.yaml
--output-directory/--input-directory/--temp-directory/--user-directory data\runtime\… --database-url sqlite:///data/runtime/studio.db
--disable-all-custom-nodes --whitelist-custom-nodes ImaginariumMesh ComfyUI-MVAdapter --lowvram --reserve-vram 1`, переменные
`HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`. То есть код и `.venv` берутся из `IMAGINARIUM_COMFY_DIR` (по умолчанию в коде `D:/ComfyUI`), а рабочие папки, база
и узлы — свои, в `<APP>\data\runtime`; **пользовательские узлы и порт 8188 не затрагиваются**.

## 2. Веса 3D-моделей Hunyuan3D, картинок и вспомогательные

| id | Что | URL | Куда | Размер (байт) | Лицензия |
|---|---|---|---|---|---|
| `hy2` | Hunyuan3D-2 (форма по картинке; обязательная) | `https://huggingface.co/tencent/Hunyuan3D-2/resolve/main/hunyuan3d-dit-v2-0/model.fp16.safetensors` | `data\models\checkpoints\hunyuan3d-dit-v2.safetensors` | 4 928 151 562 | Tencent Hunyuan Community License (**не действует в ЕС, Великобритании, Южной Корее**; > 1 млн пользователей в месяц — нужна лицензия Tencent) |
| `hymv` | Hunyuan3D-2mv (по нескольким видам) | `https://huggingface.co/tencent/Hunyuan3D-2mv/resolve/main/hunyuan3d-dit-v2-mv/model.fp16.safetensors` | `data\models\checkpoints\hunyuan3d-dit-v2-mv.safetensors` | 4 928 151 562 | та же |
| `hy21` | Hunyuan3D-2.1 (в формате Comfy-Org; выбор `shapeModel: hunyuan21`) | `https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors` | `data\models\checkpoints\hunyuan_3d_v2.1.safetensors` | 7 365 943 290 | та же (в `THIRD_PARTY_NOTICES.md` источник указан как huggingface.co/tencent) |
| `sdxl` | SDXL base 1.0 (концепт из текста; основа MV-Adapter) | `https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors` | `data\models\checkpoints\` **или** `<comfyDir>\models\checkpoints\` (студия видит обе; у владельца в `D:\ComfyUI\models\checkpoints`) | 6 938 078 334 | CreativeML Open RAIL++-M |
| `u2net` | u2net.onnx (rembg: вырезание фона на CPU) | `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx` | `data\models\background\models\u2net\u2net.onnx` (папка задаётся `U2NET_HOME`) | 175 997 641 | Apache-2.0 по `THIRD_PARTY_NOTICES.md` (мастер в плане печатает «MIT» — расхождение) |
| `mvadapter` | `mvadapter_i2mv_sdxl.safetensors` (репозиторий `huanngzh/mv-adapter`) | `https://huggingface.co/huanngzh/mv-adapter/resolve/main/mvadapter_i2mv_sdxl.safetensors` | `data\models\mvadapter\` | 3 602 537 816, sha256 `260e486d507247db30601d22de317e3f9c07f75a29912d43ed5c3a4aab4db4c9` | Apache-2.0 |

Для `hy2`/`hymv`/`hy21`/`sdxl`/`u2net` мастер сверяет **только размер** (sha256 в `Install.ps1` не записаны; у `hy2` и `hymv` размер одинаковый).
Загрузка: `curl.exe -L --fail --retry 5 -C -` в файл `.part`, затем переименование (прерванная докачивается).

## 3. Pixal3D (TRELLIS.2): отдельный портативный ComfyUI, порт 8191, ТОЛЬКО форма

Все версии и хэши — `installer\pixal3d\manifest.json` (сгенерирован 2026-10-14, воспроизводит `C:\Imaginarium\ComfyUI-Pixal3D`).
Ставит `installer\pixal3d\pixal3d.ps1`; описание на диске — `IMAGINARIUM_README.md` в папке установки. Проверка после установки — `P3Smoke`
(`installer\pixal3d\smoke_test.py`, пробный запуск на 8191 и остановка).

| Компонент | Версия / коммит | URL | Размер / sha256 | Лицензия |
|---|---|---|---|---|
| Python (embed) | 3.12.10, подпись «Python Software Foundation» проверяется | `https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip`; заголовки для triton — `…/3.12.10/amd64/dev.msi` | — | PSF |
| pip | 26.2.1 (колесо с PyPI, sha256 из ответа PyPI) | `https://pypi.org/pypi/pip/26.2.1/json` | — | MIT |
| ComfyUI | 0.39.0, коммит `8010b48d2c1be986613f8e8c761527d205bd756f` | `https://github.com/Comfy-Org/ComfyUI/archive/8010b48d2c1be986613f8e8c761527d205bd756f.zip` | — | GPL-3.0 |
| PyTorch | torch 2.8.0, torchvision 0.23.0, torchaudio 2.8.0 (+cu128) | индекс `https://download.pytorch.org/whl/cu128` | ≈ 3,5 ГБ | BSD-3 |
| FlashAttention | 2.8.3 (колесо kingbri1, cu128 torch2.8.0 cp312) | `https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu128torch2.8.0cxx11abiFALSE-cp312-cp312-win_amd64.whl` | 127 588 011 Б, `709d6663d74f96bb0304b5ba2ffee84a4dafbcb56d73d35bc90b7ca8cd44261b` | BSD-3 |
| ComfyUI-Trellis2 (visualbruno) | 1.0.27, коммит `b0e84c0f29857a444e8bcb5b9be2ea218e96efd0` | `https://github.com/visualbruno/ComfyUI-Trellis2/archive/b0e84c0f29857a444e8bcb5b9be2ea218e96efd0.zip` (внутри `wheels/Windows/Torch280`) | — | MIT |
| колёса узла | cumesh 1.0, flex_gemm 0.0.1, o_voxel 0.0.1, natten 0.21.6 (cp312 win_amd64); **nvdiffrast 0.4.0 и nvdiffrec_render с 0.4 (28.10.2026) не ставятся** (некоммерческая лицензия NVIDIA, `trellis2.excludedWheels` в манифесте) | в архиве узла | sha256: cumesh `fc5124db…6de4`, nvdiffrast `e19fd7a3…f208`, nvdiffrec_render `4318a7c0…325e`, flex_gemm `fa0da34b…f004`, o_voxel `b9cb2d30…f2e4`, natten `1ba8ca20…4451` (для Blackwell, RTX 50, compute ≥ 12: папка `Blackwell`, `546e6365…aec10`) | см. ниже |
| utils3d | 1.7, коммит `83bfa5bda008803f6521ce9547f94023b8afeddd` — **GitHub EasternJournalist, не одноимённый пакет PyPI** | `https://github.com/EasternJournalist/utils3d/archive/83bfa5bda008803f6521ce9547f94023b8afeddd.zip` (ставится `--no-deps --no-build-isolation`) | — | MIT |
| Пакеты PyPI | 145 закреплённых пакетов | `installer\pixal3d\requirements-lock.txt`, `pip install --no-deps -r` | ≈ 1,3 ГБ | MIT/Apache/BSD (среди них `pymeshlab` 2025.7.post1 — GPL-3.0) |
| Правка узла | `patch_trellis2.py` помечает `nodes.py` строкой `IMAGINARIUM PATCH`: автоскачивание DINOv3 со стороннего зеркала заменено ошибкой; `meshlib` делается необязательным (дыры заделывает CuMesh) | — | — | — |

Ключевые закреплённые пакеты (из lock): `numpy==2.5.2`, `transformers==4.57.6`, `timm==1.0.30`, `huggingface_hub==0.36.2`, `triton-windows==3.4.0.post21`,
`open3d==0.20.0`, `rembg==2.0.85`, `onnxruntime-gpu==1.31.0`, `opencv-python==5.0.0.93`, `trimesh==5.1.1`, `kornia==0.8.3`, `safetensors==0.8.0`, `Pillow 12.3.0`.

**Веса Pixal3D** (всего ≈ 36,5 ГБ, на диске ≈ 46 ГБ вместе с движком; sha256 сверяются с файловым списком Hugging Face, `HfTree`):

| Файл (в `ComfyUI\models\…`) | Репозиторий | Размер (байт) | sha256 |
|---|---|---|---|
| `TencentARC\Pixal3D\ckpts\ss_dec_conv3d_16l8_fp16.safetensors` (копия в `microsoft\TRELLIS-image-large\ckpts\`) | `TencentARC/Pixal3D` | 147 591 972 | `1c76d4a40519aa2d711cc263a8404105231ac26db31d946bed48b84fee79009a` |
| `…\shape_dec_next_dc_f16c32_fp16.safetensors` | то же | 948 490 494 | `e3b718d3e43e4f8780e9a24ac6fff231811a67e3b058e336e10fe654c911d581` |
| `…\ss_flow_img_dit_1_3B_64_bf16.safetensors` | то же | 5 359 822 584 | `6d0147bb347eb61fa81c304cc68c7fd69d447e91870357a549b47e1d0fd77242` |
| `…\ss_flow_img_dit_1_3B_64_bf16_mv.safetensors` | то же | 5 359 822 584 | `e7ce63050e317cff70ed2c6dfcc549e668cd948c47347f31985fd4996b4ce5a6` |
| `…\slat_flow_img2shape_dit_1_3B_1024_bf16.safetensors` | то же | 5 546 764 048 | `3e6d1df0e62bc5bc863320d1d63d6b996235eef4abb8b851e878c88f316369f1` |
| `…\slat_flow_img2shape_dit_1_3B_1024_bf16_mv.safetensors` | то же | 5 546 764 048 | `37b75c8f0f089a7e3e825dec035ac83b9c989efd14d0c8ada6a620d2be561c71` |
| `…\slat_flow_img2shape_dit_1_3B_512_bf16.safetensors` | то же | 5 546 764 048 | `63569838c1da93f010e2fa805b202ecf802cc758830230abac202a81b70e5b45` |
| `…\slat_flow_img2shape_dit_1_3B_512_bf16_mv.safetensors` | то же | 5 546 764 048 | `043a0d7fc7ee81792fcb22f836c91f5aaf69f4fda15e25c38488db13dd7b77ec` |
| `Ruicheng\moge-2-vitl\model.pt` | `Ruicheng/moge-2-vitl` (MIT) | 1 305 030 700 | `3eefd4abb2102f38f12b2d1992e5ff15e4923e5431c67dd494afe157e0111cd5` |
| `timm\vit_large_patch16_dinov3.lvd1689m\model.safetensors` → преобразуется `tools\dinov3_timm_to_hf.py` в `facebook\dinov3-vitl16-pretrain-lvd1689m\model.safetensors` (допуск совпадения 1e-3, отчёт `logs\dinov3_parity.json`) | `timm/vit_large_patch16_dinov3.lvd1689m` — **только официальная копия timm** | 1 212 347 640 | `45172f209c9583c40538afc26b60a07033e6fcc2e8c30228338e6b2e932e7941` |
| NAF `cache\torch\hub\checkpoints\naf_release.pth` + код `cache\torch\hub\valeoai_NAF_main` (коммит `37f2dfc180f2de53d98bd601109c0da0dd6b0f43`) | `https://github.com/valeoai/NAF/releases/download/model/naf_release.pth` | 2 664 431 | `c096c1ab2217a5c3ac136365f721685e2201379cb69d509cfb0261183847c98f` |
| вспомогательные json/README/LICENSE/NOTICE/pipeline*.json Pixal3D | `TencentARC/Pixal3D` | малые | — |

Лицензии Pixal3D: Pixal3D и TRELLIS.2, обёртка узлов, MoGe — MIT; NAF — Apache-2.0; DINOv3 — лицензия DINOv3 (безвозмездная, коммерческое использование
допустимо, запрещены военные цели и нарушение торговых ограничений; при передаче весов прикладывать `LICENSE.md`). **nvdiffrast и nvdiffrec_render (NVIDIA) —
некоммерческая лицензия**: с 0.4 не ставятся и удаляются из прежних установок; `patch_trellis2.py --site-packages` делает импорт необязательным в узлах и колёсах `o_voxel`/`utils3d`. Imaginarium их и раньше не вызывал (в графе нет узлов `Texturing`,
`Rasteriz`, `Render`, `UnWrap`, `nvdiff` — это проверяет `tests\pixal3d.test.mjs`). `meshlib` (некоммерческая) не ставится. Для коммерческой работы лицензии проверять самому.

## 4. Локальные LLM (Ollama)

| Модель | Для чего | Откуда | Размер | Лицензия |
|---|---|---|---|---|
| `qwen3-27b-cc:latest` | **модель по умолчанию помощника студии** (`ollamaModel` в `server\schema.mjs`); вкладка «AI», перевод русского текста промптов | локальная, происхождение (чем отличается от `qwen3-27b`) в репозитории не указано — **не найдено** | 16 ГБ | Apache-2.0 (Qwen3) |
| `qwen3-27b:latest` | запасная большая | локальная, происхождение не найдено | 16 ГБ | то же |
| `qwen3-vl:8b` (id `vlm`) | модель «зрения»: проверка текстур (`paint_from_concept`, `qa_model`) и анимации (`_tools\vlm_check.py`); переменные `IMAGINARIUM_QA_VLM`, `IMAGINARIUM_OLLAMA_URL` | `ollama pull qwen3-vl:8b` | 6,1 ГБ по мастеру (6,2 ГБ в `ollama list`) | Apache-2.0 |
| `qwen3:4b` / `qwen3:8b` / `qwen3:14b` (id `llm`) | то, что мастер **предлагает** для нового ПК: < 8000 МиБ VRAM → 4b (2500 МБ), ≥ 8000 → 8b (5200 МБ), ≥ 16000 → 14b (9300 МБ); ставит и прописывает в `data\config.json` (`provider: ollama`) | `ollama pull <имя>` | см. слева | Apache-2.0 |

Свой OpenAI-совместимый эндпоинт и Tripo подключаются ключами в «Подключениях» (хранилище DPAPI `data\vault.json`, привязано к пользователю Windows); ключ
своего эндпоинта не обязателен, если эндпоинт работает без авторизации. Платные операции Tripo без решения владельца не запускаются.

## 5. Библиотеки клипов и наборы

| Что | Откуда | Размер / состав | Лицензия | Куда |
|---|---|---|---|---|
| Анимации ActionForge (Quaternius), id `clips` | манифест `https://actionforge.app/assets/animation-library/manifests/library.json`, файлы `…/animation-library/<file>`; мастер переводит их в FBX (Blender, `installer\imaginarium_clips_to_fbx.py --library`) и импортирует шагом `clip_library` | 86 клипов, ≈ 10 МБ (меч, щит, магия, лук, смерть и др.) | CC0 1.0 (код сайта закрытый © CGstuff — не копировать) | `<library>\animations\quaternius\` (id `quaternius-<клип>`); клипы «на месте» (корень обнулён) |
| Анимации Mixamo | **только вручную**: mixamo.com, аккаунт Adobe, FBX Binary, **Without Skin**, 30 к/с, Keyframe Reduction none; в сеть студия не ходит | на машине владельца 38 клипов (`<library>\animations\mixamo\`, id `mixamo-<имя>`) | Adobe: бесплатно для игр и фильмов, **сами FBX не распространять** | `clips import <папка>` или перетаскивание во вкладке «Кузница → Движения» |
| Quaternius Universal Base Characters [Standard], Modular Character Outfits – Fantasy [Standard], Universal Animation Library 2 [Standard] | архивы даёт владелец (`C:\Dorn\Dops media\Universal Base Characters[Standard].zip` 128 968 391 Б, `Universal Animation Library 2[Standard].zip` 18 735 003 Б); страница пака `https://quaternius.com/packs/universalbasecharacters.html` | база персонажей (65 костей с пальцами), причёски, одежда | CC0 1.0 (`kits\quaternius\LICENSE.md`) | `<library>\kits\quaternius\…`, скелет `<library>\rigs\quaternius-human\` (71 кость), предметы `<library>\props\actionforge\` |
| Human Base Meshes v1.4.1 (Blender Studio) | вне git, для тестов рига и юнитов «Врат» | — | CC0 | `heroes-gates_incoming\assets\human-base-meshes\` |

## 6. Картинки: ракурсы, концепты

| Что | Как работает | Требования |
|---|---|---|
| ChatGPT через приложение Codex (`OpenAI.Codex` из Microsoft Store, на машине владельца 26.1007.9446.0) | `scripts\views\codex_image.mjs` вызывает `codex exec` (вход через ChatGPT, без API-ключа), забирает PNG из `~\.codex\generated_images\`; ≈ 57–65 с на вид; картинка уходит в OpenAI; скилл `codex-image` — то же для обычных картинок | подписка ChatGPT, `codex.exe` не в PATH (ищется через `Get-AppxPackage`) |
| Локально MV-Adapter | SDXL + `mvadapter_i2mv_sdxl`, ≈ 34 с на все виды (640 px, 30 шагов), пик ≈ 9,7 ГБ VRAM | `mvadapter` + `sdxl` |
| SDXL (концепт из текста) | вызывается внутри задания генерации | `sdxl` |

## 7. VFX-генераторы (вкладка «VFX», id `vfx`)

Каталог — `server\vfx-tools-catalog.json` (31 запись: desktop 3, installer 3, web-local 4, file 1, web-online 5, store 4, paid 7, guide 4; источник —
Simon Schreibt «Textures for VFX», раздел Texture Generators). Скачивает `scripts\vfx\Install-VfxTools.ps1 [-Root] [-Only a,b] [-DryRun]` в `IMAGINARIUM_VFX_TOOLS`
(по умолчанию `C:\Imaginarium\tools\vfx`). Подробности и сценарии — скилл **`imaginarium-vfx`** (здесь только состав).

| id | Версия | URL загрузки | Лицензия | Куда |
|---|---|---|---|---|
| material-maker | 1.7 | `https://github.com/RodZill4/material-maker/releases/download/1.7/material_maker_1_7_windows.zip` | MIT | `apps\material-maker` |
| flowmap-painter | 0.9.2 | `https://teckArtist.com/ToolsnStuff/FlowMapPainter-0.9.2-win32.zip` | freeware | `apps\flowmap-painter` |
| pseudo-volume | 2.7 | вручную с `https://acetix.itch.io/pseudo-volume-generator` («Download Now → No thanks»), положить `3D Volume Generator 2.7 Win.zip` в `downloads\` | «назови свою цену» | `apps\pseudo-volume` |
| pixaflux | сборка 20260528 | `http://pixaflux.com/bin/PixaFlux.20260528.exe` (+ `…/blender/pixaflux.zip`, `…/wiki/samples/Samples.zip`) | freeware | `downloads\` (установщик запускает пользователь) |
| kumoworks | 1.0.1 | `https://github.com/opentoonz/kumoworks/releases/download/v1.0.1/KumoWorksSetup.exe` | BSD-3 | `downloads\` |
| slate | — | `https://s3.eu-west-2.amazonaws.com/facedownfx/Slate/Builds/Slate_Installer.zip` | freeware | `downloads\` |
| texture-generator-online, normalmap-online | ветка gh-pages | архивы `github.com/cpetry/TextureGenerator-Online`, `…/NormalMap-Online` | MIT | `web\texture-generator`, `web\normalmap` |
| displacementx (Greeble) | ветка main, собирается Astro через npm | `github.com/satelllte/displacementx` | GPL-3.0 | `web\displacementx-src` → `web\displacementx` |
| neonflames | master | `github.com/jwagner/Neonflames` | **без лицензии**: с 28.10.2026 `Install-VfxTools.ps1` его не скачивает (пропускает записи «без лицензии…»), во вкладке — только ссылка на сайт автора | — |
| impact-decal | id 1008 | `https://www.materialmaker.org/api/getMaterial?id=1008` | CC0 | `apps\material-maker-files\impact_decal.ptex` |

Остальные 17 записей (онлайн-генераторы, магазины, платные пакеты Substance Designer, статьи) — только ссылки; недоступны на 16.10.2026: Fateloom, четыре товара Flipped Normals (404).

## 8. Сквозные ограничения лицензий

Адреса, размеры и sha256 всех загрузок мастера — `installer/manifest.json` (с 0.4).

- Imaginarium — MIT (`LICENSE`), бесплатная; права на компоненты не меняет. Созданные в студии модели принадлежат пользователю.
- Hunyuan3D: Tencent Hunyuan Community License (ЕС/Великобритания/Южная Корея — нельзя). Pixal3D — MIT, но nvdiffrast/nvdiffrec_render некоммерческие и PyMeshLab GPL-3.0 стоят в окружении.
- Blender и ComfyUI — GPL; скрипты студии работают внутри них, MIT с GPL совместим; при раздаче сборки с вложенными Blender/ComfyUI действует GPL.
- Mixamo FBX не распространять; в игру идут только запечённые кадры/экспорты.
- Квота и правила репозиториев игр (лицензии ассетов) — `games.md`.
