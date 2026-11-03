# Скилы AstraForge для LLM

Здесь лежат скилы, по которым любая LLM (Claude Code, Codex, локальная модель) ставит, проверяет и ведёт студию:

| Скилл | Что внутри |
|---|---|
| `astraforge/` | вся студия: установка с нуля (`references/install.md`), опись компонентов и моделей (`components.md`), снимок машины (`inventory.md`), устройство и CLI (`studio.md`), передача ассетов в игры (`games.md`), грабли (`troubleshooting.md`), проверка состояния `scripts/af_status.ps1` |
| `astraforge-vfx/` | эффекты на модели, генератор VFX-текстур, внешние генераторы, экспорт в Godot; выгрузка базы Notion, проверочный сервер, проверка Godot |
| `astraforge-learn/` | самообучение: перед заданием — рецепт и грабли класса ассета, после — сверка с концептом и вердикт, периодически — сводка журнала в `astraforge/references/recipes.md` и `quality-lessons.md` (`docs/forge/LEARN.md`) |

Эта папка — единственный источник. В Claude Code она подключена ссылками (junction), поэтому скилы видит любая сессия:

```bat
mklink /J "%USERPROFILE%\.claude\skills\astraforge" "<папка AstraForge>\ai\skills\astraforge"
mklink /J "%USERPROFILE%\.claude\skills\astraforge-vfx" "<папка AstraForge>\ai\skills\astraforge-vfx"
mklink /J "%USERPROFILE%\.claude\skills\astraforge-learn" "<папка AstraForge>\ai\skills\astraforge-learn"
```

Для других моделей это обычные markdown-файлы: начните с `astraforge/SKILL.md`. Подробная документация для людей —
Obsidian, хаб `00 Dops Media/Проекты/AstraForge — система.md`. Меняете студию — обновляйте скилл в том же коммите.
