# Проверка лица по референсу — шаги `face_match` и `face_fix_loop` (17.10.2026)

Покраска головы по концепту (`paint_from_concept`) и перепроекция крупных планов дают лицо, которое *похоже*
на референс, но не совпадает с ним: глаза разной высоты, рот бледнее и сдвинут, волосы «просвечивают».
Эти два шага закрывают цикл: проверяльщик измеряет расхождение с крупными планами головы и выдаёт
**машинно-исполнимые указания**, исполнитель их применяет, проверка повторяется — до pass, лимита итераций
или плато. Требование владельца (17.10): результат проверяется на соответствие референсу, пока не готово —
отправляется на доработку с конкретными указаниями.

Файлы: `scripts/qa/face_match.py` (проверяльщик), `scripts/qa/face_fix.py` + `face_fix_bl.py` (исполнитель),
`scripts/qa/face_loop.py` (цикл), `scripts/qa/face_views.py` (общие ракурсы, камера, зоны), `scripts/qa/face_step.py`
(обёртка шагов кузницы), тонкие модули шагов `scripts/blender/steps/face_match.py` и `face_fix_loop.py`,
регистрация — `server/forge-steps.mjs`, тесты — `tests/forge-face.test.mjs`. Подробности алгоритма и калибровка —
`scripts/qa/README.md`.

## Что проверяет

Референсы — крупные планы головы на прозрачном фоне (как рисует GPT по концепту): `face_front_rgba.png` (анфас),
`face34_rgba.png` (3/4 слева), `face34_flip_rgba.png` (3/4 справа), `head_back_rgba.png` (затылок). Обязателен анфас,
остальные ракурсы — по наличию (нет файла — ракурс пропускается с предупреждением).

1. **Рендер** модели ортокамерой с тех же ракурсов (Blender, Workbench FLAT + TEXTURE, прозрачный фон, 1600 px);
   знак поворота 3/4 подбирается по референсу.
2. **Выравнивание** рендера по референсу: силуэт головы (масштаб + сдвиг), уточнение ECC; кадр 800×800. С
   `frame_from` / внутри цикла кадр берётся из первого отчёта и дальше не ищется (иначе сдвиг кадра маскировал бы
   правки покраски).
3. **Метрики на ракурс**: `ssim_gray` (структурное сходство по серому), `silhouette_iou` (силуэт головы),
   `feature_mask_iou` (кожа / волосы / повязка / тёмные черты по k-means Lab), `landmark_offsets_px` (глаза, брови,
   нос, рот, подбородок), `diff_area_share` (доля площади головы с ΔE > 16 после размытия), при наличии Ollama —
   ответы `qwen3-vl` да/нет (лицо читается, глаза симметричны, рот виден, повязка на лбу, волосы сплошные, нет
   размазни, тот же человек).
4. **Балл 0–100**: ракурс — ssim 0,25 / маски 0,20 / смещения черт 0,20 / разница 0,20 / силуэт 0,10 / VLM 0,05;
   итог — анфас 50 %, 3/4 по 20 %, затылок 10 %.
5. **Дефекты и указания**: каждое расхождение — запись `defects[]` с зоной (`left_eye`, `mouth`, `hair_left`, …),
   видом (`texture_smear`, `feature_shift`, `colour_off`, `hole`, `geometry_shape`, …), тяжестью
   (blocker / major / minor), координатами в кадре 800 и указанием `instruction.action` + фразой по-русски.

Выход проверяльщика — `face_report.json` (контракт выше) и лист `face_report.jpg`: сверху референсы с найденными
чертами, снизу рендеры с рамками дефектов, справа тепловая карта разницы.

### Пороги pass

| порог | по умолчанию | смысл |
|---|---|---|
| `ssim_gray` | ≥ 0,85 | структурное сходство по серому |
| `feature_mask_iou_min` | ≥ 0,80 | IoU каждой маски черт (кожа, волосы, повязка, тёмные детали) |
| `landmark_max_px_share` | ≤ 0,02 | наибольшее смещение черты, доля высоты лица (не для затылка) |
| `diff_area_share_max` | ≤ 0,01 | доля площади головы с заметной разницей цвета |
| `silhouette_iou` | ≥ 0,93 | IoU силуэта головы |

`pass` = все ракурсы прошли все пороги **и** нет дефектов blocker / major. Пороги переопределяются параметром
`thresholds` (любые из пяти; значения — доли 0..1). Известный предел: эталоны анфас и 3/4 нарисованы GPT независимо
и не согласованы в 3D, поэтому одна текстура не совпадает со всеми четырьмя сразу; лучший прогон лучника (v5,
8 итераций) — балл 56,8, анфас 70,6 при смещении черт 0,0 % — pass по умолчанию не достигнут. Для конвейера есть
`min_score`: балл не ниже него считается достаточным.

## Какие указания умеет выполнять исполнитель (`face_fix.py`)

Порядок применения в одной итерации: `geometry_fit` → `geometry_warp` → `reproject` → `inpaint_from_ref` →
`recolor` → `palette_lock` → `fill_seam` → `blend_cut`.

| `action` | что делает |
|---|---|
| `reproject` | перепроецировать эталон ракурса на текстуру головы (камера проверяльщика + поправка `dx, dy`); все `reproject` целиком одной итерации применяются совместно с приоритетом анфаса (до 60°, спад до 80°), 3/4 докрашивают оставшееся, затылок — остальное |
| `inpaint_from_ref` | перенести фрагмент эталона по маске зоны (`zone_mask` PNG или bbox) |
| `geometry_warp` | сдвинуть сетку / текстуру в зоне (`warp.dx_px / dy_px / falloff_px`): контур волос, челюсть |
| `recolor` | перекрасить зону в цвет эталона (`target_rgb`) |
| `fill_seam` | залить шов цветом соседей |
| `geometry_fit`, `palette_lock`, `blend_cut` | служебные: подгонка силуэта головы под эталон, замок палитры (волосы / повязка / кожа только своих цветов), сшивка среза головы с телом |

Каждый дефект применяется один раз: ключ «итерация:id:действие» пишется в историю модели
(custom property `face_fix_history`), повторный прогон того же отчёта ничего не меняет.

Исполнитель ищет голову по материалу **`Head`** (у лучника v4/v5 голова отрезана по z = 1,515 со своей UV и картой
2048); если такого материала нет, работает по всей сетке модели (грубее: голова занимает малую часть карты тела).

## Шаги кузницы

Оба шага — модуль `qa` реестра (`GET /api/forge/steps`), вид `humanoid`, вход `inputs.blend` (предпочтительно) или
`inputs.mesh` (GLB). Сам расчёт идёт отдельным Python с numpy / cv2 / scikit-image / scipy
(`params.python` → `IMAGINARIUM_QA_PYTHON` → `D:\ComfyUI\.venv\Scripts\python.exe`); Blender для рендеров — тот же, что
выполняет шаг. Видеокарту шаги не блокируют: перед опросом модели зрения проверяльщик сам выгружает модели ComfyUI
(`POST :8191/free`), как `paint_from_concept`.

### `face_match` — ворота

| параметр | по умолчанию | смысл |
|---|---|---|
| `refs_dir` | пусто | папка референсов лица (путь, только CLI `--direct` / `request.json`); пусто — `face_refs/` рядом с ассетом (`<library>/assets/<id>/face_refs/`) или с моделью |
| `gate` | true | не прошедшее лицо валит шаг (`ok=false`, конвейер останавливается); false — только предупреждение |
| `min_score` | пусто | балл не ниже этого — достаточно и без pass |
| `vlm` | auto | `auto` — qwen3-vl в Ollama, если доступна; `off` — только геометрия и цвет; `strict` — ответы «нет» блокируют pass |
| `vlm_model` | пусто | модель Ollama (qwen3-vl:8b) |
| `thresholds` | пусто | переопределение порогов, см. таблицу |
| `iteration` | 0 | подпись в отчёте и ключ истории исправлений |
| `frame_from` | пусто | `face_report.json` предыдущей проверки: кадр берётся из него (путь) |
| `python` | пусто | интерпретатор проверки (путь) |

Выходы: `face_report` (JSON), `face_report_jpg` (лист), `face_match_dir` (выровненные кадры `ref_*.png` /
`render_*.png`, маски, сырые рендеры). Проверка `face_match_pass` (severity `error` при `gate`, иначе `warning`);
`stats`: балл, pass, по ракурсам — балл и список не пройденных порогов, счётчики дефектов, первые 12 указаний по-русски.
Модель по конвейеру дальше идёт прежняя (шаг ничего не меняет). Время: ~45 с без модели зрения, ~3 мин с ней.

### `face_fix_loop` — цикл до pass

| параметр | по умолчанию | смысл |
|---|---|---|
| `refs_dir` | пусто | как у `face_match` |
| `max_iter` | 6 | итераций «проверка + доработка» (1–30) |
| `plateau` | 2 | стоп, если балл не растёт столько итераций подряд |
| `require_pass` | false | true — без pass `ok=false`; false — дальше идёт лучшая модель, расхождение остаётся предупреждением |
| `min_score` | пусто | с `require_pass`: балл не ниже этого тоже успех |
| `vlm`, `vlm_model`, `thresholds`, `python` | — | как у `face_match` |
| `body_refs_dir` | пусто | `ref_front.png`, `ref_back.png` для общего листа; пусто — `mv/` рядом с папкой референсов лица |

Итерация: `face_match` (кадр первой итерации фиксируется) → `iter_XX/check/face_report.json` → если не pass,
`face_fix` → `iter_XX/fix/painted.blend` → следующая. В конце лучшая модель копируется в `best/`
(`painted.blend`, GLB, `face_report.json/.jpg`) и собирается `best/texture_check.jpg` (перед, спина, анфас, 3/4:
референс сверху, модель снизу). Выходы: `blend`, `glb` (лучшая модель — **она идёт дальше по конвейеру**, например в
`rig_humanoid`), `face_report`, `face_report_jpg`, `texture_check`, `loop_state` (история баллов), `loop_log`,
`loop_dir`. Проверка `face_loop_pass`; `stats`: `score_history`, `best_iteration`, `iterations`, `plateau`.
Повтор шага в той же папке продолжает цикл (`--resume`), а не начинает заново.

### Пресет

`humanoid_face_checked` — «Гуманоид по референсу: покраска с проверкой лица»:
`cleanup` (40 000 тр., 1,8 м) → `paint_from_concept` → `face_fix_loop` (6 итераций) → `rig_humanoid` → `retarget`
(покой, шаг, атака, удар, смерть; root motion) → `godot_package`. Пресет `humanoid_from_mesh` не менялся.

## Как запустить

**Из командной строки, без кузницы** (venv ComfyUI):
```
D:\ComfyUI\.venv\Scripts\python.exe scripts\qa\face_match.py --model <painted.blend|glb> --refs <in/> --out <папка> [--no-vlm] [--strict] [--thresholds "{\"ssim_gray\":0.8}"]
D:\ComfyUI\.venv\Scripts\python.exe scripts\qa\face_loop.py --start <painted.blend> --refs <in/> --work <папка> [--max-iter 8] [--no-vlm] [--resume]
```
Коды возврата `face_match.py`: 0 — pass, 1 — fail, 2 — ошибка; `face_loop.py`: 0 — pass, 1 — лимит, 2 — ошибка,
3 — плато.

**Шаг кузницы вручную** (тот же протокол, что у Blender-шагов: `result.json` + строка `IMAGINARIUM_RESULT`):
```
py -I scripts\qa\face_step.py run face_match <request.json>
py -I scripts\qa\face_step.py run face_fix_loop <request.json>
"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" -b --factory-startup --python scripts\blender\imaginarium_run.py -- face_match <request.json>
```
`request.json`:
```json
{
  "inputs": {"blend": "C:/Imaginarium/incoming/units_1013/archer/v5/best/painted.blend"},
  "params": {"refs_dir": "C:/Imaginarium/incoming/units_1013/archer/v3/in", "vlm": "off", "min_score": 50},
  "out_dir": "C:/Imaginarium/runtime/face_smoke/01_face_match"
}
```
Сводка готового отчёта: `py -I scripts\qa\face_step.py summary <face_report.json> [--min-score 50]` (код 0 — ворота
пройдены).

**Из кузницы** (`node scripts/forge.mjs`, флаг `--direct` — без сервера, пути разрешены):
```
node scripts/forge.mjs create --kind humanoid --name "Лучник" --from-glb archer.glb --preset humanoid_face_checked --direct
node scripts/forge.mjs run <assetId> --steps steps.json --direct
```
`steps.json`: `[{"step": "face_fix_loop", "params": {"refs_dir": "C:/.../v3/in", "max_iter": 6}}]`. Для пресета из
студии (HTTP пути не принимает) положите референсы в `<library>/assets/<id>/face_refs/` — шаг найдёт их сам.
Журнал шага в студии показывает строки проверяльщика (балл по ракурсам, указания) и прогресс по итерациям.

## Проверено (17.10.2026)

- `npm test`: 301 проверка зелёные (было 299; +2: реестр / пресет и разбор `face_report.json`).
- `face_match` через `imaginarium_run.py` в Blender 5.0.1 на `v5/best/painted.blend` без модели зрения: 46 с, балл 57,5,
  4 blocker + 7 minor, `IMAGINARIUM_RESULT ok=true` при `min_score 50`, выходы на месте.
- `face_fix_loop` отдельным Python (`face_step.py run`), 2 итерации без модели зрения, `thresholds {ssim_gray: 0.8}`,
  `min_score 50`: 64 с, баллы 57,5 → 54,0, лучшая — итерация 1 (та же модель), `best/` с `painted.blend`,
  `archer_painted.glb`, `face_report.json/.jpg`, `texture_check.jpg`; `ok=true`, проверка `face_loop_pass`
  предупреждением, в `warnings` — «pass не достигнут за 2 итерации». Прогресс по итерациям виден в IMAGINARIUM_LOG (`done/total`).
