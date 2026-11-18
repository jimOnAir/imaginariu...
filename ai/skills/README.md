# Скилы Imaginarium для LLM

Здесь лежат скилы, по которым любая LLM (Claude Code, Codex, локальная модель) ставит, проверяет и ведёт студию:

| Скилл | Что внутри |
|---|---|
| `imaginarium/` | вся студия: установка с нуля (`references/install.md`), опись компонентов и моделей (`components.md`), снимок машины (`inventory.md`), устройство и CLI (`studio.md`), передача ассетов в игры (`games.md`), грабли (`troubleshooting.md`), проверка состояния `scripts/imaginarium_status.ps1` |
| `imaginarium-vfx/` | эффекты на модели, генератор VFX-текстур, внешние генераторы, экспорт в Godot; выгрузка базы Notion, проверочный сервер, проверка Godot |
| `imaginarium-learn/` | самообучение: перед заданием — рецепт и грабли класса ассета, после — сверка с концептом и вердикт, периодически — сводка журнала в `imaginarium/references/recipes.md` и `quality-lessons.md` (`docs/forge/LEARN.md`) |

Эта папка — единственный источник. В Claude Code она подключена ссылками (junction), поэтому скилы видит любая сессия:

```bat
mklink /J "%USERPROFILE%\.claude\skills\imaginarium" "<папка Imaginarium>\ai\skills\imaginarium"
mklink /J "%USERPROFILE%\.claude\skills\imaginarium-vfx" "<папка Imaginarium>\ai\skills\imaginarium-vfx"
mklink /J "%USERPROFILE%\.claude\skills\imaginarium-learn" "<папка Imaginarium>\ai\skills\imaginarium-learn"
```

Для других моделей это обычные markdown-файлы: начните с `imaginarium/SKILL.md`. Подробная документация для людей —
Obsidian, хаб `00 Dops Media/Проекты/Imaginarium — система.md`. Меняете студию — обновляйте скилл в том же коммите.
