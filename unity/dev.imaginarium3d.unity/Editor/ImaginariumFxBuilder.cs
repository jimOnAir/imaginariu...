using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Imaginarium.Editor
{
    /// <summary>
    /// Imaginarium FX presets (scripts/blender/data/fx_presets.json, made for Godot GPUParticles3D) as Unity
    /// Particle Systems. The FX object emits along its local +Y like the Godot node; vectors arrive already in
    /// Unity axes. VFX Graph is not used: it needs its own package and compute support on every platform.
    /// </summary>
    public static class ImaginariumFxBuilder
    {
        public static GameObject BuildPrefab(ImaginariumPackageData pkg, ImaginariumFxPresetData f, ImaginariumRenderPipeline pipeline)
        {
            var dir = pkg.folder + "/fx";
            Directory.CreateDirectory(dir);
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(dir + "/textures/" + f.texture + ".png");
            var mat = ImaginariumPipeline.BuildParticleMaterial(dir + "/" + f.id + ".mat", tex, f.blend != "mix", pipeline);

            var go = new GameObject("fx_" + f.id);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            Configure(ps, f);
            var r = go.GetComponent<ParticleSystemRenderer>();
            r.renderMode = ParticleSystemRenderMode.Billboard;
            r.alignment = ParticleSystemRenderSpace.View;
            r.sharedMaterial = mat;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            r.maxParticleSize = 5f;
            if (f.has_light)
            {
                var lgo = new GameObject("light");
                lgo.transform.SetParent(go.transform, false);
                var l = lgo.AddComponent<Light>();
                l.type = LightType.Point;
                l.color = new Color(f.light_color[0], f.light_color[1], f.light_color[2]);
                l.intensity = f.light_energy;
                l.range = Mathf.Max(0.01f, f.light_range);
                l.shadows = LightShadows.None;
            }
            var path = dir + "/" + f.id + ".prefab";
            var prefab = PrefabUtility.SaveAsPrefabAsset(go, path);
            Object.DestroyImmediate(go);
            return prefab;
        }

        static ParticleSystem.MinMaxCurve Range(float[] v, float k = 1f) =>
            v != null && v.Length >= 2 && Mathf.Abs(v[0] - v[1]) > 1e-6f
                ? new ParticleSystem.MinMaxCurve(v[0] * k, v[1] * k)
                : new ParticleSystem.MinMaxCurve((v != null && v.Length > 0 ? v[0] : 0f) * k);

        static float Avg(float[] v) => v == null || v.Length == 0 ? 0f : v.Average();

        public static void Configure(ParticleSystem ps, ImaginariumFxPresetData f)
        {
            float life = Mathf.Max(0.02f, f.lifetime);
            var main = ps.main;
            main.duration = Mathf.Max(0.05f, life);
            main.loop = !f.one_shot;
            main.playOnAwake = f.autostart && !f.one_shot;
            main.startLifetime = life;
            main.maxParticles = Mathf.Max(1, f.amount);
            main.startSpeed = Range(f.velocity);
            main.startSize = Range(f.scale, f.quad_size);
            main.startRotation = Range(f.angle, Mathf.Deg2Rad);
            main.startColor = Color.white;
            main.simulationSpace = f.local_coords ? ParticleSystemSimulationSpace.Local : ParticleSystemSimulationSpace.World;
            main.scalingMode = ParticleSystemScalingMode.Local;
            main.gravityModifier = 0f;

            var em = ps.emission;
            em.enabled = true;
            if (f.one_shot || f.explosiveness >= 0.5f)
            {
                em.rateOverTime = 0f;
                em.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(f.amount, 1, short.MaxValue)) });
            }
            else
            {
                em.rateOverTime = f.amount / life;
                em.SetBursts(new ParticleSystem.Burst[0]);
            }

            var dir = ImaginariumPackageData.V3(f.direction, Vector3.up);
            if (dir.sqrMagnitude < 1e-8f) dir = Vector3.up;
            dir.Normalize();
            var sh = ps.shape;
            sh.enabled = true;
            float spread = Mathf.Clamp(f.spread, 0f, 180f);
            sh.rotation = Quaternion.FromToRotation(Vector3.forward, dir).eulerAngles;
            switch (f.emission_shape)
            {
                case "box":
                    sh.shapeType = ParticleSystemShapeType.Box;
                    sh.scale = ImaginariumPackageData.V3(f.extents) * 2f;
                    sh.randomDirectionAmount = spread / 180f;
                    break;
                case "sphere_surface":
                    sh.shapeType = ParticleSystemShapeType.Sphere;
                    sh.radius = Mathf.Max(1e-4f, f.radius);
                    sh.radiusThickness = 0f;
                    break;
                case "ring":
                    sh.shapeType = ParticleSystemShapeType.Cone;
                    sh.radius = Mathf.Max(1e-4f, f.radius);
                    sh.radiusThickness = f.radius > 1e-4f ? Mathf.Clamp01((f.radius - f.inner_radius) / f.radius) : 1f;
                    sh.angle = Mathf.Min(spread, 89.9f);
                    sh.rotation = Quaternion.FromToRotation(Vector3.forward,
                        ImaginariumPackageData.V3(f.ring_axis, Vector3.up).normalized).eulerAngles;
                    break;
                case "sphere":
                    if (spread >= 90f)
                    {
                        sh.shapeType = ParticleSystemShapeType.Sphere;
                        sh.radius = Mathf.Max(1e-4f, f.radius);
                    }
                    else
                    {
                        sh.shapeType = ParticleSystemShapeType.Cone;
                        sh.radius = Mathf.Max(1e-4f, f.radius);
                        sh.angle = spread;
                    }
                    break;
                default:                                     // point
                    if (spread >= 90f)
                    {
                        sh.shapeType = ParticleSystemShapeType.Sphere;
                        sh.radius = 1e-4f;
                    }
                    else
                    {
                        sh.shapeType = ParticleSystemShapeType.Cone;
                        sh.radius = 1e-4f;
                        sh.angle = spread;
                    }
                    break;
            }

            var g = ImaginariumPackageData.V3(f.gravity);
            var force = ps.forceOverLifetime;
            force.enabled = g.sqrMagnitude > 1e-8f;
            force.space = ParticleSystemSimulationSpace.World;
            force.x = g.x; force.y = g.y; force.z = g.z;

            float damp = Avg(f.damping), speed = Mathf.Max(0.1f, Avg(f.velocity));
            var lim = ps.limitVelocityOverLifetime;
            lim.enabled = damp > 1e-4f;
            lim.limit = 1000f;
            lim.drag = damp / speed;
            lim.multiplyDragByParticleSize = false;
            lim.multiplyDragByParticleVelocity = false;

            float radial = Avg(f.radial_accel), tang = Avg(f.tangential_accel);
            var vel = ps.velocityOverLifetime;
            vel.enabled = Mathf.Abs(radial) > 1e-4f || Mathf.Abs(tang) > 1e-4f;
            if (vel.enabled)
            {
                vel.space = ParticleSystemSimulationSpace.Local;
                vel.x = 0f; vel.y = 0f; vel.z = 0f;
                vel.radial = radial * life * 0.5f;
                vel.orbitalY = tang * 0.5f;
            }

            var rot = ps.rotationOverLifetime;
            rot.enabled = Mathf.Abs(Avg(f.angular_velocity)) > 1e-4f || Mathf.Abs(f.angular_velocity[0] - f.angular_velocity[1]) > 1e-4f;
            if (rot.enabled) rot.z = Range(f.angular_velocity, Mathf.Deg2Rad);

            var sol = ps.sizeOverLifetime;
            sol.enabled = f.scale_curve != null && f.scale_curve.Length > 0;
            if (sol.enabled)
            {
                var curve = new AnimationCurve(f.scale_curve.Select(k => new Keyframe(k.t, k.v)).ToArray());
                sol.size = new ParticleSystem.MinMaxCurve(1f, curve);
            }

            var col = ps.colorOverLifetime;
            col.enabled = f.color_ramp != null && f.color_ramp.Length > 0;
            if (col.enabled)
            {
                var keys = Pick(f.color_ramp, 8);
                var grad = new Gradient();
                grad.SetKeys(keys.Select(k => new GradientColorKey(new Color(k.r, k.g, k.b), k.t)).ToArray(),
                             keys.Select(k => new GradientAlphaKey(k.a, k.t)).ToArray());
                col.color = grad;
            }

            var noise = ps.noise;
            noise.enabled = f.turbulence > 1e-4f;
            if (noise.enabled)
            {
                noise.strength = f.turbulence;
                noise.frequency = 0.6f;
                noise.scrollSpeed = 0.3f;
            }
        }

        static ImaginariumColorKeyData[] Pick(ImaginariumColorKeyData[] keys, int max)
        {
            if (keys.Length <= max) return keys;
            var outp = new ImaginariumColorKeyData[max];
            for (int i = 0; i < max; i++) outp[i] = keys[Mathf.RoundToInt(i * (keys.Length - 1) / (float)(max - 1))];
            return outp;
        }
    }
}
