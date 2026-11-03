# Вкладка «VFX»: генераторы текстур для эффектов

Каталог взят из раздела «Texture Generators» базы Simon Schreibt
[Textures for VFX](https://simonschreibt.notion.site/Textures-for-VFX-Database-2c72eccccfa84a0eae927d778ad746cc)
(доклад GDC «How (not) to create Textures for VFX»): 31 инструмент. Список с лицензиями —
`server/vfx-tools-catalog.json`, он же источник для интерфейса и для скрипта установки.

## Что где

| Что | Где |
|---|---|
| Каталог | `server/vfx-tools-catalog.json` |
| Сервер (`/api/vfx-tools`) | `server/vfx-tools.mjs` |
| Веб-генераторы | `http://127.0.0.1:3211/vfx-web/<id>/` (`ASTRA_VFX_WEB_PORT`): отдельный порт, чтобы чужой JS не получил origin студии и её API |
| Интерфейс | `src/VfxPanel.jsx`, `src/vfx.css`, вкладка «VFX» в `src/App.jsx` |
| Установка | `scripts/vfx/Install-VfxTools.ps1`; в мастере — пункт «Генераторы VFX-текстур» (id `vfx`) |
| Папка инструментов | `ASTRA_VFX_TOOLS` (ключ `vfxTools` в `config/paths.json`), по умолчанию `C:\AstraForge\tools\vfx`; мастер ставит в `runtime\vfx` |

Внутри папки инструментов: `apps/` — портативные программы, `downloads/` — установщики, `web/` — веб-генераторы,
`textures/` — готовые текстуры. Вкладка показывает эту папку и умеет накладывать текстуры из неё на выбранный объект.

## Виды инструментов

- **Программы** (запуск из вкладки): Material Maker 1.7 (MIT), FlowMap Painter 0.9.2, Pseudo Volume Generator 2.7.
- **С установщиком** (кнопка «Установить», затем «Запустить»): PixaFlux, KumoWorks 1.0.1 (BSD-3), Slate.
- **Веб-генераторы внутри студии**, работают без интернета: Texture Generator Online и NormalMap Online (MIT),
  Greeble/DisplacementX (GPL-3.0, собирается из исходников с `base: '/vfx-web/displacementx/'`), Neon Flames и SculptGL
  (MIT, собирается через webpack; та же страница служит вкладке «Скульпт», см. `docs/forge/sculpt.md`).
- **Заготовка** Impact Decal (CC0) открывается в Material Maker.
- **Онлайн**, платные, Substance Designer и уроки — только ссылки.

## Установка

```powershell
powershell -ExecutionPolicy Bypass -File scripts\vfx\Install-VfxTools.ps1            # всё
powershell -ExecutionPolicy Bypass -File scripts\vfx\Install-VfxTools.ps1 -DryRun    # только план
powershell -ExecutionPolicy Bypass -File scripts\vfx\Install-VfxTools.ps1 -Only material-maker,neonflames
```

Скрипт качает с официальных сайтов (GitHub, pixaflux.com, facedownfx, teckartist, materialmaker.org), уже
скачанное пропускает. Установщики только скачивает: запускает их пользователь. DisplacementX и SculptGL собираются через npm
(нужен Node.js; `-Only sculptgl` соберёт только скульпт). Pseudo Volume Generator itch.io отдаёт только через кнопку на сайте: положите
`3D Volume Generator 2.7 Win.zip` в `downloads` и запустите скрипт ещё раз.

## Ограничения

- Программы в архив AstraForge не входят, у каждой своя лицензия. Neon Flames опубликован без лицензии:
  только для личного использования, в сборку для продажи не включать.
- 16.10.2026: Fateloom не открывается, ссылки Flipped Normals (генераторы Martin Schmitter) отдают 404 —
  в каталоге они помечены `unavailable`.
- Бесплатные Smoke Trail Generator (Gumroad, $0+) и Free Seamless Textures Generator (the orange box) требуют
  оформить бесплатный заказ с e-mail, поэтому скачиваются вручную.

# Редактор эффектов (вкладка «Эффекты»)

Эффекты делаются прямо в студии, без внешних программ:

1. Выберите объект или кость модели → вкладка «Эффекты» → пресет (12 из `scripts/blender/data/fx_presets.json`:
   шлейф двигателя, аура, огонь, дым, искры, лёд, яд, лечение, вспышка выстрела и др.) или «Пустой».
2. Эффект встаёт эмиттером в дерево объектов под выбранную деталь (иконка ⚡). Его маркер двигается гизмо
   (W/E/R), масштаб эмиттера меняет размер частиц. Частицы идут живьём на паузе и по таймлайну при воспроизведении
   и записи WebM.
3. Параметры правятся сразу во вьюпорте: испускание, форма, движение, вид (размер, кривая, градиент цвета,
   смешивание), текстура, флипбук, свет. Ctrl+Z отменяет правки.
4. Текстура: 5 встроенных, «Из папки VFX», «С диска» или «Создать текстуру в генераторе» — встроенный генератор
   (10 типов, 20 рецептов: свечение, искра, звезда, кольцо/ударная волна, дым, пламя, молния, шумы, шлейф,
   магический круг; флипбуки 2×2/4×4/8×8, бесшовные шумы). «Использовать в эффекте» сохраняет PNG в ассеты и
   назначает выбранному эффекту вместе с раскладкой флипбука.
5. Эффекты сохраняются в проекте. «ZIP для Godot 4.5» выгружает `fx/*.tscn` (GPUParticles3D, как в «Кузнице»),
   текстуры, `fx_bindings.json`, `af_fx_mount.gd` и README. В GLB эмиттеры попадают пустыми узлами с параметрами
   в extras.

Код: `src/fx-core.js` (формат `astraforge-fx/1`, частицы, .tscn — побайтно как `_export_lib.py`),
`src/fx-runtime.js` (отрисовка), `src/FxPanel.jsx`, `src/fx-textures.js` + `src/FxTextureLab.jsx` (генератор),
копия пресетов для браузера — `src/fx-data.js` (тест сверяет её с `scripts/blender/data`; обновить:
`FX_SYNC=1 node --test tests/fx-core.test.mjs`).
