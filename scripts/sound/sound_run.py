"""sound_run.py - AstraForge's one-shot Sound worker (behavior per ADR-0004, ticket 04).

Spawned by server/sound.mjs inside the install's own venv (runtime/sound/.venv):

    python sound_run.py --engine moss|acestep --prompt "..." --out X.wav \
        --weights DIR --src DIR [--seconds N] [--bpm N] [--bars N] [--seed N]

Contract (stdout lines; server/sound.mjs parses them):
    SOUND_PROGRESS <percent> <text>    - stage updates
    SOUND_RESULT {json}                - success: out, engine, seconds, sampleRate, seed
    SOUND_ERROR {json}                 - failure: message

Both engines are public projects used through their own API; nothing of their internals is
rewritten here. MOSS-SoundEffect v2.0 (Apache-2.0) gives 48 kHz mono SFX (<=30 s); ACE-Step 1.5
(MIT) gives 48 kHz stereo music, looped by bars with the overhang folded into the head so the
file repeats without a seam. Exports are plain WAV (and a plain OGG companion when available):
no provenance chunk, no metadata mark (branch policy Q5/Q11).
"""
import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "shim"))  # audiotools stand-in for the MOSS pipeline


def emit_progress(percent, text):
    print(f"SOUND_PROGRESS {max(0, min(99, int(percent)))} {text}", flush=True)


def fail(message, code=1):
    print("SOUND_ERROR " + json.dumps({"message": str(message)}), flush=True)
    sys.exit(code)


def require(p, what):
    if not Path(p).exists():
        fail(f"{what} is missing at {p}. Install the Sound component with installer/install.sh -Only sound.")


def write_audio(tensor, sample_rate, out_path):
    """Write the plain WAV (no metadata tags) and an OGG Vorbis companion.

    soundfile (libsndfile) writes both: torch's own saver goes through torchcodec, whose
    shared libraries are not part of this venv, and a metadata-free WAV is what the branch
    ships anyway (no `afmk` chunk, no tags).
    """
    import soundfile as sf
    import torch

    if tensor.dim() == 3:
        tensor = tensor[0]
    tensor = tensor.detach().cpu().to(torch.float32)
    data = tensor.transpose(0, 1).contiguous().numpy() if tensor.dim() == 2 else tensor.numpy()
    sf.write(str(out_path), data, int(sample_rate), format="WAV", subtype="PCM_16")
    ogg = str(out_path)[:-4] + ".ogg"
    try:
        sf.write(ogg, data, int(sample_rate), format="OGG", subtype="VORBIS")
    except Exception:
        pass
    return data.shape[0] / float(sample_rate)


def run_moss(args):
    import torch
    from moss_soundeffect_v2 import MossSoundEffectPipeline

    weights = Path(args.weights) / "MOSS-SoundEffect-v2.0"
    require(weights / "model_index.json", "MOSS-SoundEffect weights")
    require(weights / "vae" / "vae_128d_48k.pth", "MOSS DAC VAE weights")

    emit_progress(3, "Loading MOSS-SoundEffect v2")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Assemble on the CPU, then let the engine move only the model it needs onto the card
    # (prompt encoder / DiT / VAE one at a time); a direct .to("cuda") holds all three at once
    # and overflows a 12 GB card.
    pipe = MossSoundEffectPipeline.from_pretrained(str(weights), torch_dtype=torch.bfloat16, device="cpu")
    pipe.engine.device = device
    pipe.engine.vram_management_enabled = True

    def progress_bar(iterable):
        total = max(1, len(iterable))
        for i, item in enumerate(iterable, 1):
            emit_progress(10 + 80 * i / total, f"MOSS denoising step {i}/{total}")
            yield item

    emit_progress(12, "Generating the sound")
    audio = pipe(
        prompt=args.prompt,
        seconds=float(args.seconds),
        num_inference_steps=int(args.steps),
        cfg_scale=float(args.cfg_scale),
        seed=int(args.seed),
        num_channels=1,
        progress_bar_cmd=progress_bar,
    )
    rate = int(pipe.sample_rate)
    write_audio(audio, rate, args.out)
    return {"engine": "moss-soundeffect-v2", "seconds": audio.shape[-1] / rate, "sampleRate": rate, "seed": int(args.seed)}


def run_acestep(args):
    import numpy as np
    import soundfile as sf
    import torch

    checkpoints = Path(args.weights) / "ACE-Step1.5"
    require(checkpoints / "acestep-v15-turbo" / "model.safetensors", "ACE-Step 1.5 weights")

    os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(checkpoints)
    if not torch.cuda.is_available():
        fail("ACE-Step needs an NVIDIA (CUDA) card; this machine reports no CUDA device.")

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    bars = int(args.bars)
    bpm = int(args.bpm)
    target = bars * 4 * 60.0 / bpm          # exact loop length in seconds
    fade = min(0.5, target / 8.0)          # fold width for the seam

    emit_progress(3, "Loading ACE-Step 1.5 turbo")
    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=args.src, config_path="acestep-v15-turbo", device="cuda", use_flash_attention=False)
    if not ok:
        fail(f"ACE-Step did not initialize: {status}")

    def progress(fraction, desc=""):
        if fraction is None:
            return
        try:
            emit_progress(10 + 80 * float(fraction), desc or "Generating the music loop")
        except (TypeError, ValueError):
            pass

    params = GenerationParams(
        task_type="text2music", caption=args.prompt, instrumental=True, lyrics="[Instrumental]",
        duration=target + fade, bpm=bpm, inference_steps=int(args.steps), seed=int(args.seed),
        thinking=False, use_cot_metas=False, use_cot_caption=False, use_cot_language=False,
        enable_normalization=True, normalization_db=-1.0,
    )
    config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[int(args.seed)])
    output_dir = str(Path(args.out).parent / "acestep")
    result = generate_music(dit, None, params, config, save_dir=output_dir, progress=progress)
    if not result.success or not result.audios:
        fail(result.error or "ACE-Step produced no audio.")

    produced, rate = sf.read(result.audios[0]["path"], always_2d=True, dtype="float32")
    need = int(round((target + fade) * rate))
    if produced.shape[0] < need:
        produced = np.pad(produced, ((0, need - produced.shape[0]), (0, 0)))
    produced = produced[:need]
    loop_samples = int(round(target * rate))
    fade_samples = max(1, int(round(fade * rate)))
    mixed = produced.copy()
    for i in range(0, min(fade_samples, loop_samples)):
        t = i / fade_samples
        mixed[i] = produced[i] * t + produced[loop_samples + i] * (1.0 - t)
    loop = mixed[:loop_samples]

    write_audio(torch.from_numpy(loop).transpose(0, 1), rate, args.out)
    return {"engine": "ace-step-1.5", "seconds": loop_samples / rate, "sampleRate": int(rate), "seed": int(args.seed), "bars": bars, "bpm": bpm}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=["moss", "acestep"], required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--weights", required=True)
    p.add_argument("--src", required=True)
    p.add_argument("--seconds", type=float, default=10.0)
    p.add_argument("--bpm", type=int, default=120)
    p.add_argument("--bars", type=int, default=4)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--steps", type=int, default=None)
    p.add_argument("--cfg-scale", type=float, default=4.0)
    args = p.parse_args()
    if args.steps is None:
        args.steps = 100 if args.engine == "moss" else 8
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    try:
        stats = run_moss(args) if args.engine == "moss" else run_acestep(args)
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"{type(exc).__name__}: {exc}")
    stats["out"] = args.out
    print("SOUND_RESULT " + json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()
