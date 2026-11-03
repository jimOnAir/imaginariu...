using System;
using System.Collections.Generic;
using UnityEngine;

namespace AstraForge
{
    /// <summary>Named attachment points (contract §6: socket_&lt;kind&gt;_&lt;place&gt;). Sockets on bones follow the animation.</summary>
    [DisallowMultipleComponent]
    public class AFSockets : MonoBehaviour
    {
        [Serializable]
        public struct Entry
        {
            public string name;
            public Transform transform;
        }

        public List<Entry> sockets = new List<Entry>();

        public Transform Get(string socketName)
        {
            foreach (var e in sockets)
                if (e.name == socketName) return e.transform;
            return null;
        }

        /// <summary>Parent an object to a socket keeping its local pose (weapon in hand, rider on a mount...).</summary>
        public bool Attach(string socketName, Transform item, bool resetLocal = true)
        {
            var s = Get(socketName);
            if (s == null || item == null) return false;
            item.SetParent(s, !resetLocal);
            if (resetLocal)
            {
                item.localPosition = Vector3.zero;
                item.localRotation = Quaternion.identity;
            }
            return true;
        }
    }
}
