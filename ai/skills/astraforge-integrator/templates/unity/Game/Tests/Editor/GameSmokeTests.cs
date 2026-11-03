using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace Game.Tests
{
    /// <summary>
    /// EditMode smoke tests for the __PLAYER_ID__ player from the AstraForge forge: the prefab exists,
    /// instantiates, and PlayerController.Tick drives movement and clip switching without Play mode
    /// (the recipe from the astraforge-integrator skill: Init(), set input, call Tick, check state).
    /// </summary>
    public class PlayerSmokeTests
    {
        const string PrefabPath = "Assets/AstraForge/__PLAYER_ID__/__PLAYER_ID__.prefab";

        GameObject _instance;

        [TearDown]
        public void TearDown()
        {
            if (_instance != null) Object.DestroyImmediate(_instance);
        }

        [Test]
        public void PrefabExistsAndLoads()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath);
            Assert.IsNotNull(prefab, $"no player prefab at {PrefabPath} (send the package first: af_engine.mjs send)");
        }

        [Test]
        public void PrefabInstantiatesWithTheImportersComponents()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath);
            Assert.IsNotNull(prefab);
            _instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            Assert.IsNotNull(_instance.GetComponentInChildren<Animator>(), "the importer must have created the Avatar/Animator");
            Assert.IsNotNull(_instance.GetComponentInChildren<AstraForge.AFAnimations>(), "the importer must have added AFAnimations");
        }

        [Test]
        public void TickMovesTheCharacterAndSwitchesTheClip()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath);
            Assert.IsNotNull(prefab);
            _instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var player = _instance.AddComponent<Game.PlayerController>();
            player.readInput = false;
            player.Init();
            var start = _instance.transform.position;

            player.input = new Vector2(0f, 1f);
            for (int i = 0; i < 60; i++) player.Tick(1f / 60f);

            var moved = Vector3.Scale(_instance.transform.position - start, new Vector3(1, 0, 1));
            Assert.Greater(moved.magnitude, 0.5f, "60 ticks at full input must travel at least half a metre");
            Assert.AreEqual(player.moveClip, player.CurrentClip, "moving plays the move clip");

            player.input = Vector2.zero;
            for (int i = 0; i < 5; i++) player.Tick(1f / 60f);
            Assert.AreEqual(player.idleClip, player.CurrentClip, "standing plays the idle clip");
        }

        [Test]
        public void CharacterLooksAlongTheMoveDirection()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath);
            Assert.IsNotNull(prefab);
            _instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var player = _instance.AddComponent<Game.PlayerController>();
            player.readInput = false;
            player.Init();
            player.input = new Vector2(0f, 1f);     // +Z: AstraForge characters look along +Z (package contract)
            for (int i = 0; i < 30; i++) player.Tick(1f / 60f);
            Assert.Greater(Vector3.Dot(_instance.transform.forward, Vector3.forward), 0.95f,
                "after turning up the +Z axis the forward vector should point close to +Z");
        }
    }
}
