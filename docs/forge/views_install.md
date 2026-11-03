# Ракурсы: что установлено и как (MV-Adapter в собственном ComfyUI)

Состояние на 13.10.2026. Относится к `docs/forge/views.md`. Всё скачанное разрешено владельцем:
веса `huanngzh/mv-adapter`, узел `huanngzh/ComfyUI-MVAdapter` и Python-пакеты этого узла. Ничего больше не скачивалось
(ни BiRefNet, ни другого VAE, ни SDXL в формате diffusers).

## Что и куда

| Что | Откуда | Куда | Размер |
|---|---|---|---|
| `mvadapter_i2mv_sdxl.safetensors` (Apache-2.0) | huggingface.co/huanngzh/mv-adapter | `data/models/mvadapter/` | 3,60 ГБ |
| узел ComfyUI-MVAdapter 1.0.2 (Apache-2.0) | github.com/huanngzh/ComfyUI-MVAdapter (zip ветки main) | `data/runtime/custom_nodes/ComfyUI-MVAdapter/` | 0,5 МБ без картинок README |
| конфиги и токенайзеры SDXL (без весов) | собраны локально `scripts/views/make_sdxl_config.py` из файлов ComfyUI и опубликованных значений SDXL base | `data/models/mvadapter/sdxl-config/` | 2 МБ |
| SDXL base 1.0 и его собственный VAE | уже были: `D:/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors` | — | — |

Узел внесён в белый список запуска: `server/runtime.mjs` теперь стартует ComfyUI с
`--whitelist-custom-nodes AstraForgeMesh ComfyUI-MVAdapter` и переменными `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`
(страховка: ни один узел этого движка не пойдёт в сеть).

## Python-пакеты (`D:/ComfyUI/.venv`)

Перед установкой сохранён `pip freeze` (131 строка). Ставились только отсутствующие пакеты, с ограничением версий
`pip install -c freeze_before.txt …`: pip не мог тронуть ни один уже стоящий пакет. Резюме diff до/после:

```diff
+ accelerate==1.15.0
+ antlr4-python3-runtime==4.9.3        # нужен omegaconf, который уже стоял без него
+ diffusers==0.40.0
+ importlib_metadata==9.0.1
+ peft==0.21.2
+ timm==1.0.30
+ trimesh==5.1.1
+ zipp==4.1.1
```

Итого 139 строк против 131: восемь добавлений, ноль изменений, ноль удалений.

Проверено после установки (версии те же, что до):

| Пакет | До | После |
|---|---|---|
| torch | 2.11.0+cu128 | 2.11.0+cu128 |
| torchvision | 0.26.0+cu128 | 0.26.0+cu128 |
| torchaudio | 2.11.0+cu128 | 2.11.0+cu128 |
| numpy | 2.5.2 | 2.5.2 |
| transformers | 5.15.1 | 5.15.1 |
| huggingface_hub | 1.28.0 | 1.28.0 |
| safetensors, tokenizers, pillow, scipy | 0.8.0, 0.22.2, 12.3.0, 1.18.0 | без изменений |

`pip check` сообщает одно замечание, существовавшее и до установки: `submitit 1.5.4 requires cloudpickle`
(пакет submitit нужен demucs, к ракурсам отношения не имеет).

Файл `requirements.txt` узла требует `diffusers==0.31.0`, `transformers==4.46.3`, `huggingface_hub==0.24.6`,
`accelerate==1.1.1`. Это понизило бы `transformers` 5.15.1 и `huggingface_hub` 1.28.0, на которых работает остальной ComfyUI,
поэтому закрепления не применялись. Манифест узла (`pyproject.toml`) допускает `>=`, так что `diffusers 0.40` подходит.

Файлы до/после: `docs/forge/views_freeze_before.txt`, `docs/forge/views_freeze_after.txt`.

## Правки узла (список в `data/runtime/custom_nodes/ComfyUI-MVAdapter/NOTICE-ASTRAFORGE.md`)

1. `utils.local_sdxl_config()` и `LdmPipelineLoader`: `from_single_file(config=<локальная папка>, local_files_only=True)`.
   Без этого diffusers идёт за конфигами SDXL на huggingface.co.
2. `enable_vae_slicing/tiling` в diffusers 0.40 переехали с pipeline на `pipeline.vae`: добавлен запасной путь.
3. Новый узел `AstraMVAdapterViews` (`astra_views.py`): загрузка, генерация и освобождение видеопамяти одним узлом.
   Штатные узлы держат весь pipeline (≈8 ГБ) на видеокарте между заданиями, что мешает Hunyuan3D в том же процессе.
   Узел: `unload_all_models()` до работы, ручной offload текстовых энкодеров и VAE (`offload=text+vae`), полный возврат памяти после.

Почему не `enable_model_cpu_offload`: accelerate копирует словари kwargs, а MV-Adapter передаёт кеш опорных скрытых
состояний внутри словаря: кеш терялся (`KeyError: …attn1.processor`). Ручной offload этого не делает.

## Память и скорость (RTX 4070 12 ГБ, 4 вида, 30 шагов)

Пик `torch.cuda.max_memory_allocated`, в системе ещё ≈1,3 ГБ занимает рабочий стол:

| Размер | Пик видеопамяти | Время | Вывод |
|---|---|---|---|
| 512×512 | 8,7 ГБ | 3 шага за 3,6 с (после загрузки весов ≈10 с) | помещается с запасом |
| 640×640 | 9,7 ГБ | 34 с на всё задание (30 шагов) | **по умолчанию** |
| 768×768 | 11,0 ГБ (без ручного offload 12,5) | 77 с за 3 шага вместе с загрузкой: видеокарта уходит в подкачку | не использовать |

Шесть видов (добавлены 45°) считаются только в 512. Без ручного offload пик на 640 был бы ≈11 ГБ.
Приложение само ограничивает размер (`safeSize`) и при ошибке нехватки памяти повторяет в 512.

## Как проверить после переустановки

```
node scripts/views/views_generate.mjs --status          # codex.available и mvadapter.ready должны быть true
node scripts/views/views_generate.mjs --input front.png --out out --provider mvadapter
```

Если `mvadapter.ready=false`: нет весов, нет `sdxl-config` (запустите `scripts/views/make_sdxl_config.py`)
или ComfyUI запущен до установки узла (Stop.cmd, затем Start.cmd).

## Что не сделано

В установщик (`installer/Install.ps1`) загрузка весов MV-Adapter и узла не добавлена: это решает владелец
(по лицензиям строка уже внесена в `THIRD_PARTY_NOTICES.md`).
