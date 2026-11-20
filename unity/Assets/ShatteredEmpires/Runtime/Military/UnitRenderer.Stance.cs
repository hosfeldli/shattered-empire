using SE.Runtime.Rendering;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Military
{
    /// <summary>
    /// 2026-11-19 (user: "unit outlines should get a border type based on their stance"): the team / selection ring
    /// under a ground unit is drawn in a style that encodes its stance. Solid: defensive, the default (the plain ring); dashed:
    /// aggressive; double: holding position (server flag 2048, whatever the stance); dotted: hold fire. Server stance
    /// indices follow actionOrders.js STANCES: 0 aggressive, 1 defensive, 2 holdFire. Each style has a squad-width band
    /// (thin, like Model.RingThin) and a vehicle-width band (like Model.Ring); one instanced batch per mesh.
    /// The legend is in the hover card (Hud.StanceRingName) and the Field Guide ("Stance rings").
    /// </summary>
    public sealed partial class UnitRenderer
    {
        /// <summary>Holding position (Commander.HoldingFlag; the server's unit flag 2048).</summary>
        const int HoldPositionFlag = 2048;
        public const int RingSolid = 0, RingDashed = 1, RingDouble = 2, RingDotted = 3;

        // [style - 1, wide ? 1 : 0] for the three non-solid styles; the solid style uses Model.Ring / Model.RingThin
        readonly InstanceBatch[] stanceRings = new InstanceBatch[6];
        static Mesh[] stanceMeshes;

        /// <summary>The ring style for a unit's stance index (-1 unknown) and flags.</summary>
        public static int RingStyleOf(int stance, int flags)
        {
            if ((flags & HoldPositionFlag) != 0) return RingDouble;
            // defensive (the server default) keeps the calm plain ring; only a changed stance breaks the outline
            return stance == 0 ? RingDashed : stance == 2 ? RingDotted : RingSolid;
        }

        void CreateStanceRings()
        {
            if (stanceMeshes == null)
            {
                stanceMeshes = new Mesh[6];
                for (int wide = 0; wide < 2; wide++)
                {
                    // the plain rings' bands: vehicles .42-.5, squads (thin) .465-.5 of the unit diameter
                    float inner = wide == 1 ? .465f : .42f;
                    float band = .5f - inner;
                    stanceMeshes[0 * 2 + wide] = Dashes(wide == 1 ? 18 : 12, .62f, inner, .5f, "ring_dashed" + wide);
                    stanceMeshes[2 * 2 + wide] = Dashes(wide == 1 ? 40 : 24, .34f, inner - band * .1f, .5f + band * .1f, "ring_dotted" + wide);
                    // double: a slightly narrower outer band and a second band one band-width inside it
                    var mb = new MeshBuilder();
                    Arc(mb, 72, 1f, .5f - band * .75f, .5f);
                    Arc(mb, 72, 1f, .5f - band * 2.35f, .5f - band * 1.6f);
                    stanceMeshes[1 * 2 + wide] = mb.Build("ring_double" + wide);
                }
            }
            for (int i = 0; i < stanceRings.Length; i++)
                stanceRings[i] = new InstanceBatch(stanceMeshes[i], RenderResources.Instanced, 256)
                { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
        }

        /// <summary>count dashes round the ring, each covering <paramref name="fill"/> of its period, between radii r0 and r1.</summary>
        static Mesh Dashes(int count, float fill, float r0, float r1, string name)
        {
            var mb = new MeshBuilder();
            float period = Mathf.PI * 2 / count;
            for (int k = 0; k < count; k++)
            {
                float a = k * period, span = period * fill;
                int steps = Mathf.Max(1, Mathf.CeilToInt(span / (Mathf.PI / 24)));
                for (int j = 0; j < steps; j++)
                {
                    float a0 = a + span * j / steps, a1 = a + span * (j + 1) / steps;
                    mb.Quad(RingPoint(a0, r0), RingPoint(a1, r0), RingPoint(a1, r1), RingPoint(a0, r1), Color.white);
                }
            }
            return mb.Build(name);
        }

        static void Arc(MeshBuilder mb, int segments, float fill, float r0, float r1)
        {
            float step = Mathf.PI * 2 * fill / segments;
            for (int k = 0; k < segments; k++)
                mb.Quad(RingPoint(k * step, r0), RingPoint((k + 1) * step, r0), RingPoint((k + 1) * step, r1), RingPoint(k * step, r1), Color.white);
        }

        static Vector3 RingPoint(float a, float r) => new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r);

        /// <summary>The batch for a non-solid stance ring, or null for the plain (solid) one.</summary>
        InstanceBatch StanceRing(int style, bool wide) => style <= RingSolid || style > RingDotted ? null : stanceRings[(style - 1) * 2 + (wide ? 1 : 0)];

        void ClearStanceRings() { foreach (var b in stanceRings) b?.Clear(); }
        void UploadStanceRings() { foreach (var b in stanceRings) b?.Upload(); }
        void DrawStanceRings() { foreach (var b in stanceRings) b?.Draw(); }
        void DisposeStanceRings() { foreach (var b in stanceRings) b?.Dispose(); }
        int StanceRingInstances() { int n = 0; foreach (var b in stanceRings) if (b != null) n += b.Count; return n; }
    }
}
