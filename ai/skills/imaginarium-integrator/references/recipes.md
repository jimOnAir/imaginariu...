# Рецепты: ассет студии → движок → логика

Перед каждым рецептом выполнен шаг 0 из SKILL.md: проверено состояние, выбран движок, есть проект в реестре.
Ассет делается по скиллу **imaginarium**: Кузница, приёмка по `quality-lessons.md`.

## Общая схема

| Вид ассета | Профиль Unity | Профиль Godot | Что агент строит в движке |
|---|---|---|---|
| Играбельный персонаж (Mixamo-скелет) | `unity` → Humanoid | `godot` | `engine_scaffold kind=player`: управление, камера, тесты |
| NPC, враг | `unity` | `godot` | префаб или сцена + свой скрипт (патруль, диалог, атака) поверх `ImaginariumAnimations` / `AnimationPlayer` |
| Существо (свой скелет: заяц, олень) | `unity` → Generic | `godot` | клипы idle / run; поведение пишется скриптом (блуждание) |
| Реквизит с эффектом (костёр, факел) | `unity` (`fx`) | `godot` (`fx`) | ставится как есть: эффекты уже на сокетах, LOD и коллайдер готовы |
| Дерево, листва | `unity` (ветер) | `godot` | ветер — шейдер; в Godot — пакет демо с `leaves_wind.gdshader` |
| Здание | `unity` (LOD, коробка или `collider:"mesh"`) | `godot` | `collider:"mesh"`, если в здание заходят |
| Корабль, турель (Space Quest) | `unity` / `space_quest` | `space_quest` | сокеты сопел и дул, `ImaginariumFxMount.Trigger("socket_muzzle_01")` |
| Спрайты (iso8, pixel) | `unity` c `inputs.sprites` → `ImaginariumSprite8Dir` | спрайты `.tres` (`SpriteFrames`) | `SetWorldDirection(v)` / `AnimatedSprite2D` |
| Оружие, предмет в руке | Кузница `attach_prop` (запекается в персонажа) | то же | или `ImaginariumSockets.Attach("socket_mount_hand_r", item)` в рантайме |

## Персонаж игрока — Unity

1. `forge_export {assetId, profile:"unity", out}`. Шаг сам проверит Avatar Humanoid, клипы, размер.
2. `engine_send {project, engine:"unity", sources:[<out>/<asset_id>]}`.
3. `engine_scaffold {project, engine:"unity", kind:"player", assetId}` создаёт:
   - `Assets/Game/Scripts/PlayerController.cs` (CharacterController, WASD и геймпад через Input System,
     поворот к движению, idle ↔ walk через `ImaginariumAnimations`) + `Game.asmdef`;
   - `Assets/Game/Tests/Editor/GameSmokeTests.cs`: префаб на месте, ходит вперёд, играет walk и idle.
4. Сцена:
   - проект закрыт — редакторный скрипт `-executeMethod`: `EditorSceneManager.NewScene`, плоскость-земля,
     префаб + `CharacterController` + `PlayerController`, камера, `EditorBuildSettings`;
   - открыт — `UnityMCP`: `manage_gameobject {action:"create", prefab_path, position}`,
     `manage_components` (добавить `CharacterController` и `Game.PlayerController`), `manage_scene save`.
5. `engine_test {project, engine:"unity", shots:true}` → проверка пакетов + EditMode 2/2.

Клип ходьбы называется в паспорте `walk`, у существ — `run` или `hop`. `PlayerController.moveClip` правится
под клипы ассета: список — в `ima_unity.json` → `clips[].name`.

## Персонаж игрока — Godot

1. `forge_export {profile:"godot"}` → `engine_send {engine:"godot"}` → `res://imaginarium/<id>/<id>.tscn`.
2. `engine_scaffold {engine:"godot", kind:"player", assetId}` создаёт:
   - `res://scripts/player_controller.gd` (`CharacterBody3D`: модель из пакета, коллизия-капсула,
     `ui_*`-ввод, `AnimationPlayer` idle ↔ run / walk);
   - `res://tests/run_tests.gd`.
3. Сцена уровня инструментами `godot`:
   ```
   create_scene {projectPath, scenePath:"res://scenes/main.tscn", rootNodeType:"Node3D"}
   add_node {… nodeType:"CharacterBody3D", nodeName:"Player", properties:{script:"res://scripts/player_controller.gd",
             model_scene:"res://imaginarium/<id>/<id>.tscn"}}
   add_node {… "Camera3D"}, add_node {… "DirectionalLight3D"}, add_node {… "StaticBody3D" + CollisionShape3D}
   edit_project_settings {application/run/main_scene: "res://scenes/main.tscn"}
   ```
   Для многих операций — `batch_operations` одним вызовом. Проверка: `validate_scene`, `validate_script`.
4. `engine_test {engine:"godot", shots:true}` → сцены 120 кадров + `run_tests.gd` (5 проверок) + кадры
   (окно за пределами экрана).

## NPC с диалогом (оба движка)

- Модель — как у персонажа, без контроллера игрока.
- Скрипт NPC (C# или GDScript) делает четыре вещи:
  - триггер-зона (Unity: `SphereCollider isTrigger`; Godot: `Area3D`);
  - по входу игрока — клип `idle` → поворот к игроку;
  - строки диалога из JSON (`Assets/Game/Data/dialogue_<npc>.json`, `res://data/dialogue_<npc>.json`);
  - сигнал или событие «диалог закончен».
- Тест: подвести игрока к NPC (`Tick` / `tick`) → проверить событие.

## Реквизит с эффектом, дерево, дом

- Отправить пакет и поставить в сцену — логики не нужно.
- Эффекты: Unity — `ImaginariumFxMount` (`SetActive(socket, false)` гасит костёр), Godot — `ima_fx_mount.gd`
  (`trigger("сокет")`).
- Для статики — массовая расстановка:
  - Godot: MultiMesh или `instantiate_scene` по списку точек;
  - Unity: префаб, `GPU Instancing` в материале URP Lit.

## Спрайтовая игра

1. `sprites_render {profile:"pixel"|"iso8", …}` → экспорт `unity` (листы попадут в пакет) или `godot`
   (`SpriteFrames` `.tres`).
2. Unity: `<id>_sprite.prefab` → `ImaginariumSprite8Dir.SetWorldDirection(moveDir, camera)`, `Play("walk")`.
   Godot: `AnimatedSprite2D.sprite_frames = load(".../<id>_frames.tres")`, анимации `<клип>_<НАПРАВЛЕНИЕ>`.
3. Пиксель-арт: Point-фильтр (Unity — импортёр сам; Godot — `texture_filter = Nearest`), 1 м = 1 единица.

## Обновление ассета

- Повторный экспорт → `engine_send` поверх.
- Unity сохраняет GUID префабов, материалов и контроллеров: ссылки в сценах не рвутся.
- Godot перезаписывает файлы пакета на тех же путях.
- Затем `engine_test`.
