# Самообучение Кузницы: журнал, вердикты, рецепты классов

Кузница запоминает, как сделан каждый ассет и что о нём сказали, и сама выводит из этого **рецепт класса** — лучшие
известные параметры шагов для «зомби», «орудия», «здания»… Следующий ассет того же класса стартует с рецепта, а не с
умолчаний шага. Код — `server/forge-learn.mjs`; встроено в `server/forge-pipeline.mjs` (запуск и журнал),
`server/forge.mjs` (маршруты), `scripts/forge.mjs learn`, MCP (`ai/mcp/server.mjs`), «Приёмка» → «Журнал и рецепты»
(`src/forge/ForgeLearn.jsx`). Порядок работы агента — скилл `ai/skills/imaginarium-learn`.

## Файлы

Всё в библиотеке, рядом с паспортами: `<library>/learning/` (по умолчанию `C:\Imaginarium\library\learning`).

| Файл | Что | Запись |
|---|---|---|
| `journal.jsonl` | одна строка на завершённый шаг (`completed` / `failed`) | движок после каждого шага; `learn sync` — из `jobs/*.json` |
| `feedback.jsonl` | одна строка на вердикт к версии ассета | «Приёмка», API, CLI, MCP |
| `knowledge.json` | `pinned` (закреплённые рецепты), `classes` (свои правила классов), `notes` (путь / грабли / совет) | `learn pin`, `learn note`, `POST /learn/classes` |

Строки журнала и отзывов только дописываются (одна запись — одна запись на диск, процессы сервера и CLI не мешают друг
другу); чтение кешируется по времени и размеру файла. Для одной строки журнала (`id` = `<jobId>:<index>`) действует
последняя запись.

### Строка журнала

```json
{ "v": 1, "type": "run", "id": "54cbb871-…:1", "at": "2026-10-31T08:32:42Z", "seconds": 7.6, "renderSeconds": 6.48,
  "jobId": "…", "assetId": "…", "assetName": "learn_demo_zciv_granny", "kind": "prop", "class": "zombie", "classFrom": "rule:zombie",
  "version": "v001", "index": 1, "step": "render_sprites", "variant": "pixel", "stepKey": "render_sprites@pixel",
  "status": "completed", "params": { …явные параметры шага, вместе с подставленными рецептом… },
  "recipe": { "params": { "levels": true, … }, "from": { "levels": "zombie:journal", … }, "layers": [ … ] },
  "checks": [ { "name": "cell_fit", "ok": true, "severity": "error", "value": 0 }, … ], "failed": [],
  "previews": [ { "path": "C:\\…\\preview.png", "url": "/api/forge/assets/…/files/v001/01_render_sprites/preview.png" } ],
  "error": null, "warnings": [], "host": "cli", "source": "live" }
```

### Строка отзыва

```json
{ "v": 1, "type": "feedback", "id": "…", "at": "…", "group": null, "assetId": "…", "assetName": "zciv_granny", "kind": "prop",
  "class": "zombie", "version": "v001", "step": "render_sprites", "verdict": "rejected", "rating": 2,
  "tags": ["washed_out"], "comment": "levels false + saturation 0,85 — блёкло", "by": "owner", "source": "review" }
```

`verdict`: `accepted` (принято), `rework` (на доработку), `rejected` (брак), `cleared` (снять прежний). Принимаются и
русские слова: «принято», «брак», «доработка». `group` — общий id вердикта пачке (`targets`). Версия по умолчанию —
последняя, у которой есть запуски. Теги — из каталога (`GET /learn` → `tags`) или свои слова; в комментарии к браку
студия сама находит слова каталога («кислотн…» → `acid_colors`).

## Класс ассета

1. класс запуска: `assetClass` в теле `run` / `plan` (CLI `--class`);
2. `profile.class` паспорта (`create --profile '{"class":"boss"}'`, `PATCH /assets/:id {profile:{class}}`);
3. первое правило, подошедшее к имени ассета или исходного файла: свои (`knowledge.json` → `classes`, тот же `id`
   заменяет встроенное) и встроенные — `building` (`^bld_|building|^house|apartment|здани|^дом`, реквизит и предметы),
   `zombie` (`zciv_|zomb|зомби|^z_`), `weapon` (`weapon|turret|gatling|cannon|flamer|rocket|gun|орудие…`, кроме персонажей),
   `vehicle` (`^car_|vehicle|truck|машин`), `tree`;
4. вид ассета: `humanoid`, `creature`, `item`, `ship`, `prop`.

Класс, найденный правилом или видом, пересчитывается при чтении журнала текущими правилами: правка правила действует и на
старые запуски. Класс из паспорта или запуска остаётся.

## Рецепт и грабли

Запуски группируются по `класс | шаг@профиль`. Из параметров запуска в рецепт идут только стиль и качество: пути,
`asset_id` и другие заполняемые сервером ключи, клипы (`clips`, `loop`, `ranges`, `frames` по клипам…), размеры
(`height_m`, `length_m`), `seed`, ссылки на ассеты не входят.

У каждого набора параметров — балл по вердиктам его запусков: `accepted` +1, `rework` −0,5, `rejected` −1, оценка
добавляет (оценка − 3) × 0,1; запуск, остановленный красными проверками без вердикта, −0,5. Для запуска берётся
последний вердикт его версии, относящийся к его шагу: вердикт с `step` — только к этому шагу; без `step` — к шагам, на
которые указывают теги (если они есть в версии), иначе ко всем шагам версии.

**Рецепт** — набор с наибольшим баллом среди тех, у которых есть «принято» и балл > 0 (при равенстве — более свежий).
**Грабли** — остальные наборы с браком, доработкой или красными проверками, с отличием от рецепта по ключам.

### Подстановка в запуск

`startRun` и `planRun` после проверки шагов (`normalizeSteps`, `applyProfileSize`) вызывают `learn.applyRecipes`:

- слои от общего к частному: `*` → вид ассета → класс; на каждом уровне сначала рецепт журнала, затем закреплённый;
  ключи частного слоя главнее;
- подставляются **только ключи, которых нет в шаге** — явные параметры и параметры пресета всегда главнее;
  `profile` рецепт не меняет (рецепт `render_sprites@pixel` не превратит iso8 в pixel);
- итог проходит `normalizeParams`; неподходящий рецепт пропускается с предупреждением;
- что подставлено и откуда, записано в задаче (`learned`, `recipeNotes`, `steps[].recipe`), в ответе запуска и в строке
  журнала; `recipes: false` в теле запуска (CLI `--no-recipes`) отключает подстановку.

## API (`/api/forge`)

| Маршрут | Что |
|---|---|
| `GET /learn` | классы в журнале, число запусков и отзывов, каталог тегов, правила классов |
| `GET /learn/journal?class=&step=&stepKey=&assetId=&version=&limit=` | строки журнала, новые сначала |
| `GET /learn/versions?class=&step=&assetId=&pending=1&limit=` | версии ассетов: шаги, превью, последний вердикт |
| `GET /learn/feedback?assetId=&version=` | отзывы |
| `POST /learn/feedback` | вердикт: `{assetId, version?, step?, verdict, rating?, tags?, comment?, by?}` или `{targets:[{assetId, version?}], …}`; ответ `201 {ok, count, feedback}`; решение показывается на карточке «Приёмки» (`qa.decision`), если вердикт к последней версии |
| `POST /assets/:id/feedback` | то же для одного ассета |
| `GET /learn/recipes?class=` | рецепты, грабли, закреплённые рецепты и заметки |
| `GET /learn/digest?class=` | то же в Markdown (`text/markdown`) |
| `POST /assets/:id/plan` | тело как у `run` (+ `assetClass`, `recipes`): итоговые шаги и что подставил рецепт, без новой версии |
| `POST /learn/pin` | `{class, step, variant, params, note}`; `params: null` снимает |
| `POST /learn/notes`, `DELETE /learn/notes/:id` | заметка `{class, kind: route|pitfall|tip, text, steps}` |
| `POST /learn/classes` | правило класса `{id, title, match, kinds}` |
| `POST /learn/sync` | дописать в журнал шаги из `jobs/*.json`, которых там нет |

Решение «Приёмки» (`PATCH /assets/:id` с `qa.decision`) тоже записывается в отзывы (`source: "review"`, теги — из
пресетов «Что не так?»).

## Командная строка и MCP

`node scripts/forge.mjs learn [journal|versions|feedback|recipes|plan|pin|note|sync|digest]`, у `run` — `--class` и
`--no-recipes` (справка — `--help`). MCP: `forge_feedback`, `forge_recipes`, `forge_journal`, `forge_plan`,
`forge_recipe_pin`, `forge_learn_note`. Если работающая студия ещё без маршрутов `/learn` (запущена старым кодом) или
выключена, CLI и MCP работают с файлами библиотеки сами; вердикт в этом случае не пишется в паспорт (паспорт пишет
только процесс сервера).

## «Приёмка» → «Журнал и рецепты»

Переключатель вверху вкладки «Приёмка»: «Персонажи» (прежняя приёмка пакета) и «Журнал и рецепты». Во втором — выбор
класса, флажок «только без отзыва», панель «Рецепты и грабли» класса и карточки версий: превью, шаги с итогом проверок и
меткой «рецепт», последний вердикт, кнопка «Отзыв» (вердикт, оценка звёздами, теги брака, шаг, комментарий).

## Первые записи (31.10.2026, «Квартал 30»)

- `learn sync` перенёс в журнал 2 797 запусков из 1 244 задач библиотеки.
- Вердикты владельца по пиксель-спрайтам зомби (`zombie · render_sprites@pixel`): проход 1 — умолчания `levels` и
  `saturation 1,2` — брак «кислотные цвета» (25 версий); проход 2 — `levels false`, `saturation 0,85` — брак «блёклые
  цвета» (24); проход 3 — `levels true`, `saturation 1,0`, `outline dark` — принято (24). Рецепт класса — проход 3.
- Дома Pixal3D с покраской по концепту (`bld_*`, 15 ассетов) — брак «фольга»; заметки класса `building`: путь —
  `scripts/buildings/city_bldg.py` и `mesh_fracture.py --grid`.
- Закреплённый рецепт `* · render_sprites@pixel`: `levels true`, `saturation 1`, `outline dark` (мелкие пиксель-спрайты).
- Пути классов `zombie` (`scripts/units/zombie_gen.py`, пачка `tools/zombie_forge.mjs` игры) и `weapon`
  (`props_gen.py weapon_*`, 16 сторон через `directions`).
- Проверка подхвата: ассет `learn_demo_zciv_granny` (`84b53df6-…`) отрисован с шагом `render_sprites {profile: pixel,
  clips: [walk]}` — рецепт класса дописал `levels`, `saturation`, `outline`, `elevation_deg`, `pixels_per_meter`,
  `colors`, `supersample`, `forward`, `min_body_px`, `fps`; 13 проверок зелёные, строка журнала записана.

## Тесты

`tests/forge-learn.test.mjs` (9 тестов, заглушка вместо Blender, временная библиотека): помощники, классы, строка журнала
на каждый шаг (в том числе с красными проверками), проверка и хранение отзыва и его показ в «Приёмке», расчёт рецепта и
граблей, подхват рецепта следующим запуском (явные главнее, `recipes:false`, чужой класс), закреплённые слои, `sync`,
маршруты HTTP. Запуск: `node --test tests/forge-learn.test.mjs`.
