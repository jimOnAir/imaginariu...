# Инвентарь машины владельца (снимок 17.10.2026, ≈ 14:45)

Собрано командами только на чтение (`--version`, `Get-ChildItem`, `nvidia-smi`, `ollama list`, GET по портам). Живой аналог: `scripts\af_status.ps1`. Числа могут уйти (студия работает и пишет в `data\` и библиотеку).
APP = `C:\Users\doron\Documents\Codex\2026-10-09\3\outputs\AstraForge`.

## Железо и ОС

| Что | Значение |
|---|---|
| ОС | Windows 11 Home 10.0.26200 (RU) |
| CPU / ОЗУ | Intel Core i9-13900KF / 63,7 ГБ |
| GPU | NVIDIA GeForce RTX 4070, 12 282 МиБ, драйвер 616.92, compute_cap 8.9 (в момент снимка занято 2,0–8,9 ГБ: студия, Pixal3D и Hunyuan держат модели) |
| Диски (свободно / занято) | C: 169,8 / 1 692,1 ГБ; D: 401,6 / 552 ГБ; E: 67,6 / 863,9 ГБ; F: 82,3 / 66,7 ГБ |

## Программы и версии

| Что | Путь | Версия |
|---|---|---|
| Node.js | `C:\Program Files\nodejs\node.exe` | v26.7.0 (мастер ставит v22.23.3; ≥ 22.12 достаточно). Запасной: `C:\Users\doron\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` |
| Blender | `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe` | 5.0.1 (build 2025-12-16); в `runtime\` приложения Blender нет |
| Godot | `C:\Dorn\Game Dev\Godot_v4.5.1-stable_win64.exe` (редактор, 163 358 216 Б) и `…_console.exe` (197 640 Б) | 4.5.1.stable.official.f62fdbde1 |
| Python | `py -0`: 3.14.2 (по умолчанию), Astral CPython 3.11.15; в Git Bash `python` — заглушка | — |
| ComfyUI (пользовательский) | `D:\ComfyUI` (`.venv` Python 3.12.11) | ComfyUI 0.33.2; torch 2.11.0+cu128, torchvision 0.26.0+cu128, torchaudio 2.11.0+cu128, numpy 2.5.2, transformers 5.15.1, huggingface_hub 1.28.0, diffusers 0.40.0, accelerate 1.15.0, peft 0.21.2, timm 1.0.30, trimesh 5.1.1, rembg 2.0.81, onnxruntime 1.29.0, numba 0.67.0, scikit-image 0.26.0, safetensors 0.8.0; `custom_nodes\ComfyUI-GGUF` |
| ComfyUI Desktop | `C:\Users\doron\AppData\Local\Programs\ComfyUI\ComfyUI.exe` | установлен, студией не используется |
| Ollama | `C:\Users\doron\AppData\Local\Programs\Ollama\ollama.exe`; `OLLAMA_MODELS=D:\ollama-models` | 0.40.4 |
| uv | `C:\Users\doron\AppData\Local\hermes\bin\uv.exe` | 0.12.5 |
| git / gh | `C:\Program Files\Git\mingw64\bin\git.exe`; `C:\Program Files\GitHub CLI\gh.exe` | git 2.53.0.windows.2; gh вошёл под аккаунтом `Snodrod` (токен в keyring, не копировать) |
| ffmpeg | `C:\Users\doron\bin\ffmpeg.exe` | — |
| Codex (для ракурсов ChatGPT) | Microsoft Store `OpenAI.Codex` | 26.1007.9446.0 |

## ComfyUI-установки и порты

| Что | Где | Порт | В момент снимка |
|---|---|---|---|
| Основной ComfyUI владельца — **не трогать** | `D:\ComfyUI` | 8188 | выключен |
| ComfyUI студии (Hunyuan3D, SDXL, MV-Adapter) | процесс из кода `D:\ComfyUI`, данные `APP\data\runtime\` (`input output temp user studio.db`), узлы `APP\data\runtime\custom_nodes\{AstraForgeMesh,ComfyUI-MVAdapter}`, лог `comfy.log` | 8190 | работает (PID 27568) |
| ComfyUI-Pixal3D | `C:\AstraForge\ComfyUI-Pixal3D` (46,0 ГБ, 69 722 файла) | 8191 | работает (PID 6240) |
| Студия AstraForge (node `server\index.mjs`) | `APP` | 3210 | работает (PID 51096), `/api/health` → AstraForge 0.3.0 |
| Веб-генераторы VFX | тот же процесс node | 3211 | работает |
| Ollama | — | 11434 | работает (PID 36604) |

ComfyUI-Pixal3D: Python 3.12.10 (embed, `python312._pth`), ComfyUI 0.39.0, Trellis2 1.0.27 (узел помечен `ASTRAFORGE PATCH`), torch 2.8.0+cu128, torchvision 0.23.0+cu128, flash_attn 2.8.3, utils3d 1.7, timm 1.0.30,
transformers 4.57.6, numpy 2.5.2, rembg 2.0.85, onnxruntime_gpu 1.31.0, open3d 0.20.0, triton_windows 3.4.0.post21, cumesh 1.0, flex_gemm 0.0.1, o_voxel 0.0.1, natten 0.21.6, nvdiffrast 0.4.0, nvdiffrec_render 0.0.0, pymeshlab 2025.7.post1.
В корне: `ComfyUI\ python_embeded\ cache\ logs\ tools\ ASTRAFORGE_README.md "Start ComfyUI (Pixal3D, 8191).bat"`; `tools\` — `dinov3_timm_to_hf.py, normalize_seed_mesh.py, run_pixal3d_eval.py, compare_meshes.py, render_head.py, finish_evaluation.py`.

## Приложение APP

- git: ветка `master`, HEAD `a7d5cfc` (17.10.2026), рабочее дерево чистое, `origin` = `https://github.com/Snodrod/AstraForge.git` (приватный). Версия `package.json` 0.3.0. Установщик собран: `…\outputs\AstraForge-release\AstraForge-Setup-0.3.0.exe` (46 036 480 Б, 14.10).
- Есть: `node_modules`, `dist`, `data\`. **Нет**: `config\paths.json`, `runtime\`, `library\` внутри APP, `data\config.json`, `data\vault.json`.
- `data\`: `assets` (852 файла = ≈ 426 ассетов с метаданными), `jobs` (111), `projects` (19), `exports` (22), `views` (6 наборов ракурсов), `tripo` (пусто), `python\xatlas-0.0.11`, `library.moved-2026-10-11\`, `models\`, `runtime\`.
- Рядом в `…\outputs\`: `AstraForge-release`, `Necromancer`, `NecromancerForge`, `ReferenceFidelity`, `ShipSQ03Forge` (пилоты), `CLAUDE-HANDOFF.md`, `AstraForge-source-handoff.zip`.

## Веса (файл — размер в байтах)

`APP\data\models\`:
```
checkpoints\hunyuan3d-dit-v2.safetensors       4 928 151 562
checkpoints\hunyuan3d-dit-v2-mv.safetensors    4 928 151 562
checkpoints\hunyuan_3d_v2.1.safetensors        7 365 943 290
background\models\u2net\u2net.onnx              175 997 641
mvadapter\mvadapter_i2mv_sdxl.safetensors     3 602 537 816
mvadapter\sdxl-config\…                         конфиги и токенайзеры SDXL (≈ 2 МБ)
```
`D:\ComfyUI\models\` (файлы > 1 МБ; пользовательские, студия берёт из них SDXL):
```
checkpoints\sd_xl_base_1.0.safetensors                        6 938 078 334
loras\minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors 1 956 192 992
loras\minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors 1 956 193 000
text_encoders\qwen3vl_32b_minimax_h3_int4_convrot.safetensors 14 952 506 709
text_encoders\qwen_2.5_vl_7b_fp8_scaled.safetensors            9 384 670 680
text_encoders\qwen_3_8b_fp8mixed.safetensors                   8 664 848 742
unet\flux-2-klein-base-9b-Q5_K_M.gguf                          7 018 699 040
unet\MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf                       8 902 845 536
unet\MiniMax-H3-FL2VA-Pruned-Q4_K_M.gguf                      11 564 180 576
unet\qwen-image-Q4_K_M.gguf                                   13 065 746 976
upscale_models\4x-UltraSharp.safetensors                          66 864 028
vae\flux2-vae.safetensors 336 211 292; vae\minimax_h3_audio_vae_fp32.safetensors 605 254 808;
vae\minimax_h3_video_vae_fp16.safetensors 5 207 808 496; vae\qwen_image_vae.safetensors 253 806 246
```
`C:\AstraForge\ComfyUI-Pixal3D\ComfyUI\models\`:
```
TencentARC\Pixal3D\ckpts\ss_flow_img_dit_1_3B_64_bf16[_mv].safetensors             5 359 822 584 (×2)
TencentARC\Pixal3D\ckpts\slat_flow_img2shape_dit_1_3B_{512,1024}_bf16[_mv].safetensors 5 546 764 048 (×4)
TencentARC\Pixal3D\ckpts\shape_dec_next_dc_f16c32_fp16.safetensors                   948 490 494
TencentARC\Pixal3D\ckpts\ss_dec_conv3d_16l8_fp16.safetensors (+ копия в microsoft\TRELLIS-image-large\ckpts) 147 591 972
facebook\dinov3-vitl16-pretrain-lvd1689m\model.safetensors                           1 212 559 808
timm\vit_large_patch16_dinov3.lvd1689m\model.safetensors (исходная копия, мастер её удаляет)  1 212 347 640
Ruicheng\moge-2-vitl\model.pt                                                        1 305 030 700
cache\torch\hub\checkpoints\naf_release.pth 2 664 431; cache\torch\hub\valeoai_NAF_main\
```

## Ollama (`ollama list`)

| Модель | ID | Размер |
|---|---|---|
| `qwen3-vl:8b` | e707b2c67b41 | 6,2 ГБ |
| `qwen3-27b-cc:latest` | a60964c9cc84 | 16 ГБ |
| `qwen3-27b:latest` | 4946fcac764d | 16 ГБ |

`qwen3-27b-cc` отличается от `qwen3-27b` только контекстом: `num_ctx` 65 536 против 32 768 (`ollama show`, 17.10.2026).

## `C:\AstraForge\`

| Папка | Содержимое |
|---|---|
| `library\` | `assets\` — 532 паспорта (≈ 35 ГБ); `jobs\` — 560 записей (33 МБ); `batches\` (2); `trash\`; `animations\` (91 МБ): `index.json`, `mixamo\` **38 клипов**, `quaternius\` **86 клипов** (`quaternius-*`), `_backup_quaternius_rootmotion\`; `kits\quaternius\` (419 МБ): `universal_base_characters\`, `outfits_fantasy\`, `README.md`, `LICENSE.md`; `rigs\quaternius-human\` (1,7 МБ); `props\actionforge\` |
| `runtime\` | всего 25 МБ: `blender\` (472 папки журналов шагов), `forge\uploads\` |
| `tools\vfx\` | 495 МБ: `apps\` (material-maker, flowmap-painter, pseudo-volume, material-maker-files, pixaflux-samples), `downloads\` (3D Volume Generator 2.7 Win.zip, KumoWorksSetup.exe, PixaFlux.20260528.exe, Slate_Installer.exe, pixaflux_blender_addon.zip), `web\` (texture-generator, normalmap, displacementx, displacementx-src, neonflames), `textures\`, `_catalog\` (`database.csv`, `database.json`, `generators.json`) |
| `incoming\` | 8,5 ГБ рабочих материалов: `units_1013\` (бойцы: `_tools\` — `posture.py, vlm_check.py, run_pixal3d.py, arm_markers.py, arm_rigid.py, smooth_arm_weights.py, fix_weights.py, paint_back.py, eval_mesh.py, render_tpose.py` …, скрипты `build_unit.sh, armfix_unit.sh, make_refs.sh, final_unit.py, prep_mv.py, gen_mv.py, preview.sh`, бойцы `militia, skeleton, wraith, archer`), `lowpoly\tools\` (`run_q.py, qchar.py, grip_solve.py, clip_audit.py, fist.py, recolor.py …`), `lowpoly_skeleton\`, `quaternius_units\`, `hg_concepts_2026-10-11\` (80 концептов, `roles.json`, `tiers.md`), `build\`, `build2\`, `pilot*`, `cloth_pilot\`, `actionforge_*`, `quaternius_zip\` |
| `ComfyUI-Pixal3D\` | см. выше |

Структура ассета (пример) `library\assets\<uuid>\{asset.json, source\source.glb, v001\{version.json, asset.snapshot.json, 01_cleanup\…, 06_render_sprites\…, 07_godot_package\…}, exports\{godot-v001.zip, heroes_gates-v001.zip}}`.

## Игры владельца (для `games.md`)

| Проект | Путь |
|---|---|
| Врата Героев | `C:\Dorn\Dops media\heroes-gates` (main), копии ролей `C:\Dorn\Dops media\heroes-gates_worktrees\{art,audio,combat,meta,review,server,tests,ui,ui_ux_backup}`; материалы `heroes-gates_incoming`, `heroes-gates_web`, `heroes-gates_desktop`, `heroes-gates_backups` |
| Space Quest | `C:\Dorn\Dops media\space_quest` (main), `space_quest_worktrees\` |
| Душа | `C:\Dorn\Dops media\dusha` (+ `dusha.exe`) |
| SOULBOUND MVP | `C:\Dorn\Dops media\soulbound_mvp` |
| Выпуски роликов | `C:\Dorn\Dops media\02 Проекты\Врата Героев - выпуск 01`, `…выпуск 02`, `Выпуск 03`, `…карточки` и др.; Godot-проекты кино — там же |

Obsidian-заметки: `C:\Dorn\DopsMedia\00 Dops Media\Проекты\astraforge-кузница.md`, `astraforge-vfx.md` (хранилище `C:\Dorn\DopsMedia`; второе хранилище — `C:\Users\doron\Documents\Obsidian Vault`).
Скиллы Claude: `C:\Users\doron\.claude\skills\{astraforge, astraforge-vfx, codex-image, local-image-generation, …}`. Память: `C:\Users\doron\.claude\projects\C--Dorn-Dops-media-heroes-gates\memory\`.

## Как переснять снимок (только чтение)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\doron\.claude\skills\astraforge\scripts\af_status.ps1
nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,compute_cap --format=csv
ollama list
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 3210,3211,8188,8190,8191,11434
Get-ChildItem C:\AstraForge\library\animations\quaternius -Filter *.fbx | Measure-Object     # 86
Get-ChildItem C:\AstraForge\library\animations\mixamo -Filter *.fbx | Measure-Object         # 38
```
