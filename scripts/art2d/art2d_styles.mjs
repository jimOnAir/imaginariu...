// Art styles of the 2D module (docs/art2d.md). A style = prompt suffix + negative + optional deterministic post-processing.
// `post.pixel` turns the generated picture into real pixel art in art2d_post.py (nearest downscale + palette), because
// diffusion models only imitate pixels. Prompts are model-facing constants: they define the look, not the UI.
export const STYLES = {
  painted: {
    label: 'Painted fantasy', note: 'soft painterly shading, like Heroes of Might & Magic',
    prompt: 'hand-painted 2D fantasy game art, painterly shading, clean readable silhouette, soft rim light',
  },
  cel: {
    label: 'Anime / cel-shaded', note: 'crisp outline, 2-3 tone fill',
    prompt: '2D anime cel-shaded illustration, crisp clean lineart, flat colors with two-tone shading',
  },
  cartoon: {
    label: 'Cartoon', note: 'thick outline, bright flat colors',
    prompt: '2D cartoon game character art, bold thick outlines, bright flat colors, simple shapes, mobile game style',
  },
  chibi: {
    label: 'Chibi', note: 'big head, short body',
    prompt: 'cute chibi 2D game sprite art, big head, small body, thick outline, flat bright colors',
  },
  dark: {
    label: 'Dark fantasy', note: 'grimy palette, hard shadows',
    prompt: 'dark fantasy 2D game illustration, gritty desaturated palette, dramatic hard shadows, detailed ink and paint',
  },
  scifi: {
    label: 'Sci-fi concept', note: 'for the space games',
    prompt: 'sci-fi 2D concept art, clean hard-surface rendering, cool palette, glowing accents, sharp edges',
  },
  ink: {
    label: 'Ink sketch', note: 'black and white sketch, storyboards',
    prompt: 'black and white ink sketch, loose confident pencil and ink lines, light grey wash, storyboard sketch',
  },
  flat: {
    label: 'Flat vector', note: 'no gradients, for UI and simple games',
    prompt: 'flat vector 2D illustration, no gradients, geometric shapes, limited palette, clean edges',
  },
  pixel: {
    label: 'Pixel art', note: 'a real pixel grid after generation',
    prompt: '16-bit pixel art game sprite, limited palette, crisp pixel clusters, no anti-aliasing',
    post: { pixel: { cell: 6, colors: 24 } },
  },
  pixel_hd: {
    label: 'Pixel art HD', note: 'bigger and more detailed',
    prompt: '32-bit high resolution pixel art, detailed shading with dithering, limited palette',
    post: { pixel: { cell: 3, colors: 48 } },
  },
  keep: {
    label: 'As in the reference', note: 'keep the style of the source picture',
    prompt: 'keep exactly the art style, rendering and colors of image 1',
  },
};

export const NEGATIVE = 'text, watermark, signature, logo, frame, border, cropped, extra limbs, extra fingers, deformed hands, blurry, jpeg artifacts, multiple characters';

/** "Style image" mode: the picture in the last reference slot sets the look. */
export const STYLE_REF_PROMPT = 'Draw it in exactly the art style, line quality, shading and palette of the style reference image (the last image); take nothing else from it.';

export function styleOf(id) {
  const s = STYLES[id];
  if (!s) throw new Error('Unknown 2D style: ' + id);
  return s;
}
