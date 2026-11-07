# Style bible — the project look as data

Branch: `linux-support`, 0.6.x reintroduction wave, ticket 06. A **style** is what makes a series
of pictures feel like one world: 1–6 reference pictures plus an English description (and a
negative, a palette, notes), stored under `data/styles/<id>/` and managed from the **Style** tab.
Ticket 07 makes the generators consume it (style-conditioned 2D); this ticket is the data, the
editor and the describe.

## A style record

```
data/styles/<uuid>/
  style.json      {id, name, description, negative, palette, notes, images[], createdAt, updatedAt}
  <uuid>.png      the reference pictures, stored under generated names (never the user's spelling)
```

Rules the server holds to (`server/styles.mjs`): 1–6 pictures per style, PNG/JPG/WEBP by magic
bytes (a file lying about its extension is refused by name in the error), names and text fields
length-capped and strictly validated — saving from the UI cannot store an invalid record. Removing
a picture or a whole style **moves it to `data/styles/trash/`** — the studio never erases a
reference on its own, the last picture of a style cannot be pruned away.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/styles` | every style, newest first |
| `GET /api/styles/:id` | one record |
| `GET /api/styles/:id/images/:file` | a reference picture (generated name only, whitelisted) |
| `POST /api/styles` | multipart create: `name` + 1–6 `images` (+ optional text fields) |
| `PUT /api/styles/:id` | edit the text fields (strict; pictures are not touched) |
| `POST /api/styles/:id/images` | add pictures, six is the ceiling |
| `DELETE /api/styles/:id/images/:file` | one picture moves to the trash |
| `POST /api/styles/:id/describe` | draft the description with the local vision model |
| `DELETE /api/styles/:id` | the folder moves to the trash |

## Describe — the local vision model, nothing else

Describe reads the style's pictures with the **same model the review step uses**
(`server/vlm.mjs` pick: the Connections choice wins when installed, then the card tier, then any
installed vision model, reason included — ticket 14). The pictures travel to Ollama as base64 on
`/api/chat` with `think:false` enforced; the instruction asks for the STYLE, not the subjects — one
English paragraph naming medium, line, palette, lighting, rendering, mood, and a final `Avoid:`
line — because that paragraph becomes the prompt generators consume. The draft lands in the
editor's description field; save keeps it, edit before saving is normal.

No vision model installed? The request answers 503 with the pick's own reason, which names the way
out (`installer/install.sh -Only vlm` or `ollama pull`). Nothing here ever downloads, and a failed
describe never touched the record.

## The Style tab

Left: the list with thumbnails and a create box (name + up to six files). Right: the editor —
picture strip (add while below six, remove with one click, the last one stays), name, description
with the **Describe with local AI** button (the notification names the model that wrote the draft),
`Never like this`, palette, notes, save, and a delete that says plainly where the style went.
The tab list grew `... 2D → Style → Sound ...`.

## Measured on this machine (RTX 5070, qwen3-vl:8b)

Two painted concept pictures, `POST /api/styles` then describe: 23.6 s round trip, pick reason
`qwen3.5:9b is not installed - taking qwen3-vl:8b`, and a genuinely usable draft: *"minimalist
digital vector art with crisp, sharp lines and solid flat colors … Lighting is even and flat …
Avoid: Any gradients, surface textures, or realistic shadows…"*. Deleting moved `style.json` and
both pictures into `data/styles/trash/<id>/` with the draft still inside.
