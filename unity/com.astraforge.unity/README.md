# AstraForge Importer (`com.astraforge.unity`)

Пакет Unity (UPM, MIT) студии AstraForge. Из пакета студии — папки с `af_unity.json` (экспорт профилем
`unity`) — он сам собирает готовый префаб.

- **Модель** — FBX в метрах, `bakeAxisConversion`, префаб смотрит вдоль `transform.forward`.
- **Материалы** под активный пайплайн: URP Lit, Built-in Standard или HDRP/Lit; листва и вершинный цвет —
  `AstraForge/Foliage` с ветром.
- **Анимация:** Avatar Humanoid (кости Mixamo) или Generic, клипы с петлями, Animator Controller.
- **Коллайдер:** коробка, капсула или сетка.
- **LODGroup** для статичных моделей.
- **Сокеты** (`AFSockets`) и эффекты на них — Particle System (`AFFxMount`).
- **Спрайты:** листы с Pixels Per Unit = px/м, клипы и контроллер на 8 направлений (`AFSprite8Dir`).

Требования: Unity 6000.0 и новее. Зависимостей нет — ни 2D Sprite, ни glTF; URP и HDRP не обязательны.

## Как подключить

- Командой студии: `node scripts/forge.mjs export <id> --profile unity --to-unity <проект>` или
  `node scripts/unity/af_unity_send.mjs --project <проект> <пакет>`. Пакет копируется в `Packages/` проекта как
  встроенный, ассет — в `Assets/AstraForge/<id>/`.
- Вручную: Package Manager → *Add package from disk…* → `package.json` этой папки, затем меню
  **AstraForge → Импортировать папку пакета…**

Открытый редактор собирает префаб сам, когда файлы пакета появились или обновились.

## Пакетный режим

```
Unity -batchmode -projectPath <проект> -executeMethod AstraForge.Editor.AFBatch.Validate ^
      -afPackages "Assets/AstraForge/a;Assets/AstraForge/b" -afReport report.json -afShots shots -quit
Unity -batchmode -projectPath <проект> -executeMethod AstraForge.Editor.AFBatch.BuildAll -quit
```

Подробно: `docs/forge/unity.md` в репозитории студии.

## Verification status of this tree (Linux)

The importer code above (Editor/Runtime C#) ships exactly as in the 0.4.16 studio, but on the machines
that build and test this tree no Unity editor is installed: the C# side is **not executed by CI here**
(flagged unverified, see the acceptance report). The studio side of the contract - the package layout,
`af_unity.json`, the send bridge and the step tests - is verified on Linux:
`blender -b --python scripts/blender/tests/run_tests.py -- unity` and `node scripts/unity/af_unity_send.mjs`.
Full validation of the prefab needs a machine with Unity: `--build` on the command above or
`python3 scripts/unity/unity_check.py <package>` (docs/forge/unity.md).
