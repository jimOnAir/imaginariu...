using System;
using System.Collections.Generic;
using UnityEngine;

namespace AstraForge
{
    /// <summary>Passport of an AstraForge prefab: where it came from and what the importer built.</summary>
    [DisallowMultipleComponent]
    public class AFAssetInfo : MonoBehaviour
    {
        public string assetId;
        public string kind;
        public string rig;
        public Vector3 sizeMeters;
        public string stamp;
        public string generator = "astraforge-unity-importer";
    }
}
