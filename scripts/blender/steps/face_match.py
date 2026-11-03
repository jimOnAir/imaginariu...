"""face_match - the head-paint gate: the model's face against the references (front, 3/4, back).

inputs.blend | inputs.mesh (GLB)   model after paint_from_concept / face_fix_loop
params (docs/forge/face_match.md): refs_dir, gate, min_score, vlm, vlm_model, thresholds, iteration, frame_from, python
-> outputs.face_report (face_report.json), face_report_jpg, face_match_dir; check face_match_pass.

The check itself is scripts/qa/face_match.py in a separate Python (numpy, cv2, scikit-image, scipy); this
module only forwards the forge request to scripts/qa/face_step.run_match.
"""
import os
import sys

QA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "qa")
if QA_DIR not in sys.path:
    sys.path.insert(0, QA_DIR)

import face_step  # noqa: E402


def run(req):
    return face_step.run_match(req)
