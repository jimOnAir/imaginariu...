# Тесты в фоне, отчёты, ошибки

## Что делает `engine_test`

| Движок | Шаги (без окон) | Время |
|---|---|---|
| Unity | 1) `-batchmode -executeMethod AstraForge.Editor.AFBatch.Validate`: все пакеты `Assets/AstraForge/*` — префаб, «нет розового», материалы на модели, размер и углы как в паспорте, Avatar, клипы и петли, анимация двигает кости, сокеты, эффекты, коллайдер, LOD, спрайты, ошибки консоли; `shots` — скриншоты через URP и `contact_sheet.png`. 2) `-runTests -testPlatform EditMode` (и `PlayMode` при `playMode`) — NUnit XML разбирается в цифры | 15–25 с на запуск Unity |
| Godot | 1) `--headless --import`. 2) `af_engine_check.gd`: каждая сцена `res://astraforge` и `res://scenes` (и главная) грузится, создаётся и работает 120 кадров; число узлов и мешей, размер геометрии, анимации и петли; строки `ERROR` / `SCRIPT ERROR` из вывода. 3) `res://tests/run_tests.gd`, если есть: код выхода = число провалов. 4) `shots` — кадр каждой сцены в окне на позиции −30000, −30000 | 3–10 с |

Отчёт: `C:\AstraForge\engines\reports\<игра>_<время>\` — JSON, журналы, `tests_*.xml`, `shots/`.

Опорные цифры 31.10.2026 на демо «AF Demo»:

- Unity: 4 пакета OK (лучник Humanoid, костёр, дерево, заяц), EditMode 2/2, 13–22 с.
- Godot: 3 сцены OK, `run_tests` 5/5, кадры сняты.
- Размеры ассетов в Unity и Godot совпадают до 1 мм.

## Как писать свои тесты

- **Unity (EditMode, быстро, в фоне).** Логика с публичным `Tick(dt)` / `Init()`: тест создаёт префаб через
  `PrefabUtility.InstantiatePrefab`, двигает время вызовами `Tick` и проверяет состояние. Код игры — в
  `Game.asmdef`, тесты — в `Game.Tests.asmdef` (`UNITY_INCLUDE_TESTS`, `nunit.framework.dll`). PlayMode —
  только для физики и корутин (`playMode:true`, дольше).
- **Godot.** `res://tests/run_tests.gd` (`extends SceneTree`): собрать узлы, вызывать `tick(delta)`,
  `_check(cond, "что")`, `quit(число провалов)`. Для проектов с GUT — инструмент `run_tests` сервера `godot`.
- Тесты проверяют поведение (сдвинулся, сменился клип, сработал триггер, квест засчитан), а не пиксели.
  Скриншоты — для глаз владельца.

## Ошибки и что делать

| Признак | Причина | Что делать |
|---|---|---|
| Unity: «No valid Unity Editor license» | Hub вышел из аккаунта | владелец входит в Unity Hub |
| `open_in_editor: true` | проект открыт в Unity | `UnityMCP` (`run_tests`, `read_console`) или попросить закрыть |
| `EditMode result: NoResults` | нет Test Framework или ошибка компиляции | журнал `tests_EditMode.log`, ищи `error CS`; пакет `com.unity.test-framework` в шаблоне URP есть |
| `error CS0246 … InputSystem` | в проекте нет пакета Input System | убрать `Unity.InputSystem` из `Game.asmdef` (код переключится на старый `Input`) |
| Godot `SCRIPT ERROR` / `Parse Error` | ошибка GDScript | `validate_script` сервера `godot`, исправить, повторить |
| Godot: сцена `not loaded` | битый путь или пакет не импортирован | `engine_send` заново (запускает `--import`), проверить `res://astraforge/<id>/` |
| Кадр Godot не снят | нет GPU-контекста | повторить; рабочая проверка — headless-часть |
| `UnityMCP` / `godot` нет в сессии | запись выпала из `~/.claude.json` или новая регистрация | `engine_mcp_register` и новая сессия |
| Розовое в Unity | шейдер не того пайплайна | `materials_no_pink` назовёт материал; импортёр выбирает шейдер по активному пайплайну — проверить `GraphicsSettings` проекта |
