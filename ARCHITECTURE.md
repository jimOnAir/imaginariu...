# Устройство и развитие AstraForge

## Реализовано

React + Three.js → Express на 127.0.0.1:3210 → отдельный ComfyUI на 127.0.0.1:8190. SDXL создаёт концепт по тексту, rembg/U2Net убирает фон на CPU и вписывает объект в белый квадрат, Hunyuan3D 2.0 строит меш по изображению. Существующий ComfyUI на 8188 не перенастраивается. Сцена, материалы, трансформации, ключевые кадры, готовые клипы и частицы исполняются в браузере. Сохранённые меши без нормалей получают рассчитанные нормали перед отображением.

Адаптер LLM поддерживает Ollama, OpenAI Chat Completions и Anthropic Messages. LLM возвращает JSON с ограниченным набором действий; Zod проверяет их до применения. Она не выполняет Blender Python, shell или произвольный JS. Сервер хранит ключи в DPAPI; клиент получает только признак подключения.

`data/assets` — изображения и GLB; `data/jobs` — очередь и завершённые задания; `data/projects` — сцены с геометрией; `data/exports` — экспортированные файлы; `data/runtime` — отдельные каталоги ComfyUI и журналы; `data/models` — веса. Веса должны оставаться вне Git и архивов исходного кода.

## Выбор генератора

На текущем ПК RTX 4070 12 ГБ и около 64 ГБ RAM. Hunyuan3D 2.0 выбран как практический вариант: он уже поддерживается установленным ComfyUI и имеет официальные требования около 6 ГБ VRAM для геометрии. [Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2#-models-zoo), [официальный workflow ComfyUI](https://docs.comfy.org/tutorials/3d/hunyuan3D-2).

TRELLIS.2 — кандидат для более мощной GPU и детальной PBR-геометрии. Официальная реализация рассчитана на Linux и минимум 24 ГБ VRAM. Пониженные режимы сторонних сборок не проверены на этом компьютере. [Microsoft TRELLIS.2](https://github.com/microsoft/TRELLIS.2#prerequisites).

Hunyuan3D 2.1 предлагает улучшенные PBR-текстуры, но официальные требования составляют 10 ГБ для формы и 21 ГБ для текстур. Поэтому нельзя обещать полный стандартный pipeline на 12 ГБ. [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1#-models-zoo).

TripoSR — потенциальный облегчённый режим быстрых черновиков. В текущую версию не установлен: основной pipeline уже проходит через Hunyuan3D без дополнительных CUDA-зависимостей. [TripoSR](https://github.com/VAST-AI-Research/TripoSR).

## Следующие этапы

1. **Blender bridge.** Отдельный локальный worker с ограниченными операциями импорта/экспорта, decimate, remesh, UV, bake и подготовкой скелета. Операции должны иметь отмену, сохранение версии и проверку результата. Произвольный Python от LLM не выполнять.
2. **Существа.** Проверка анатомии и симметрии, разделение меша, ручная правка скелета, веса, автоскиннинг и библиотека движений. Человеческие шаблоны не решают автоматически риг драконов и многоногих существ. Нужны разные типы скелетов и возможность ручной корректировки.
3. **Предметы и корабли.** Многовидовой концепт, разделение корпуса/крыльев/двигателей, симметрия, жёсткие рёбра, отдельные pivot, анимация механизмов. Генеративный меш требует проверки и ретопологии перед использованием в игре.
4. **Текстуры.** Изолированный Hunyuan3D-Paint worker, последовательная загрузка геометрии и текстур, проверка VRAM, UV и упаковка PBR. Нужно отдельно сравнить качество и время на 12 ГБ; при нехватке памяти предусмотреть внешнюю GPU по явному выбору пользователя.
5. **Эффекты.** Эмиттеры, привязанные к объектам и костям; собственные параметры рождения/жизни/скорости; дым, огонь, bloom; экспорт описаний эффектов для игровых движков. GLB сам по себе не переносит произвольные частицы.
6. **Продуктовая упаковка.** Установщик, независимый управляемый runtime, обновление моделей с SHA-256, обработка переполнения диска, восстановление проекта, очереди и отмена LLM, визуальные регрессионные тесты, аудит лицензий перед распространением.

Это направления разработки, а не уже реализованные функции. Исходники разделены на `src/scene.js`, `src/animation.js`, `src/App.jsx` и серверные адаптеры `server/jobs.mjs`, `server/llm.mjs`, `server/runtime.mjs`.

## Реализовано в 0.3
Локальные UV: server/uv.mjs → scripts/unwrap_uv.py → xatlas, установленный в data/python. Результат remap сохраняет skin/morph/normal/colour. Текстуры: src/media-core.js, src/texture-bake.js, src/media-tools.js. Спрайты: отдельный WebGLRenderer с детерминированным AnimationMixer, PNG/JSON/.tres в ZIP. Хранилище проектов: server/projects.mjs, gzip JSON и metadata; старые JSON читаются.
Tripo: server/tripo-core.mjs проверяет операции и совместимость; server/tripo.mjs использует официальный SDK API v3, серверный DPAPI-ключ, историю, явную отправку и ограниченную загрузку результатов. Браузер не получает ключ. Интерфейс: src/TripoPanel.jsx. Генерация остаётся опциональной облачной; локальные инструменты не требуют Tripo.

# Reference fidelity update — 2026-10-10

Reference RGB/alpha and native crop metadata now survive independently of the geometry encoder image. `reference-core.js` supplies calibrated cameras, silhouette/colour metrics, bounded landmark warps and contour suggestions; `reference-tools.js` performs actual preview rendering and geometry updates. `ReferenceCompare.jsx` presents identical views, overlay, automatic camera calibration, proposed contour points, quality-gated deformation and aligned UV projection. All scores explicitly describe a single view rather than anatomical correctness.

The isolated runtime whitelists only the application's `AstraForgeMesh` node while other custom nodes remain disabled. `marching_mesh.py` extracts a Lewiner surface without artificial padding and checks orientation against the exterior. The workflow converts native level 0 to normalized voxel level 0.5 because the installed Comfy VAE wrapper applies `(x+1)/2` and clamping. Runtime logging uses inherited file handles so the worker can survive a web-server restart; explicit Stop still terminates the owned worker.

`mesh-validation.mjs` enforces generated GLB byte/count bounds before import. The optimizer creates a working mesh before UV/rigging. Re-extraction reuses the stored input and available runtime cache, with recomputation when that cache has expired. Failed diagnostic geometry is not offered as a completed character.

Detailed part reconstruction, validated unseen views, full neural PBR on this 12 GB device and anatomical acceptance are still incomplete. Code/data-level validity must not be presented as exact visual reference fidelity.
