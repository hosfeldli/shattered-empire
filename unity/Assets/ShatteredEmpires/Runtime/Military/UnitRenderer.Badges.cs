using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Military
{
    /// <summary>
    /// 2026-11-19 (user bug: "unit dots can render under the terrain"): the strategic-zoom unit badges (infantry
    /// discs, vehicle plates, aircraft diamonds and the team circle round them) were laid at the ground height under
    /// the unit's centre only, so a badge wider than the slope it sat on (about 0.8 world units across at strategic
    /// zoom) sank into the uphill side, and the coarse terrain LOD drawn at distance (TerrainRenderer.LodDistance,
    /// hex centre and corners only) can stand above the exact height in hollows and valleys. Now:
    /// <list type="bullet">
    /// <item>the badge stands on the highest ground under its whole footprint (centre and eight points on its rim)
    /// plus a clearance that grows with the camera distance, which covers the LOD's error;</item>
    /// <item>and it is drawn with its own material whose forward pass ignores depth (InstancedLit <c>_ZTest</c> = Always)
    /// in the transparent range, after all opaque geometry, so no hill, building or tree can hide a unit's marker.</item>
    /// </list>
    /// Badges keep their shapes and order (rim first, then the coloured core, within one batch).
    /// </summary>
    public sealed partial class UnitRenderer
    {
        static Material badgeMaterial;
        InstanceBatch badgeDiscs, badgePlates, badgeRings;

        static Material BadgeMaterial
        {
            get
            {
                if (badgeMaterial == null && RenderResources.Instanced != null)
                {
                    badgeMaterial = new Material(RenderResources.Instanced) { name = "SE Unit badges (always visible)", hideFlags = HideFlags.DontSave };
                    badgeMaterial.SetFloat("_ZTest", (float)CompareFunction.Always);
                    badgeMaterial.renderQueue = 2600;   // transparent range: after opaques (and outside any depth prepass)
                }
                return badgeMaterial;
            }
        }

        void CreateBadges()
        {
            var m = BadgeMaterial ?? RenderResources.Instanced;
            badgeDiscs = new InstanceBatch(MeshKit.Disc, m, 128) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
            badgePlates = new InstanceBatch(MeshKit.Box, m, 128) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
            badgeRings = new InstanceBatch(MeshKit.Ring, m, 128) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
        }

        /// <summary>
        /// The height a strategic badge of world radius <paramref name="radius"/> stands at: the highest ground under
        /// its centre and rim, plus a clearance of about 0.35 % of the camera distance (0.25 at strategic zoom).
        /// </summary>
        static float BadgeGround(in TerrainView view, float x, float z, float ground, float radius, float camDist)
        {
            float h = ground;
            for (int k = 0; k < 8; k++)
            {
                float a = k * (math.PI / 4f);
                h = Mathf.Max(h, view.GroundHeight(x + Mathf.Cos(a) * radius, z + Mathf.Sin(a) * radius));
            }
            return h + Mathf.Max(.05f, camDist * .0035f);
        }

        void ClearBadges() { badgeDiscs?.Clear(); badgePlates?.Clear(); badgeRings?.Clear(); }
        void UploadBadges() { badgeDiscs?.Upload(); badgePlates?.Upload(); badgeRings?.Upload(); }
        void DrawBadges() { badgeDiscs?.Draw(); badgePlates?.Draw(); badgeRings?.Draw(); }
        void DisposeBadges() { badgeDiscs?.Dispose(); badgePlates?.Dispose(); badgeRings?.Dispose(); }
        int BadgeInstances() => (badgeDiscs?.Count ?? 0) + (badgePlates?.Count ?? 0) + (badgeRings?.Count ?? 0);
    }
}
