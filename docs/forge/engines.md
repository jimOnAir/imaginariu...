# Модуль «engines»: AstraForge как интегратор Unity и Godot в Claude Code

AstraForge — студия ассетов (3D, риг, анимации, эффекты, спрайты) и интегратор игровых движков в Claude Code.
Агент проводит цепочку целиком:

**ассет студии → пакет движка → проект Unity или Godot → логика под ассет → тесты в фоне.**

Окна редакторов при этом не открываются.

| Слой | Где | Что |
|---|---|---|
| Скилл и агент | `ai/skills/astraforge-integrator` (junction в `~/.claude/skills`), `ai/agents/astraforge-integrator.md` (копия в `~/.claude/agents`) | как вести работу; карта инструментов; рецепты по видам ассетов; тесты; шаблоны кода |
| MCP `astraforge` | `ai/mcp/server.mjs` | студия + `engine_status`, `engine_project_create`, `engine_project_link`, `engine_send`, `engine_scaffold`, `engine_test`, `engine_mcp_register` |
| MCP `UnityMCP` | MCP for Unity 10.3.0 (CoplayDev, MIT), stdio, телеметрия выключена | живой редактор Unity: 48 инструментов, пока проект открыт |
| MCP `godot` | Godot MCP (Vollkorn-Games, MIT), `C:\Dorn\Dops media\tools\godot-mcp` | 75 инструментов; сцены и скрипты — headless-процессами Godot |
| CLI | `scripts/engines/af_engine.mjs` | `status`, `projects`, `create`, `link`, `send`, `scaffold`, `test`, `mcp-register` |
| Проверка Godot | `scripts/engines/godot/af_engine_check.gd` | сцены грузятся и работают N кадров; кадр из окна за пределами экрана |

## Команды

```
node scripts/engines/af_engine.mjs status
node scripts/engines/af_engine.mjs create --engine unity --name "AF Demo" --with-mcp     # ~70 с, batchmode
node scripts/engines/af_engine.mjs create --engine godot --name "AF Demo"                # ~3 с, headless
node scripts/engines/af_engine.mjs send --project "AF Demo" --engine unity <пакет unity | zip>
node scripts/engines/af_engine.mjs send --project "AF Demo" --engine godot <пакет godot | zip>
node scripts/engines/af_engine.mjs scaffold --project "AF Demo" --engine unity --kind player --asset archer_q
node scripts/engines/af_engine.mjs test --project "AF Demo" --engine unity --shots [--playmode]
node scripts/engines/af_engine.mjs test --project "AF Demo" --engine godot --shots
node scripts/engines/af_engine.mjs mcp-register
```

- Реестр: `C:\AstraForge\engines\projects.json` (имя игры, движок, путь, версии). У одной игры может быть и
  Unity-, и Godot-проект; `--engine` выбирает нужный. Свой проект владельца подключается командой `link`.
- Проекты по умолчанию: `C:\AstraForge\engines\projects\<Игра>_Unity|Godot`.
- Отчёты: `C:\AstraForge\engines\reports\<игра>_<время>\`.

## Как устроено

- **create Unity:** `Unity -batchmode -createProject <папка> -cloneFromTemplate` — шаблон «Universal 3D» лежит в
  редакторе, без сети. Затем `af_unity_send` ставит импортёр `com.astraforge.unity` (встроенный пакет), с
  `--with-mcp` — MCP for Unity в режиме stdio.
- **create Godot:** `project.godot` (config_version 5, 4.5, Forward+ / Mobile / GL Compatibility), папки
  `astraforge/`, `scenes/`, `scripts/`, `tests/`, затем `--headless --import`.
- **send:**
  - Unity — пакеты профиля `unity` (`af_unity.json`): см. `unity.md`.
  - Godot — пакеты `godot` / `space_quest` (`af_package.json`) в `res://astraforge/<id>/` и `--import`.
  - Файлы перезаписываются на месте; `.meta` и `.uid` остаются, поэтому ссылки не рвутся.
- **scaffold `player`:** шаблоны `ai/skills/astraforge-integrator/templates/<engine>`, `__PLAYER_ID__` → asset_id.
  - Unity: `Assets/Game/Scripts/PlayerController.cs` + `Game.asmdef` (Input System или старый Input);
    тесты `Assets/Game/Tests/Editor/GameSmokeTests.cs` + `Game.Tests.asmdef`.
  - Godot: `res://scripts/player_controller.gd` (`CharacterBody3D`) и `res://tests/run_tests.gd`.
  - Существующие файлы без `--force` не трогаются.
- **test:**
  - Unity — `AFBatch.Validate` (71 проверка пакетов, скриншоты), затем `-runTests -testPlatform EditMode`
    (+ PlayMode), NUnit XML → цифры. Если проект открыт в редакторе — отказ с подсказкой про `UnityMCP`.
  - Godot — `--import`, `af_engine_check.gd` (все сцены, 120 кадров, анимации, размеры, ошибки из вывода),
    `res://tests/run_tests.gd`. Кадры снимает Godot с окном на позиции −30000, −30000: рендер есть, на экране
    ничего не видно.

## Проверка 31.10.2026 (демо «AF Demo»)

| | Unity 6000.0.64f1 (URP) | Godot 4.5.1 |
|---|---|---|
| Создание проекта | 69,3 с, batchmode, импортёр 0.1.3 + MCP for Unity 10.3.0 | 2,3 с, headless |
| Ассеты | лучник (Humanoid), костёр, дерево, заяц | костёр, заяц, дом, лучник (экспорт `godot` из библиотеки) |
| Логика | `scaffold player archer_q` | `scaffold player` (заяц, затем лучник) |
| Тесты | пакеты 4/4 OK; EditMode 2/2: ходит вперёд, walk / idle | 4/4 сцены, 0 ошибок движка; `run_tests` 5/5 |
| Время теста | 13,5–22,5 с | 3–15 с (с импортом) |

Размеры одних и тех же ассетов в Unity и Godot совпали до миллиметра (костёр 0,679 × 0,5 × 0,561 м, дом 4,412 × 4 ×
4,361 м). Окна редакторов и игр не открывались.

## Ограничения (честно)

- Шаблон логики пока один — `player`: управление и анимации idle ↔ walk / run. NPC, враги, диалоги, квесты,
  UI — агент пишет кодом по `references/recipes.md`; готовых шаблонов ещё нет.
- Сцену уровня в Unity в фоне агент собирает своим редакторным скриптом через `-executeMethod`. Готовой
  команды «собрать уровень» нет. В Godot сцены собираются инструментами MCP `godot`.
- Godot headless не рендерит: кадры только через окно за пределами экрана. Позу анимации на кадре скрипт не
  ставит (персонаж в позе покоя).
- В headless-тестах Godot `move_and_slide` берёт шаг физики движка, а не `delta` теста. Проверяется факт
  движения, а не скорость.
- Сборка игры для платформ (`manage_build` / `export_project`) — только по слову владельца; в этом заходе не
  проверялась.
- Записи MCP-серверов в `~/.claude.json` могут потеряться, когда другие сессии Claude перезаписывают файл.
  Тогда `engine_mcp_register` их восстанавливает, и в начале работы скилл это проверяет.
