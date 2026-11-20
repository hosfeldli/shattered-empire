using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Defensive range rings (2026-11-19, user: "when you click on a defense it needs to show its range; the game needs
    /// a toggle down by the minimap to enable/disable defensive ranges").
    ///
    /// A selected armed structure draws its weapon range on the ground: a terrain-following ring of short pitched
    /// strips at the server's range (def.range, + .35 per level above 1 as actionUpgrades.structureRange, + the garrison
    /// bonus while occupied), and a dashed inner ring for a minimum range when the definition has one (def.minRange,
    /// the dead zone). With <see cref="ShowDefenseRanges"/> on (the minimap console toggle, saved in GameSettings),
    /// every defense in view does the same: ours and allies' in their team colour, enemy defenses we can see (not fog
    /// memories) in red. Rebuilt every frame from the structure store (no state to go stale), capped to the nearest 96.
    /// </summary>
    public sealed partial class Commander
    {
        /// <summary>Draw the range of every defense in view (the HUD's minimap toggle; persisted by the HUD).</summary>
        public bool ShowDefenseRanges { get; set; }

        InstanceBatch rangeLines;
        const int MaxRangeRings = 96;

        void DrawDefenseRanges(WrapImages images, float time)
        {
            if (rangeLines == null)
                rangeLines = new InstanceBatch(MeshKit.Box, RenderResources.Instanced, 2048) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, Buffering = 3 };
            rangeLines.Clear();
            var w = session.World;
            var defs = session.Defs?["BUILDINGS"];
            if (!session.ActionRts || !w.Ready || defs == null || session.Structures == null) return;
            if (!ShowDefenseRanges && SelectedBuildings.Count == 0) return;
            var g = w.Grid;
            float reach = cam.Distance * 1.5f + 8f;
            float width = Mathf.Max(.032f, cam.Distance * .0024f);
            float garrisonBonus = ProtocolDecoder.Float(session.Defs?["GARRISON"]?["rangeBonus"], .6f);
            int drawn = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                bool selected = SelectedBuildings.Contains(b.Id);
                if (!selected && !ShowDefenseRanges) continue;
                if (!b.Done || !b.HasPosition) continue;
                var def = defs[b.Type];
                float range = ProtocolDecoder.Float(def?["range"]);
                if (range <= 0 || ProtocolDecoder.Float(def?["attack"]) <= 0) continue;
                bool hostile = session.IsHostile(b.Owner);
                // the toggle shows defenses (def.defense: field structures that fight); a selection shows any armed structure
                if (!selected && (b.Memory || !ProtocolDecoder.Bool(def?["defense"]))) continue;
                float dx = g.DxWrap(cam.Focus.x, b.X), dz = b.Z - cam.Focus.z;
                if (!selected && dx * dx + dz * dz > (reach + range) * (reach + range)) continue;
                if (b.Level > 1 && b.Type != "town") range += .35f * (b.Level - 1);       // actionUpgrades.structureRange
                if (b.Garrison != null && b.Garrison.Length > 0 && ProtocolDecoder.Int(def?["firingSlots"]) > 0) range += garrisonBonus;
                float4 color;
                if (hostile) color = new float4(1f, .30f, .24f, selected ? 1.3f : .8f);
                else
                {
                    var team = session.CivColor(b.Owner).xyz;
                    color = new float4(math.lerp(team, new float3(1f), .35f), selected ? 1.3f : .75f);
                }
                RangeCircle(b.X, b.Z, range, color, selected ? width * 1.6f : width, false);
                float minRange = ProtocolDecoder.Float(def?["minRange"]);
                if (minRange > 0) RangeCircle(b.X, b.Z, minRange, new float4(1f, .62f, .18f, selected ? 1.1f : .6f), width * .9f, true);
                if (++drawn >= MaxRangeRings) break;
            }
            rangeLines.DrawImages(images);
        }

        /// <summary>A ring on the terrain: chords pitched to follow the ground between their ends (dashed: every other one).</summary>
        void RangeCircle(float x, float z, float radius, float4 color, float width, bool dashed)
        {
            var w = session.World;
            int n = Mathf.Clamp(Mathf.CeilToInt(radius * 16f), 28, 192);
            if (dashed && n % 2 == 1) n++;
            float3 Point(int i)
            {
                float a = i * 2f * math.PI / n;
                float px = x + math.sin(a) * radius, pz = z + math.cos(a) * radius;
                return MapSpace.W(new float3(px, w.GroundHeight(px, pz) + .05f, pz));
            }
            var first = Point(0);
            var prev = first;
            for (int i = 1; i <= n; i++)
            {
                var next = i == n ? first : Point(i);
                if (!dashed || i % 2 == 1)
                {
                    var d = next - prev;
                    float length = math.length(d);
                    if (length > 1e-4f)
                    {
                        var q = quaternion.LookRotationSafe(d / length, math.up());
                        rangeLines.Add(InstanceData.TRS((prev + next) * .5f, q, new float3(width, .02f, length * 1.04f), color));
                    }
                }
                prev = next;
            }
        }
    }
}
