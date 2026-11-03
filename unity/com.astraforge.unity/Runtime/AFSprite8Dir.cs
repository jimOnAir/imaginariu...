using System;
using System.Collections.Generic;
using UnityEngine;

namespace AstraForge
{
    /// <summary>
    /// 8-direction sprite character: the Animator has one state per clip with a 2D directional blend tree over
    /// DirX/DirY (S = (0,-1) faces the camera, N = (0,1) shows the back, E = (1,0) looks right on screen).
    /// </summary>
    [DisallowMultipleComponent]
    public class AFSprite8Dir : MonoBehaviour
    {
        public static readonly string[] Directions = { "S", "SW", "W", "NW", "N", "NE", "E", "SE" };

        public Animator animator;
        public string defaultClip;
        public List<string> clips = new List<string>();
        public Vector2 direction = new Vector2(0f, -1f);

        static readonly int DirX = Animator.StringToHash("DirX");
        static readonly int DirY = Animator.StringToHash("DirY");

        void Reset() { animator = GetComponent<Animator>(); }

        void OnEnable() { Apply(); }

        public static Vector2 ToVector(string dir)
        {
            switch (dir)
            {
                case "S": return new Vector2(0f, -1f);
                case "SW": return new Vector2(-0.7071f, -0.7071f);
                case "W": return new Vector2(-1f, 0f);
                case "NW": return new Vector2(-0.7071f, 0.7071f);
                case "N": return new Vector2(0f, 1f);
                case "NE": return new Vector2(0.7071f, 0.7071f);
                case "E": return new Vector2(1f, 0f);
                case "SE": return new Vector2(0.7071f, -0.7071f);
            }
            return new Vector2(0f, -1f);
        }

        /// <summary>Screen-space direction: x to the right, y away from the camera (up on screen).</summary>
        public void SetDirection(Vector2 screenDir)
        {
            if (screenDir.sqrMagnitude < 1e-6f) return;
            direction = screenDir.normalized;
            Apply();
        }

        /// <summary>World movement direction seen through a camera (top-down / isometric).</summary>
        public void SetWorldDirection(Vector3 worldDir, Camera cam = null)
        {
            cam = cam != null ? cam : Camera.main;
            if (cam == null) { SetDirection(new Vector2(worldDir.x, worldDir.z)); return; }
            var right = Vector3.ProjectOnPlane(cam.transform.right, Vector3.up).normalized;
            var fwd = Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up).normalized;
            SetDirection(new Vector2(Vector3.Dot(worldDir, right), Vector3.Dot(worldDir, fwd)));
        }

        public bool Play(string clip)
        {
            if (animator == null || !clips.Contains(clip)) return false;
            animator.Play(clip, 0, 0f);
            return true;
        }

        void Apply()
        {
            if (animator == null || animator.runtimeAnimatorController == null) return;
            animator.SetFloat(DirX, direction.x);
            animator.SetFloat(DirY, direction.y);
        }
    }
}
