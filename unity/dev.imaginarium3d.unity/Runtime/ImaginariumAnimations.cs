using System;
using System.Collections.Generic;
using UnityEngine;

namespace Imaginarium
{
    /// <summary>Plays the clips of an Imaginarium model by name (states of the generated Animator Controller).</summary>
    [DisallowMultipleComponent]
    public class ImaginariumAnimations : MonoBehaviour
    {
        public Animator animator;
        public string defaultClip;
        public List<string> clips = new List<string>();

        void Reset() { animator = GetComponentInChildren<Animator>(); }

        public bool Play(string clip, float fade = 0.15f)
        {
            if (animator == null || string.IsNullOrEmpty(clip) || !clips.Contains(clip)) return false;
            if (fade > 0f) animator.CrossFadeInFixedTime(clip, fade);
            else animator.Play(clip, 0, 0f);
            return true;
        }
    }
}
