# Сторонние компоненты

Код этой ветки (`linux-support`) распространяется под лицензией MIT (файл `LICENSE`) — это независимая
ре-реализация для Linux, см. атрибуцию и провенанс там же и в `docs/adr/0004-*`. Модели, созданные
в студии, принадлежат пользователю.

Студия собрана на открытых программах и моделях, и их авторы сделали огромную работу — спасибо им. Перечисленное ниже
в установочный файл **не входит**: установщик сам скачивает эти компоненты с сайтов авторов (адреса, размеры и
контрольные суммы — `installer/manifest.json`, подробный журнал — `installer/install.log`). Компоненты
распространяются по собственным лицензиям; этот список всегда доступен в студии: «О программе → Лицензии».
Модели Hunyuan3D нельзя использовать на территории ЕС, Великобритании и Южной Кореи (условие Tencent).

| Компонент | Откуда | Лицензия |
|---|---|---|
| Node.js | nodejs.org | MIT |
| Пакеты npm (express, react, three, zod и др., папка `node_modules`) | npmjs.com | MIT / ISC / Apache-2.0 / BSD (см. `node_modules/*/LICENSE`) |
| Blender 5.0 | blender.org | GPL-3.0-or-later |
| ComfyUI (в том числе версия 0.39.0 для Pixal3D) | github.com/comfyanonymous/ComfyUI (теперь Comfy-Org/ComfyUI) | GPL-3.0 |
| uv, управляемый Python 3.12 | astral.sh, python.org | MIT / Apache-2.0; PSF License |
| PyTorch | pytorch.org | BSD-3-Clause |
| rembg, onnxruntime, numba, scikit-image, xatlas | PyPI | MIT / BSD |
| Модель u2net | github.com/danielgatis/rembg | Apache-2.0 |
| Модели Hunyuan3D-2, 2mv, 2.1 | huggingface.co/tencent | Tencent Hunyuan Community License: **не действует на территории ЕС, Великобритании и Южной Кореи**; при аудитории свыше 1 млн пользователей в месяц нужна отдельная лицензия Tencent |
| Модель SDXL base 1.0 | huggingface.co/stabilityai | CreativeML Open RAIL++-M |
| Веса MV-Adapter (`mvadapter_i2mv_sdxl.safetensors`, ракурсы по одной картинке) | huggingface.co/huanngzh/mv-adapter | Apache-2.0 |
| diffusers, peft, accelerate, timm, trimesh, antlr4-python3-runtime (пакеты Python в окружении ComfyUI для MV-Adapter) | PyPI | Apache-2.0 / MIT / BSD |
| TripoSG — third shape engine: код (репозиторий заморожен по коммиту, `runtime/triposg/src/TripoSG`) и веса | github.com/VAST-AI-Research/TripoSG, huggingface.co/VAST-AI/TripoSG | MIT |
| DINOv2-large — image-энкодер TripoSG (входит в снимок весов) | huggingface.co/facebook/dinov2-large | Apache-2.0 |
| fast_simplification (сокращение граней в воркере TripoSG) | PyPI | MIT |
| Godot 4.5.1 | godotengine.org | MIT |
| Ollama | ollama.com | MIT |
| Модели Qwen3 и Qwen3-VL (qwen3-vl:8b, проверка текстур и анимации) | ollama.com/library/qwen3, ollama.com/library/qwen3-vl | Apache-2.0 |
| Анимации Quaternius (библиотека ActionForge) | actionforge.app | CC0 1.0 |
| **Pixal3D** (код и веса «только форма») | huggingface.co/TencentARC/Pixal3D | MIT (Tencent) |
| TRELLIS.2 и обёртка узлов ComfyUI-Trellis2 (visualbruno), закреплённый коммит; декодер `ss_dec_conv3d_16l8_fp16` из microsoft/TRELLIS-image-large | github.com/visualbruno/ComfyUI-Trellis2, huggingface.co/microsoft | MIT |
| MoGe-2 ViT-L (`Ruicheng/moge-2-vitl`, камера по одному виду) | huggingface.co/Ruicheng/moge-2-vitl | MIT |
| NAF (апсемплер признаков; код и веса релиза) | github.com/valeoai/NAF | Apache-2.0 |
| **DINOv3 ViT-L/16** (официальная копия timm `timm/vit_large_patch16_dinov3.lvd1689m`, преобразованная в формат transformers) | huggingface.co/timm, Meta | **лицензия DINOv3**: безвозмездная, коммерческое использование допустимо; запрещены военные цели и нарушение торговых ограничений; при передаче весов или производных нужно прикладывать текст лицензии (он лежит рядом с моделью, `LICENSE.md`) |
| utils3d 1.7 (GitHub `EasternJournalist/utils3d`, не одноимённый пакет PyPI) | github.com/EasternJournalist/utils3d | MIT |
| FlashAttention 2.8.3 (готовое колесо kingbri1), triton-windows, cumesh, flex_gemm, o_voxel, NATTEN | github.com, PyPI | BSD-3-Clause / MIT |
| **nvdiffrast** и **nvdiffrec_render** | NVIDIA | **некоммерческая лицензия NVIDIA**: с версии 0.4 установщик их **не ставит** (и удаляет из прежних установок); узлы Trellis2 пропатчены, импорт необязательный |
| meshlib (MeshLib, AMV Consulting) | — | **не ставится и не используется**: лицензия только некоммерческая; узлы Trellis2 пропатчены, чтобы загружаться без него, дыры заделывает CuMesh (MIT) |
| PyMeshLab (нужен узлам Trellis2 при загрузке) | PyPI | GPL-3.0 |
| Остальные пакеты движка Pixal3D (список и версии: `installer/pixal3d/requirements-lock.txt`): open3d, rembg, onnxruntime-gpu, opencv-python, trimesh, transformers, timm и др. | PyPI | MIT / Apache-2.0 / BSD |
| Python 3.12.10 (портативная сборка, заголовки из dev.msi) | python.org | PSF License |

Узел ComfyUI-MVAdapter (github.com/huanngzh/ComfyUI-MVAdapter, Apache-2.0) устанавливается мастером в `data/runtime/custom_nodes/ComfyUI-MVAdapter`: оригинал с GitHub на закреплённом коммите плюс небольшие правки AstraForge (файлы в `installer/mvadapter/patch`, список в `NOTICE-ASTRAFORGE.md`).

**Pixal3D (необязательный компонент).** Движок ставится в отдельную папку (`runtime/ComfyUI-Pixal3D` по умолчанию) и работает как отдельная программа на порту 8191. Узлы Trellis2 и их колёса (`o_voxel`, `utils3d`) импортируют при загрузке библиотеки с особыми лицензиями: `nvdiffrast` и `nvdiffrec_render` (NVIDIA, некоммерческая лицензия), `meshlib` (некоммерческое и учебное использование) и `pymeshlab` (GPL-3.0). AstraForge:

- не ставит nvdiffrast и nvdiffrec_render: `installer/pixal3d/patch_trellis2.py` делает их импорт необязательным, узлы текстурирования Trellis2/Pixal3D без них не работают и студией не используются (только форма; предпросмотр рендерится в Blender);
- не вызывает meshlib: заделка дыр в графе Pixal3D — `Trellis2FillHolesWithCuMesh` (CuMesh, MIT); пакет meshlib установщик не ставит (`installer/pixal3d/patch_trellis2.py` делает его импорт необязательным).

Если вы используете результат в коммерческой работе, проверьте эти лицензии самостоятельно. Автоматическое скачивание DINOv3 со стороннего зеркала в узле отключено (правка `ASTRAFORGE PATCH` в `nodes.py`): веса берутся только из официальной копии timm.

**Генераторы VFX-текстур (вкладка «VFX», необязательный компонент `vfx`).** В архив не входят. Мастер или
`scripts/vfx/Install-VfxTools.ps1` скачивает их с сайтов авторов в отдельную папку (`ASTRA_VFX_TOOLS`), а
установщики PixaFlux, KumoWorks и Slate запускает сам пользователь. Полный список — `server/vfx-tools-catalog.json`.

| Компонент | Откуда | Лицензия |
|---|---|---|
| Material Maker 1.7 | github.com/RodZill4/material-maker | MIT |
| Pixelorama 1.2.3 (редактор пиксель-арта, запускается как внешняя программа) | github.com/Orama-Interactive/Pixelorama | MIT |
| LoRA pixel-art-xl (nerijs) для генерации пиксель-арта (SDXL); скачивается в основной ComfyUI владельца (`models/loras`), в сборку и установщик не входит | huggingface.co/nerijs/pixel-art-xl | CreativeML OpenRAIL-M |
| KumoWorks 1.0.1 | github.com/opentoonz/kumoworks | BSD-3-Clause |
| Texture Generator Online, NormalMap Online | github.com/cpetry | MIT |
| DisplacementX (Greeble), собирается из исходников | github.com/satelllte/displacementx | GPL-3.0 (исходники лежат рядом, `web/displacementx-src`) |
| SculptGL (вкладка «Скульпт»), собирается из исходников; мост `scripts/sculpt/bridge.js` — часть AstraForge | github.com/stephomi/sculptgl | MIT (© Stéphane Ginier; текст лицензии лежит в сборке, `web/sculptgl/LICENSE.txt`) |
| Neon Flames | github.com/jwagner/Neonflames | лицензия не указана: только личное использование; установщик его **не скачивает**, во вкладке «VFX» — только ссылка на сайт автора |
| PixaFlux, Slate, FlowMap Painter, Pseudo Volume Generator | pixaflux.com, facedownfx.com, teckartist.com, acetix.itch.io | бесплатные программы на условиях авторов |
| Шрифты Inter, Oswald, JetBrains Mono — вложены в студию (`assets/fonts`, без обращений к сети во время работы) | Google Fonts (fonts.gstatic.com), github.com/google/fonts | SIL Open Font License 1.1; тексты лицензий рядом с файлами (`assets/fonts/OFL-*.txt`) |
| Заготовка Impact Decal (Material Maker) | materialmaker.org | CC0 |

Скрипты Blender и узел ComfyUI из этого архива работают внутри программ под лицензией GPL. Лицензия MIT
совместима с GPL. При распространении сборки, в которую уже вложены Blender или ComfyUI, на эти программы
действует GPL.
