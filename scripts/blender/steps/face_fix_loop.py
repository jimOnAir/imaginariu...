"""face_fix_loop - the "face check -> fix" cycle until the face matches the reference (or the limit / plateau).

inputs.blend | inputs.mesh (GLB)   painted model (paint_from_concept)
params (docs/forge/face_match.md): refs_dir, max_iter, plateau, require_pass, min_score, vlm, vlm_model,
                                   thresholds, body_refs_dir, python
-> outputs.blend / glb - the best model of the cycle (it continues the pipeline), face_report, face_report_jpg,
  texture_check, loop_state, loop_log, loop_dir; check face_loop_pass.

The cycle is scripts/qa/face_loop.py (face_match -> face_fix -> ...) in a separate Python; this module
only forwards the forge request to scripts/qa/face_step.run_loop.
"""
import os
import sys

QA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "qa")
if QA_DIR not in sys.path:
    sys.path.insert(0, QA_DIR)

import face_step  # noqa: E402


def run(req):
    return face_step.run_loop(req)
