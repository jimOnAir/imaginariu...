// ComfyUI graphs (API format) for the 2D module (docs/art2d.md). Pure functions: no I/O, easy to test.
//
// Engines (files of the studio ComfyUI :8190 model folders):
//   flux2 - FLUX.2 [klein] 4B base GGUF (Apache-2.0 since the 0.6.6 swap) + Qwen3-4B fp4 text encoder.
//           Text-to-image AND editing by up to 4 reference
//           images (ReferenceLatent chain, the wiring of ComfyUI's own "Image Edit (Flux.2 Klein)" template).
//   flux9b - the same klein wiring on the 9B base (ticket 52): FLUX Non-Commercial weights, explicit
//           pick only - the default and every auto chain stay on 4B.
//   qwen  - Qwen-Image GGUF, text-to-image only (Apache-2.0, commercial use OK). Best with readable text.
//   sdxl  - SDXL base 1.0: fast drafts, text-to-image and image-to-image (denoise) (OpenRAIL++, commercial OK).
export const ENGINES = {
  flux2: {
    label: 'FLUX.2 klein 4B', license: 'Apache-2.0', commercial: true, edit: true, maxRefs: 4,
    unet: 'flux-2-klein-base-4b-Q4_K_M.gguf', clip: 'qwen_3_4b_fp4_flux2.safetensors', clipType: 'flux2', vae: 'flux2-vae.safetensors',
    steps: 20, cfg: 5, nodes: ['UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'ReferenceLatent', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'CFGGuider', 'SamplerCustomAdvanced'],
  },
  // 0.7.9 fold wave ticket 52: the 9B comes back as an explicit opt-in only - same klein wiring,
  // heavier weights, FLUX Non-Commercial licence. The studio never picks it automatically: the
  // 2D tab default stays flux2, the auto chain never lists it, and ticking it in Components asks
  // for a licence confirm first. Files and defaults are the pinned pre-0.6.6 era of this branch.
  flux9b: {
    label: 'FLUX.2 klein 9B', license: 'FLUX Non-Commercial', commercial: false, edit: true, maxRefs: 4,
    unet: 'flux-2-klein-base-9b-Q5_K_M.gguf', clip: 'qwen_3_8b_fp8mixed.safetensors', clipType: 'flux2', vae: 'flux2-vae.safetensors',
    steps: 20, cfg: 5, nodes: ['UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'ReferenceLatent', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'CFGGuider', 'SamplerCustomAdvanced'],
  },
  qwenedit: {
    label: 'Qwen-Image-Edit 2511', license: 'Apache-2.0', commercial: true, edit: true, maxRefs: 3,
    unet: 'qwen-image-edit-2511-Q4_K_M.gguf', clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', clipType: 'qwen_image', vae: 'qwen_image_vae.safetensors',
    lora: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
    gateMiB: 10240,   // the ticket's rule: a 10 GiB card or bigger; below it FLUX.2 klein draws the style series
    steps: 4, cfg: 1, nodes: ['UnetLoaderGGUF', 'LoraLoaderModelOnly', 'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow', 'TextEncodeQwenImageEditPlus', 'FluxKontextMultiReferenceLatentMethod', 'FluxKontextImageScale', 'VAEEncode', 'EmptySD3LatentImage', 'LoadImage', 'KSampler', 'VAEDecode', 'SaveImage'],
  },
  qwen: {
    label: 'Qwen-Image', license: 'Apache-2.0', commercial: true, edit: false, maxRefs: 0,
    unet: 'qwen-image-Q4_K_M.gguf', clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', clipType: 'qwen_image', vae: 'qwen_image_vae.safetensors',
    steps: 30, cfg: 4, nodes: ['UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow', 'EmptySD3LatentImage', 'KSampler'],
  },
  sdxl: {
    label: 'SDXL 1.0', license: 'CreativeML OpenRAIL++-M', commercial: true, edit: false, img2img: true, maxRefs: 1,
    checkpoint: 'sd_xl_base_1.0.safetensors', steps: 28, cfg: 7, nodes: ['CheckpointLoaderSimple', 'KSampler', 'EmptyLatentImage', 'VAEEncode'],
  },
};

/** Round to a multiple of 16 inside [512, 1536]. */
export function snapSize(v, fallback = 1024) {
  const n = Number(v) || fallback;
  return Math.max(512, Math.min(1536, Math.round(n / 16) * 16));
}

const seedOf = (seed) => (Number.isFinite(Number(seed)) ? Math.abs(Math.trunc(Number(seed))) % 2147483647 : 42);

// Reference size in megapixels. Every reference adds its tokens to the sequence: two references at 1 MP made a
// 1024-squared frame cost 11 s/step on the RTX 4070; the character keeps 0.6 MP (face and costume detail), helpers 0.35 MP.
export const REF_MEGAPIXELS = [0.6, 0.35, 0.35, 0.35];

/**
 * FLUX.2 klein: refs = uploaded image names (0..4). With refs the model edits / re-draws "the character from image 1".
 * Each reference is scaled to its megapixel budget, VAE-encoded and attached to BOTH positive and negative
 * conditioning (as in ComfyUI's own template).
 */
export function flux2Workflow({ prompt, negative = '', refs = [], width = 1024, height = 1024, steps, cfg, seed, prefix = 'imaginarium_2d/flux2', refMegapixels = REF_MEGAPIXELS, engine = 'flux2' }) {
  const e = ENGINES[engine] || ENGINES.flux2;
  if (refs.length > e.maxRefs) throw new Error(`FLUX.2 takes at most ${e.maxRefs} references.`);
  const wf = {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: e.unet } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: e.clipType, device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: negative } },
    6: { class_type: 'EmptyFlux2LatentImage', inputs: { width: snapSize(width), height: snapSize(height), batch_size: 1 } },
  };
  let pos = ['4', 0], neg = ['5', 0];
  refs.forEach((name, i) => {
    const b = 100 + i * 10;
    wf[b] = { class_type: 'LoadImage', inputs: { image: name } };
    wf[b + 1] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [String(b), 0], upscale_method: 'lanczos', megapixels: refMegapixels[i] ?? 0.35, resolution_steps: 1 } };
    wf[b + 2] = { class_type: 'VAEEncode', inputs: { pixels: [String(b + 1), 0], vae: ['3', 0] } };
    wf[b + 3] = { class_type: 'ReferenceLatent', inputs: { conditioning: pos, latent: [String(b + 2), 0] } };
    wf[b + 4] = { class_type: 'ReferenceLatent', inputs: { conditioning: neg, latent: [String(b + 2), 0] } };
    pos = [String(b + 3), 0];
    neg = [String(b + 4), 0];
  });
  Object.assign(wf, {
    10: { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: pos, negative: neg, cfg: Number(cfg) || e.cfg } },
    11: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    12: { class_type: 'Flux2Scheduler', inputs: { steps: Number(steps) || e.steps, width: snapSize(width), height: snapSize(height) } },
    13: { class_type: 'RandomNoise', inputs: { noise_seed: seedOf(seed) } },
    14: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['13', 0], guider: ['10', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['6', 0] } },
    15: { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['3', 0] } },
    16: { class_type: 'SaveImage', inputs: { images: ['15', 0], filename_prefix: prefix } },
  });
  return wf;
}

/**
 * Qwen-Image-Edit 2511 (docs/product/styles.md, ticket 07): the style engine. `refs` (0..3 uploaded
 * names) go through TextEncodeQwenImageEditPlus into BOTH prompts - with the vae wired the encoder
 * splices their latents into the sequence, and FluxKontextMultiReferenceLatentMethod marks them
 * `index_timestep_zero`: the reference conditions from step zero, which is how a style drives the
 * whole picture instead of a corner of it. `base` (a name) is an image being re-drawn: its scaled
 * pixels become the latent, the true edit path; without it the latent is empty and the pictures
 * condition through the encoder only. The pinned lightning LoRA brings it to 4 steps at cfg 1 -
 * the wiring of ComfyUI's own 2511 template, node for node.
 */
export function qwenEditWorkflow({ prompt, negative = '', refs = [], base = null, width = 1024, height = 1024, steps, cfg, seed, prefix = 'imaginarium_2d/qwenedit' }) {
  const e = ENGINES.qwenedit;
  const seen = refs.slice(0, 3);
  const wf = {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: e.unet } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: e.lora, strength_model: 1 } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: e.clipType, device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    5: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3.1 } },
    30: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['3', 0], prompt } },
    31: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['3', 0], prompt: negative } },
  };
  for (let i = 0; i < 3; i++) {
    if (!seen[i]) continue;
    wf[40 + i] = { class_type: 'LoadImage', inputs: { image: seen[i] } };
    for (const enc of ['30', '31']) wf[enc].inputs['image' + (i + 1)] = [String(40 + i), 0];
  }
  if (seen.length) {
    for (const enc of ['30', '31']) wf[enc].inputs.vae = ['4', 0];   // with a vae the encoder adds reference latents
    wf[32] = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['30', 0], reference_latents_method: 'index_timestep_zero' } };
    wf[33] = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['31', 0], reference_latents_method: 'index_timestep_zero' } };
  }
  const positive = seen.length ? ['32', 0] : ['30', 0];
  const negativeRef = seen.length ? ['33', 0] : ['31', 0];
  if (base) {
    wf[44] = { class_type: 'LoadImage', inputs: { image: base } };
    wf[45] = { class_type: 'FluxKontextImageScale', inputs: { image: ['44', 0] } };
    wf[46] = { class_type: 'VAEEncode', inputs: { pixels: ['45', 0], vae: ['4', 0] } };
  } else {
    wf[46] = { class_type: 'EmptySD3LatentImage', inputs: { width: snapSize(width), height: snapSize(height), batch_size: 1 } };
  }
  wf[50] = { class_type: 'KSampler', inputs: { model: ['5', 0], positive, negative: negativeRef, latent_image: ['46', 0], seed: seedOf(seed), steps: Number(steps) || e.steps, cfg: Number(cfg) || e.cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } };
  wf[51] = { class_type: 'VAEDecode', inputs: { samples: ['50', 0], vae: ['4', 0] } };
  wf[52] = { class_type: 'SaveImage', inputs: { images: ['51', 0], filename_prefix: prefix } };
  return wf;
}

export function qwenWorkflow({ prompt, negative = '', width = 1024, height = 1024, steps, cfg, seed, prefix = 'imaginarium_2d/qwen' }) {
  const e = ENGINES.qwen;
  return {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: e.unet } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: e.clipType, device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    4: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: negative } },
    7: { class_type: 'EmptySD3LatentImage', inputs: { width: snapSize(width), height: snapSize(height), batch_size: 1 } },
    8: { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], seed: seedOf(seed), steps: Number(steps) || e.steps, cfg: Number(cfg) || e.cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefix } },
  };
}

/** SDXL; with `init` (uploaded image name) it is image-to-image with the given denoise (0.2 keeps much, 0.8 redraws). */
export function sdxlWorkflow({ prompt, negative = '', width = 1024, height = 1024, steps, cfg, seed, init = null, denoise = 0.55, prefix = 'imaginarium_2d/sdxl' }) {
  const e = ENGINES.sdxl;
  const wf = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: e.checkpoint } },
    2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: prompt } },
    3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: negative } },
  };
  let latent;
  if (init) {
    wf[4] = { class_type: 'LoadImage', inputs: { image: init } };
    wf[5] = { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: snapSize(width), height: snapSize(height), crop: 'center' } };
    wf[6] = { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['1', 2] } };
    latent = ['6', 0];
  } else {
    wf[4] = { class_type: 'EmptyLatentImage', inputs: { width: snapSize(width), height: snapSize(height), batch_size: 1 } };
    latent = ['4', 0];
  }
  wf[8] = { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: latent, seed: seedOf(seed), steps: Number(steps) || e.steps, cfg: Number(cfg) || e.cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: init ? Math.max(0.05, Math.min(1, Number(denoise) || 0.55)) : 1 } };
  wf[9] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } };
  wf[10] = { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefix } };
  return wf;
}

/** One entry point for the runner: picks the builder by engine. */
export function buildWorkflow(engine, o) {
  if (engine === 'flux2') return flux2Workflow(o);
  if (engine === 'flux9b') return flux2Workflow({ ...o, engine });   // the same klein wiring (ticket 52)
  if (engine === 'qwenedit') return qwenEditWorkflow(o);
  if (engine === 'qwen') return qwenWorkflow(o);
  if (engine === 'sdxl') return sdxlWorkflow({ ...o, init: o.refs?.[0] || null });
  throw new Error('Unknown 2D engine: ' + engine);
}
