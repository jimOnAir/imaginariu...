// Recipes of the 2D module (docs/art2d.md): what a "set" consists of. Each recipe expands into an ordered shot list.
// A shot = one generation: {key, label, prompt, refs, w, h, cut, group}. Refs are symbolic and resolved by the runner:
//   'character' - the character reference picture (the user's concept)
//   'prev'      - the previous shot of this set (keeps an animation coherent frame to frame)
//   'first'     - the first shot of this set (anchors long sequences against drift)
//   'pose:<n>'  - the n-th pose picture given by the user (e.g. frames rendered from a 3D clip in the Forge)
//   'input:<n>' - the n-th input picture of a restyle run
// The style suffix and the style-image instruction are appended by the runner, not here.
// Labels are English here; the UI translates the fixed registries through i18n (art2d.<kind>.<id>).
import { STYLES } from './art2d_styles.mjs';

const BG = 'Plain flat white background, nothing else in the picture.';
const SAME = 'Same character as image 1: same face, hair, outfit, colors and proportions.';

export const TURNAROUND = [
  ['front', 'Front', 'front view, facing the viewer'],
  ['front34', '3/4 front', 'three-quarter front view, body turned 45 degrees to the left'],
  ['side', 'Side profile', 'side profile view, facing left'],
  ['back34', '3/4 back', 'three-quarter back view'],
  ['back', 'Back', 'back view, seen from directly behind'],
];

// Parts for a 2D cutout rig (Spine / Godot Skeleton2D). Each part is drawn alone, then cut out (art2d_post.py).
// pivot = joint position inside the part picture in 0..1 (where the bone sits), parent = rig parent.
export const PARTS = [
  ['head', 'Head', 'only the head and neck of the character, front view', { pivot: [0.5, 0.92], parent: 'torso' }],
  ['torso', 'Torso', 'only the torso and hips of the character without head, arms and legs, front view', { pivot: [0.5, 0.85], parent: null }],
  ['upper_arm_l', 'Upper arm L', 'only the left upper arm (shoulder to elbow) of the character, hanging straight down', { pivot: [0.5, 0.08], parent: 'torso' }],
  ['forearm_l', 'Forearm L', 'only the left forearm and hand of the character, hanging straight down', { pivot: [0.5, 0.06], parent: 'upper_arm_l' }],
  ['upper_arm_r', 'Upper arm R', 'only the right upper arm (shoulder to elbow) of the character, hanging straight down', { pivot: [0.5, 0.08], parent: 'torso' }],
  ['forearm_r', 'Forearm R', 'only the right forearm and hand of the character, hanging straight down', { pivot: [0.5, 0.06], parent: 'upper_arm_r' }],
  ['thigh_l', 'Thigh L', 'only the left thigh (hip to knee) of the character, straight vertical', { pivot: [0.5, 0.06], parent: 'torso' }],
  ['shin_l', 'Shin L', 'only the left shin and foot of the character, straight vertical', { pivot: [0.5, 0.05], parent: 'thigh_l' }],
  ['thigh_r', 'Thigh R', 'only the right thigh (hip to knee) of the character, straight vertical', { pivot: [0.5, 0.06], parent: 'torso' }],
  ['shin_r', 'Shin R', 'only the right shin and foot of the character, straight vertical', { pivot: [0.5, 0.05], parent: 'thigh_r' }],
];

export const EXPRESSIONS = [
  ['neutral', 'Calm', 'calm neutral expression'],
  ['happy', 'Joy', 'big happy smile'],
  ['angry', 'Anger', 'furious angry expression, clenched teeth'],
  ['sad', 'Sadness', 'sad expression, eyes looking down'],
  ['surprised', 'Surprise', 'surprised expression, wide eyes, open mouth'],
  ['hurt', 'Pain', 'pained expression, eyes squeezed, wincing'],
];

// Animation actions: one line per key pose. Side view facing right is the platformer/fighting default.
export const ACTIONS = {
  idle: { label: 'Idle', loop: true, fps: 6, poses: ['standing relaxed, weight centered, arms down', 'standing, chest slightly raised as breathing in', 'standing relaxed, weight centered, arms down', 'standing, shoulders slightly lowered as breathing out'] },
  // walk/run: the list is one full cycle; fewer frames are sampled evenly (4 of 8 = contact, passing, contact, passing)
  walk: { label: 'Walk', loop: true, fps: 8, poses: [
    'contact pose: left leg stepping forward with the heel on the ground, right leg stretched far behind, legs wide apart, right arm swung forward, left arm swung back',
    'down pose: weight on the bent left leg, right foot lifting off behind, arms passing the body',
    'passing pose: standing straight on the left leg, right knee bent and lifted, right foot passing beside the left knee, arms close to the body',
    'up pose: rising on the toes of the left foot, right leg swinging forward',
    'contact pose: right leg stepping forward with the heel on the ground, left leg stretched far behind, legs wide apart, left arm swung forward, right arm swung back',
    'down pose: weight on the bent right leg, left foot lifting off behind, arms passing the body',
    'passing pose: standing straight on the right leg, left knee bent and lifted, left foot passing beside the right knee, arms close to the body',
    'up pose: rising on the toes of the right foot, left leg swinging forward'] },
  run: { label: 'Run', loop: true, fps: 10, poses: [
    'running contact: left foot striking the ground in front, body leaning forward, right arm forward, left arm back',
    'running push-off: pushing off with the left foot, right knee driven high in front, arms pumping',
    'running flight: both feet off the ground, legs split wide front and back',
    'running contact: right foot striking the ground in front, body leaning forward, left arm forward, right arm back',
    'running push-off: pushing off with the right foot, left knee driven high in front, arms pumping',
    'running flight: both feet off the ground, legs split wide, opposite leg forward'] },
  attack: { label: 'Weapon attack', loop: false, fps: 10, poses: ['combat ready stance, weapon held in front', 'anticipation: weapon raised far back over the shoulder, body twisted', 'strike: weapon swung forward in a fast arc, body lunging forward', 'follow-through: weapon low after the swing, body extended', 'recovery: returning to combat ready stance'] },
  cast: { label: 'Spell cast', loop: false, fps: 8, poses: ['standing, hands together gathering energy', 'arms raised high, glowing magic forming between the hands', 'thrusting both hands forward releasing a magic blast', 'arms lowering, magic dissipating'] },
  hit: { label: 'Hit', loop: false, fps: 10, poses: ['recoiling backwards from a hit, head snapped back', 'staggering back, arms flailing', 'regaining balance, slightly hunched'] },
  death: { label: 'Death', loop: false, fps: 8, poses: ['hit hard, knees buckling', 'falling backwards, arms limp', 'lying on the ground, motionless'] },
  jump: { label: 'Jump', loop: false, fps: 10, poses: ['crouching deeply, preparing to jump', 'leaping upward, legs extended, arms raised', 'at the top of the jump, knees tucked', 'falling down, legs reaching for the ground', 'landing in a crouch'] },
};

export const DIRECTIONS = {
  right: 'side view facing right',
  left: 'side view facing left',
  front: 'front view facing the viewer',
  front34: 'three-quarter front view',
  back: 'back view',
};

export const RECIPES = {
  concept: { label: 'Concept', note: 'a picture from a description - the starting point of a character', needsCharacter: false },
  turnaround: { label: 'Turnaround', note: 'front, 3/4, profile, 3/4 back, back', needsCharacter: true, edit: true },
  parts: { label: 'Body parts', note: 'head, torso, arms, legs - cut out, for a 2D rig', needsCharacter: true, edit: true },
  animation: { label: 'Animation frames', note: 'key poses of an action -> sprite sheet and SpriteFrames', needsCharacter: true, edit: true },
  expressions: { label: 'Expressions', note: "the character's face with different emotions", needsCharacter: true, edit: true },
  storyboard: { label: 'Storyboard', note: 'scene frames from description lines', needsCharacter: false, edit: true },
  poses3d: { label: 'Poses from 3D', note: 'the character in the poses of 3D clip frames (from Sprites/Forge)', needsCharacter: true, edit: true, needsPoses: true },
  restyle: { label: 'Restyle', note: 'redraw every picture in the chosen style', needsCharacter: false, edit: true, needsInputs: true },
};

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/**
 * Expand a recipe into shots.
 * @param {object} o {recipe, prompt, action, direction, frames, scenes:string[], views, parts, poses:number, inputs:number}
 */
export function expandRecipe(o) {
  const recipe = RECIPES[o.recipe];
  if (!recipe) throw new Error('Unknown 2D recipe: ' + o.recipe);
  const extra = clean(o.prompt);
  const dir = DIRECTIONS[o.direction] || DIRECTIONS.right;
  const shots = [];
  const add = (s) => shots.push({ w: 768, h: 1024, cut: false, group: o.recipe, ...s });

  if (o.recipe === 'concept') {
    if (!extra) throw new Error('Describe the character or the object.');
    const n = Math.max(1, Math.min(4, Number(o.frames) || 1));
    for (let i = 0; i < n; i++) add({ key: 'concept_' + (i + 1), label: `Variant ${i + 1}`, prompt: `${extra}. Full body character design, ${DIRECTIONS.front}, neutral standing pose. ${BG}`, refs: [], seedOffset: i, cut: true });
  } else if (o.recipe === 'turnaround') {
    const wanted = o.views?.length ? TURNAROUND.filter(([k]) => o.views.includes(k)) : TURNAROUND;
    for (const [key, label, view] of wanted) add({ key, label, prompt: `Show the character from image 1 in ${view}. Full body, relaxed standing pose with arms down. ${SAME} ${extra} ${BG}`, refs: ['character'], cut: true });
  } else if (o.recipe === 'parts') {
    const wanted = o.parts?.length ? PARTS.filter(([k]) => o.parts.includes(k)) : PARTS;
    for (const [key, label, what, rig] of wanted) add({ key, label, prompt: `Draw ${what} from image 1, isolated, centered, nothing else of the body. ${SAME} ${extra} ${BG}`, refs: ['character'], w: 768, h: 768, cut: true, rig });
  } else if (o.recipe === 'animation') {
    const act = ACTIONS[o.action];
    if (!act) throw new Error('Unknown action: ' + o.action);
    const n = Math.max(2, Math.min(act.poses.length, Number(o.frames) || act.poses.length));
    const poses = Array.from({ length: n }, (_, i) => act.poses[Math.floor((i * act.poses.length) / n)]);
    // Every frame is drawn from the character with the SAME seed: same rendering, the pose comes from the text.
    // Chaining the previous frame as a second reference (o.chain) keeps details closer but FLUX.2 tends to copy it.
    poses.forEach((pose, i) => add({
      key: `${o.action}_${String(i + 1).padStart(2, '0')}`, label: `Frame ${i + 1}`,
      prompt: `The character from image 1, full body, ${dir}, animation frame ${i + 1} of ${n} of a ${o.action} animation. Pose: ${pose}. The legs and arms must clearly be in exactly this position.${o.chain && i ? ' Image 2 is the previous frame: match its drawing style, scale and camera, but the pose must change.' : ''} ${SAME} ${extra} ${BG}`,
      refs: o.chain && i ? ['character', 'prev'] : ['character'], w: 768, h: 768, cut: true, frame: i,
    }));
  } else if (o.recipe === 'expressions') {
    for (const [key, label, face] of EXPRESSIONS) add({ key, label, prompt: `Head and shoulders portrait of the character from image 1, front view, ${face}. ${SAME} ${extra} ${BG}`, refs: ['character'], w: 768, h: 768, cut: true });
  } else if (o.recipe === 'storyboard') {
    const scenes = (o.scenes || []).map(clean).filter(Boolean).slice(0, 16);
    if (!scenes.length) throw new Error('Describe the storyboard frames: one per line.');
    scenes.forEach((scene, i) => add({
      key: 'shot_' + String(i + 1).padStart(2, '0'), label: `Shot ${i + 1}`, caption: scene,
      prompt: `Storyboard frame, cinematic composition, 16:9: ${scene}.${o.hasCharacter ? ' The main character looks exactly like the character in image 1.' : ''} ${extra}`.trim(),
      refs: o.hasCharacter ? ['character'] : [], w: 1344, h: 768,
    }));
  } else if (o.recipe === 'poses3d') {
    const n = Math.max(1, Math.min(24, Number(o.poses) || 0));
    if (!o.poses) throw new Error('Add pose pictures (frames of a 3D clip).');
    for (let i = 0; i < n; i++) add({
      key: 'pose_' + String(i + 1).padStart(2, '0'), label: `Pose ${i + 1}`,
      prompt: `Draw the character from image 1 in exactly the same body pose, camera angle and framing as the figure in image 2. Take only the pose from image 2. ${SAME} ${extra} ${BG}`,
      refs: ['character', 'pose:' + i], w: 768, h: 768, cut: true, frame: i,
    });
  } else if (o.recipe === 'restyle') {
    const n = Math.max(1, Math.min(24, Number(o.inputs) || 0));
    if (!o.inputs) throw new Error('Add pictures to redraw.');
    for (let i = 0; i < n; i++) add({
      key: 'restyle_' + String(i + 1).padStart(2, '0'), label: `Picture ${i + 1}`,
      prompt: `Redraw image 1 keeping its exact composition, pose, silhouette and colors. ${extra}`.trim(),
      refs: ['input:' + i], w: 1024, h: 1024, sizeFromRef: true,
    });
  }
  return shots;
}

/** Text appended to every prompt for the chosen style; with a style image the instruction refers to the last ref. */
export function styleSuffix(styleId, { styleImage = false } = {}) {
  const s = STYLES[styleId] || STYLES.painted;
  return styleImage ? '' : ' Art style: ' + s.prompt + '.';
}
