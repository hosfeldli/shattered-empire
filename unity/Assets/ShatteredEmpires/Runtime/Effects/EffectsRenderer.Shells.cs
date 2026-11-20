using Unity.Mathematics;
using UnityEngine;
using SE.Runtime.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Indirect-fire rounds in flight (2026-11-19, user: "increase the shell size of mortars slightly so they are more
    /// visible, or mortar like projectiles"). Mortar bombs and howitzer shells were a .007 tracer glow like bullets; now
    /// each is a small dark body pointed along its arc (a finned teardrop bomb for the mortar, a banded ogive shell, a
    /// little larger, for the howitzer), drawn larger than true scale so it reads at gameplay zoom, with a faint short
    /// smoke wisp behind it. No glow: they are not missiles.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        InstanceBatch mortarBodies, shellBodies;
        static Mesh mortarBombMesh, artilleryShellMesh;
        /// <summary>Drawn length (world units) of a mortar bomb and of a howitzer shell; true size would be ~.024 / ~.035.</summary>
        const float MortarBombSize = .052f, ArtilleryShellSize = .064f, EmplacementShellSize = .078f;

        static Mesh MortarBomb() => mortarBombMesh ??= new MeshBuilder()
            // along +z, about 1 unit long: tail boom and fins, the fat teardrop body, a short fuze
            .Beam(new Vector3(0, 0, -.58f), new Vector3(0, 0, -.30f), .045f, .05f, 8, Color.white)
            .Box(new Vector3(0, -.13f, -.52f), new Vector3(.018f, .26f, .16f), Color.white)
            .Box(new Vector3(0, -.009f, -.52f), new Vector3(.26f, .018f, .16f), Color.white)
            .Beam(new Vector3(0, 0, -.32f), new Vector3(0, 0, .08f), .07f, .155f, 10, Color.white)
            .Beam(new Vector3(0, 0, .08f), new Vector3(0, 0, .36f), .155f, .05f, 10, Color.white)
            .Beam(new Vector3(0, 0, .36f), new Vector3(0, 0, .44f), .05f, .025f, 6, new Color(.8f, .72f, .45f))
            .Build("Mortar bomb");

        static Mesh ArtilleryShell() => artilleryShellMesh ??= new MeshBuilder()
            // along +z: a flat-based cylinder, the copper driving band, an ogive nose and its fuze
            .Beam(new Vector3(0, 0, -.5f), new Vector3(0, 0, .12f), .13f, .13f, 10, Color.white)
            .Beam(new Vector3(0, 0, -.40f), new Vector3(0, 0, -.33f), .142f, .142f, 10, new Color(.85f, .55f, .32f), false)
            .Beam(new Vector3(0, 0, .12f), new Vector3(0, 0, .44f), .13f, .035f, 10, Color.white)
            .Beam(new Vector3(0, 0, .44f), new Vector3(0, 0, .52f), .035f, .015f, 6, new Color(.8f, .72f, .45f))
            .Build("Artillery shell");

        void BeginShells()
        {
            mortarBodies ??= new InstanceBatch(MortarBomb(), RenderResources.Instanced, 64) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e4f) };
            shellBodies ??= new InstanceBatch(ArtilleryShell(), RenderResources.Instanced, 64) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e4f) };
            mortarBodies.Clear(); shellBodies.Clear();
        }

        void EndShells() { mortarBodies?.MarkDirty(); shellBodies?.MarkDirty(); }

        void DrawShells(WrapImages images) { mortarBodies?.DrawImages(images); shellBodies?.DrawImages(images); }

        void DisposeShells() { mortarBodies?.Dispose(); shellBodies?.Dispose(); mortarBodies = shellBodies = null; }

        /// <summary>The Artillery Emplacement's heavy gun: a long muzzle flash, a ring of blast smoke and a drifting cloud.</summary>
        public void ArtilleryBlast(float3 p, float3 direction)
        {
            var forward = math.normalizesafe(new float3(direction.x, 0, direction.z), new float3(0, 0, 1));
            Emit(p + forward * .05f, float3.zero, .05f, 0, .09f, new float3(1, .85f, .45f), new float3(.95f, .35f, .06f), 1f, true, 1.4f, 0, 0, Streak, forward * .3f);
            Emit(p + forward * .03f, float3.zero, .07f, .1f, .08f, new float3(1, .8f, .45f), new float3(.9f, .4f, .1f), .8f, true, 1f);
            for (int k = 0; k < 6; k++)
            {
                float a = k * math.PI / 3f;
                var side = new float3(math.sin(a), 0, math.cos(a));
                Emit(p + side * .03f, side * .22f + forward * .12f + new float3(0, .05f, 0), .06f, .28f, 1.4f,
                    new float3(.55f, .54f, .5f), new float3(.66f, .65f, .62f), .26f, false, 0, 1.6f, .03f);
            }
            Emit(p + forward * .08f, Wind * .1f + new float3(0, .08f, 0), .12f, .5f, 2.2f, new float3(.5f, .5f, .48f), new float3(.64f, .64f, .62f), .28f, false, 0, 1f, .04f);
            FlashLight(p, .8f);
        }

        /// <summary>One frame of a shell's flight: the body along the arc, a puff of thin smoke every few lengths.</summary>
        void ShellTravel(ref Flight f, float3 p, float3 heading, float moved)
        {
            bool mortar = f.Shell == 1;
            float size = mortar ? MortarBombSize : f.Shell == 3 ? EmplacementShellSize : ArtilleryShellSize;
            var rot = quaternion.LookRotationSafe(MapSpace.W(heading), new float3(0, 1, 0));
            var color = mortar ? new float4(.24f, .26f, .22f, 0) : new float4(.33f, .34f, .30f, 0);
            (mortar ? mortarBodies : shellBodies).Add(InstanceData.TRS(MapSpace.W(p), rot, new float3(size), color));
            f.TrailDistance += moved;
            if (f.TrailDistance < size * 1.6f || f.Age < .05f) return;
            f.TrailDistance = 0;
            Emit(p - heading * size * .6f, Wind * .06f, size * .28f, size * .9f, mortar ? .45f : .55f,
                new float3(.70f, .70f, .68f), new float3(.62f, .63f, .63f), mortar ? .16f : .2f, false, 0, .6f, .01f);
        }
    }
}
