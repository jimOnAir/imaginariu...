using System;
using System.Collections.Generic;
using UnityEngine;

namespace Imaginarium
{
    /// <summary>Passport of an Imaginarium prefab: where it came from and what the importer built.</summary>
    [DisallowMultipleComponent]
    public class ImaginariumAssetInfo : MonoBehaviour
    {
        public string assetId;
        public string kind;
        public string rig;
        public Vector3 sizeMeters;
        public string stamp;
        public string generator = "imaginarium-unity-importer";
    }
}
