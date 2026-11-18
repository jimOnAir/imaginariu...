using System;
using System.Collections.Generic;
using UnityEngine;

namespace Imaginarium
{
    /// <summary>Particle effects mounted on sockets; one-shot effects (muzzle flash) are fired with Trigger.</summary>
    [DisallowMultipleComponent]
    public class ImaginariumFxMount : MonoBehaviour
    {
        [Serializable]
        public struct Binding
        {
            public string socket;
            public string preset;
            public ParticleSystem fx;
            public bool oneShot;
        }

        public List<Binding> bindings = new List<Binding>();

        public int Trigger(string socket)
        {
            int n = 0;
            foreach (var b in bindings)
            {
                if (b.fx == null || (socket != null && b.socket != socket)) continue;
                b.fx.Clear(true);
                b.fx.Play(true);
                n++;
            }
            return n;
        }

        public void SetActive(string socket, bool on)
        {
            foreach (var b in bindings)
            {
                if (b.fx == null || (socket != null && b.socket != socket)) continue;
                if (on) b.fx.Play(true); else b.fx.Stop(true, ParticleSystemStopBehavior.StopEmitting);
            }
        }
    }
}
