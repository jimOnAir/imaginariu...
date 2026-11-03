using UnityEngine;

namespace Game
{
    /// <summary>
    /// Third-person / top-down controller for an AstraForge character prefab: WASD or a gamepad stick, the
    /// character turns toward the movement direction and plays idle / walk (or run) through the package's
    /// AFAnimations. Tick() stays public so EditMode tests drive it without Play mode. Template of the
    /// astraforge-integrator skill.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    public class PlayerController : MonoBehaviour
    {
        public float speed = 3.5f;
        public float turnSpeedDeg = 720f;
        public float gravity = -20f;
        public string idleClip = "idle";
        public string moveClip = "walk";
        public bool readInput = true;
        [Tooltip("Camera-relative movement when set (top-down / third-person camera).")]
        public Transform cameraTransform;

        [HideInInspector] public Vector2 input;
        public string CurrentClip { get; private set; }

        CharacterController _cc;
        AstraForge.AFAnimations _anims;
        float _vy;

        void Awake() => Init();

        /// <summary>Component lookups; Awake does not run for components added inside EditMode tests.</summary>
        public void Init()
        {
            _cc = GetComponent<CharacterController>();
            _anims = GetComponentInParent<AstraForge.AFAnimations>() ?? GetComponentInChildren<AstraForge.AFAnimations>();
        }

        void Update()
        {
            if (readInput) input = ReadInput();
            Tick(Time.deltaTime);
        }

        static Vector2 ReadInput()
        {
#if ENABLE_INPUT_SYSTEM
            var k = UnityEngine.InputSystem.Keyboard.current;
            var g = UnityEngine.InputSystem.Gamepad.current;
            var v = Vector2.zero;
            if (k != null)
                v = new Vector2((k.dKey.isPressed ? 1 : 0) - (k.aKey.isPressed ? 1 : 0), (k.wKey.isPressed ? 1 : 0) - (k.sKey.isPressed ? 1 : 0));
            if (g != null && g.leftStick.ReadValue().sqrMagnitude > v.sqrMagnitude) v = g.leftStick.ReadValue();
            return v;
#else
            return new Vector2(Input.GetAxisRaw("Horizontal"), Input.GetAxisRaw("Vertical"));
#endif
        }

        public void Tick(float dt)
        {
            if (_cc == null) Init();
            var move = new Vector3(input.x, 0f, input.y);
            if (cameraTransform != null)
            {
                var f = Vector3.ProjectOnPlane(cameraTransform.forward, Vector3.up).normalized;
                var r = Vector3.ProjectOnPlane(cameraTransform.right, Vector3.up).normalized;
                move = r * input.x + f * input.y;
            }
            if (move.sqrMagnitude > 1f) move.Normalize();
            var moving = move.sqrMagnitude > 1e-4f;
            if (moving)
            {
                var target = Quaternion.LookRotation(move, Vector3.up);
                transform.rotation = Quaternion.RotateTowards(transform.rotation, target, turnSpeedDeg * dt);
            }
            _vy = _cc.isGrounded ? -1f : _vy + gravity * dt;
            _cc.Move((move * speed + Vector3.up * _vy) * dt);
            Play(moving ? moveClip : idleClip);
        }

        void Play(string clip)
        {
            if (clip == CurrentClip) return;
            CurrentClip = clip;
            if (_anims != null) _anims.Play(clip, 0.12f);
        }
    }
}
