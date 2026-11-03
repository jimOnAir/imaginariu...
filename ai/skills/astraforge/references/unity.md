# Unity: пакеты студии и импортёр `com.astraforge.unity`

Интеграция с Unity устроена по образцу Godot. Студия делает **пакет** (шаг `unity_package`, профиль экспорта
`unity`), импортёр в Unity сам собирает **префаб**, а пакетная проверка в настоящем Unity подтверждает результат.
Полный документ — `APP/docs/forge/unity.md`. Здесь — то, что нужно, чтобы сделать работу и не наступить на
грабли.

## Что стоит на машине (31.10.2026)

| Что | Где |
|---|---|
| Unity Hub | `C:\Program Files\Unity Hub\Unity Hub.exe` (пакетный режим требует входа в аккаунт; лицензия Personal) |
| Редакторы | `C:\Program Files\Unity\Hub\Editor\6000.0.64f1` (**по умолчанию, Unity 6 LTS**), `6000.3.2f1` |
| Проверочный проект | `C:\AstraForge\unity\AFUnityCheck` — URP 17.0.4, из шаблона «Universal 3D» редактора (`-cloneFromTemplate`, без сети); импортёр подключён ссылкой `file:` на папку репозитория |
| Импортёр | `APP\unity\com.astraforge.unity` (UPM, MIT; `.meta` в git — GUID скриптов не меняются) |
| Скрипты | `APP\scripts\blender\steps\unity_package.py`, `_unity_lib.py`; `APP\scripts\unity\af_unity_send.mjs`, `unity_check.py` |
| Тесты | `run_tests.py -- unity` (4 + 1; пятый тест — настоящий Unity, только с `AF_UNITY_TESTS=1`) |

## Команды

```
node scripts/forge.mjs export <assetId> --profile unity [--params '{"fx":[…]}']           # пакет + проверка в Unity
node scripts/forge.mjs export <assetId> --profile unity --to-unity "<проект Unity>" [--build]
node scripts/unity/af_unity_send.mjs --project "<проект Unity>" <папка пакета | unity-v00N.zip> [--build]
py -I scripts/unity/unity_check.py <пакет> [...] --out <папка> [--project <проект>] [--pipeline urp|builtin]
```

MCP `astraforge`: `forge_export` (профиль `unity`), `unity_status`, `unity_send`, `unity_check`.

## Правила

1. **В проект Unity владельца пишем только по его просьбе** (`--to-unity`, `unity_send`): импортёр
   копируется в `Packages/com.astraforge.unity` (встроенный пакет), ассет — в `Assets/AstraForge/<id>/` поверх
   прежнего. Файлы не удаляются, `.meta` остаются: префабы, материалы и контроллеры сохраняют GUID, ссылки в
   сценах не рвутся. Если проект открыт в редакторе, префаб соберётся сам при переключении в окно; `--build`
   работает только на закрытом проекте.
2. **Проверочный проект студии — только для проверки**: его открывают через `_unity_lib` (замок
   `.af_unity_check.lock`). Если проект открыт в редакторе, проверка пишет предупреждение и не запускается.
3. Нет лицензии («No valid Unity Editor license», в журнале Hub — «offline validity period is expired») —
   просить владельца войти в Unity Hub (Preferences → Licenses). Пароли не вводить.
4. **Оси:** вектор Blender (x, y, z) приходит в Unity как (x, z, y). Персонажи, существа и предметы (+Z в glTF)
   смотрят в Unity в −Z, поэтому узел `model` разворачивается на 180°. Реквизит и корабли (−Z в glTF) уже
   смотрят в +Z. Не «чинить» это переворотом FBX: проверка `placement_axes` сразу покажет зеркало.
5. **Сторонние пакеты Unity из сети** (glTFast, VFX Graph, другие MCP-мосты, новые версии MCP for Unity) —
   только после явного «да» владельца на конкретный пакет и версию. Одобрено (31.10.2026): **MCP for Unity
   v10.3.0** (CoplayDev, MIT) — Unity-пакет `#v10.3.0` и `mcpforunityserver==10.3.0`.

## Управление редактором Unity из Claude Code

- Сервер `UnityMCP` в Claude Code (scope user, stdio, телеметрия выключена) запускает
  `uvx --from mcpforunityserver==10.3.0 mcp-for-unity --transport stdio`. Мост редактора слушает
  `127.0.0.1:6400` и стартует вместе с открытым редактором.
- Рабочий проект студии: `C:\AstraForge\unity\AstraForgeUnity` (URP + импортёр + MCP). Инструменты отвечают,
  только пока проект открыт в Unity.
- Подключить MCP к другому проекту владельца (по его просьбе): `af_unity_send.mjs --project <проект> --with-mcp`.
- 48 инструментов: `manage_scene`, `manage_gameobject` (в том числе `create` с `prefab_path`), `manage_prefabs`,
  `manage_asset`, `manage_material`, `manage_script`, `execute_menu_item` (меню AstraForge), `read_console`,
  `run_tests`, `manage_build`, `execute_code`… `generate_*` — облачные генераторы, без решения владельца не
  звать.
- Типовой путь: `forge_export` (профиль unity) → `unity_send` → в Unity через `UnityMCP`: ставим префаб в
  сцену, правим материалы, проверяем консоль.

## Что проверяет Unity (`AFBatch.Validate`)

Префаб есть; нет «розовых» материалов (шейдер подходит активному пайплайну); материалы паспорта стоят на модели;
размер по осям совпадает с размером glTF/Godot (1 %) и с углами габарита; Avatar Humanoid или Generic
валиден; клипы и петли; контроллер; анимация двигает кости; сокеты на месте (в bind pose); эффекты на сокетах
с верной осью; коллайдер; LOD с убывающими треугольниками; спрайты нарезаны, PPU, фильтр Point у пиксель-арта,
контроллер 8 направлений; нет ошибок консоли. Скриншоты — `unity_shots/<id>.png` и `contact_sheet.png`.

Прогон 31.10: дерево, костёр, дом, заяц (+ спрайты), олень, лучник (Humanoid), бочка (только спрайт) —
**7 из 7 OK, 71 проверка, ~20 с** на весь набор (URP); то же в Built-in (`--pipeline builtin`) — 7 из 7, 13 с. HDRP не прогонялся.

## Чего нет (говорить владельцу честно)

- **Эффекты:** Particle System, а не VFX Graph; перевод пресетов Godot приблизительный.
- **Ветер листвы:** только URP и Built-in. В HDRP — HDRP/Lit без ветра и вершинного цвета.
- **Поза покоя:** ригованный префаб в редакторе стоит в позе кадра, а не покоя (Animator это перекрывает).
- **LOD:** только у статичных моделей.
- **Root motion:** выключен.
- **Ткань `cloth_sim`:** без запечённой симуляции.

## Ошибки и что делать

| Признак | Причина | Что делать |
|---|---|---|
| `unity_validation: license` | Hub вышел из аккаунта | владелец входит в Hub |
| `project_open` | проверочный проект открыт в редакторе | закрыть окно Unity с `AFUnityCheck` |
| `materials_no_pink` ✘ | материал без шейдера пайплайна (например, `Standard` в URP) | смотреть `AFPipeline.ShaderFits`, имя шейдера в отчёте |
| `materials_remapped` ✘ | имя материала в FBX не совпало с паспортом | имена материалов в Blender без странных символов; ассет назван по файлу `Safe(name)` |
| `placement_axes` ✘ при верном размере | модель развёрнута или зеркалена | проверить `to_unity`/`turn` и `model_rotation_y` |
| `animation_plays` 0 | клип пустой или дубль FBX не сопоставился | в паспорте `clips[].take` = имя действия Blender; дубль `Armature|<take>` |
