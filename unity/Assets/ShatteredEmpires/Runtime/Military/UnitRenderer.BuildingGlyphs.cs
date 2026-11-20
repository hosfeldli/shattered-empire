using System;
using System.Collections.Generic;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Building-type glyphs (overhaul §37, workstream C-D): a small square card over each functional building, in its
    /// owner's frame, with a white sign of what it makes (X barracks, track oval vehicle works, gantry
    /// dot heavy weapons, aircraft airfield, crate depot, bolt generator, diamond lab, arrow silo, battlements defense
    /// works). Square cards with a stem, so they never read as the oblong unit role glyphs.
    /// <para>
    /// Why world-space instanced plates rather than HUD badges: the glyph plates go into the role-glyph batch that is
    /// already rebuilt, uploaded and drawn each frame (one more draw's worth of instances, no UI Toolkit elements to
    /// lay out, position and repaint per building), and they are drawn with the same camera-facing code.
    /// </para>
    /// Zoom: shown from the closer operational zoom out to the strategic switch, hidden at strategic zoom (the badges
    /// take over) and close up (the building is plain to see). Crowding: at most one glyph per screen-sized cell (own
    /// buildings win), at most <see cref="MaxBuildingGlyphs"/>. The O(buildings) pick runs 4 times a second; each
    /// frame only re-emits the picked cards (≤ 64 × 7 plates).
    /// </summary>
    public sealed partial class UnitRenderer
    {
        const int MaxBuildingGlyphs = 64;
        const float GlyphNearDistance = 16f, GlyphRefresh = .25f;

        struct BuildingGlyph { public float X, Y, Z; public int Owner; public byte Kind; public bool Memory, HasAccent; public float3 Accent; }
        readonly BuildingGlyph[] buildingGlyphs = new BuildingGlyph[MaxBuildingGlyphs];
        int buildingGlyphCount;
        float buildingGlyphAt = -10f, buildingGlyphZoom;
        readonly HashSet<long> glyphCells = new HashSet<long>();

        const byte BgNone = 0, BgBarracks = 1, BgVehicles = 2, BgHeavy = 3, BgAirfield = 4, BgDepot = 5, BgPower = 6,
            BgLab = 8, BgSilo = 9, BgWorks = 10;
        // Field defenses (workstream B, 2026-11-18): a diamond card (a square turned 45°), so a defense never reads as
        // a production facility's square card, with a sign of what it fights: MG dot-and-bar, AT long barrel, AA twin
        // barrels skyward, howitzer raised tube, bunker mound, watchtower T, outpost battlements, radar arc, repair cross.
        const byte BgFirstDefense = 11, BgMg = 11, BgAntiTank = 12, BgAntiAir = 13, BgHowitzer = 14, BgBunker = 15, BgTower = 16,
            BgOutpost = 17, BgRadar = 18, BgRepair = 19;

        static byte BuildingGlyphOf(string type) => type switch
        {
            "barracks" => BgBarracks, "motor_works" => BgVehicles, "heavy_weapons" => BgHeavy, "airfield" => BgAirfield,
            "depot" => BgDepot, "power_plant" => BgPower, "advanced_lab" => BgLab,
            "missile_silo" => BgSilo, "defense_works" => BgWorks,
            "city_turret" => BgMg, "turret" or "at_emplacement" => BgAntiTank, "aa_battery" => BgAntiAir, "artillery_post" => BgHowitzer,
            "bunker" => BgBunker, "guard_post" or "watchtower" => BgTower, "fort" or "outpost" => BgOutpost, "sensor_post" => BgRadar,
            "repair_point" => BgRepair, _ => BgNone,
        };

        /// <summary>Pick (4 Hz) and draw (every frame) the building glyphs; called from Update after the units.</summary>
        void BuildingGlyphs(StructureStore structures, WorldModel world, Func<int, float4> civColor, float camX, Vector3 focus, float camDist, float time)
        {
            if (glyphs == null || structures == null) return;
            bool show = camDist >= GlyphNearDistance && camDist <= StrategicDistance;
            if (!show) { buildingGlyphCount = 0; return; }
            var grid = world.Grid;
            if (time >= buildingGlyphAt || time < buildingGlyphAt - 1f || Mathf.Abs(camDist - buildingGlyphZoom) > camDist * .15f)
            {
                buildingGlyphAt = time + GlyphRefresh; buildingGlyphZoom = camDist;
                PickBuildingGlyphs(structures, world, focus, camDist);
            }
            float s = Mathf.Clamp(camDist * .0075f, .07f, 1.1f);
            for (int i = 0; i < buildingGlyphCount; i++)
            {
                ref var g = ref buildingGlyphs[i];
                var team = g.Memory ? new float4(.55f, .55f, .55f, 1) : civColor(g.Owner);
                var centre = MapSpace.W(new float3(grid.NearX(g.X, camX), g.Y, g.Z)) + new float3(0, s * 1.1f, 0);
                BuildingGlyphCard(g.Kind, centre, s, team.xyz, g.HasAccent && !g.Memory ? g.Accent : new float3(-1));
            }
        }

        void PickBuildingGlyphs(StructureStore structures, WorldModel world, Vector3 focus, float camDist)
        {
            buildingGlyphCount = 0;
            glyphCells.Clear();
            var grid = world.Grid;
            var view = world.View;
            float reach = camDist * 1.1f + 3f, cell = camDist * .024f;
            // own buildings first, so the declutter keeps ours where cards would overlap; within each side the
            // production facilities before the (more numerous) field defenses
            for (int pass = 0; pass < 4 && buildingGlyphCount < MaxBuildingGlyphs; pass++)
                foreach (var b in structures.Buildings.Values)
                {
                    if (!b.HasPosition || !b.Done) continue;
                    bool own = IsHostile == null || !IsHostile(b.Owner);
                    if ((pass < 2) != own) continue;
                    byte kind = BuildingGlyphOf(b.Type);
                    if (kind == BgNone || (pass % 2 == 1) != (kind >= BgFirstDefense)) continue;
                    float dx = grid.DxWrap(focus.x, b.X), dz = b.Z - focus.z;
                    if (dx * dx + dz * dz > reach * reach) continue;
                    long key = ((long)Mathf.FloorToInt((focus.x + dx) / cell) << 32) ^ (uint)Mathf.FloorToInt(b.Z / cell);
                    if (!glyphCells.Add(key)) continue;
                    bool accented = SE.Runtime.Cities.CityRenderer.FacilityAccent(b.Type, out var accent);
                    buildingGlyphs[buildingGlyphCount++] = new BuildingGlyph
                    {
                        X = b.X, Z = b.Z, Y = view.GroundHeight(b.X, b.Z) + .55f, Owner = b.Owner, Kind = kind, Memory = b.Memory,
                        HasAccent = accented, Accent = accent,
                    };
                    if (buildingGlyphCount >= MaxBuildingGlyphs) break;
                }
        }

        /// <summary>One plate of a building glyph at (ox, oy) on the card (units of the card scale s).</summary>
        void CardBar(float3 centre, float s, float ox, float oy, float angle, float w, float h, float layer, float4 colour)
            => GlyphBar(centre + math.rotate(cameraRotation, new float3(ox * s, oy * s, 0)), angle, w * s, h * s, layer, s * .04f, colour);

        /// <param name="accent">A base facility's accent colour (CityRenderer.FacilityAccent; x &lt; 0: none): the card wears it, as the roof emblem does.</param>
        void BuildingGlyphCard(byte kind, float3 centre, float s, float3 team, float3 accent)
        {
            float th = s * .04f, L = 2.2f * th;
            var frame = new float4(TeamWear(team), .25f);
            var card = accent.x >= 0 ? new float4(accent * .55f, .25f) : new float4(.13f, .14f, .15f, 0);
            var ink = new float4(.97f, .96f, .92f, .2f);
            const float w = .085f, diag = .785f, right = 1.5708f;
            if (kind >= BgFirstDefense)
            {
                // a diamond card (smaller sign area: the signs below stay inside the inscribed square, ±.27)
                CardBar(centre, s, 0, -.62f, 0, .07f, .22f, 0, frame);
                CardBar(centre, s, 0, 0, diag, .70f, .70f, 0, frame);
                CardBar(centre, s, 0, 0, diag, .58f, .58f, th, card);
                switch (kind)
                {
                    case BgMg:
                        CardBar(centre, s, -.1f, 0, 0, .16f, .16f, L, ink); CardBar(centre, s, .1f, 0, right, w, .3f, L, ink); break;
                    case BgAntiTank:
                        CardBar(centre, s, -.14f, -.04f, 0, .16f, .14f, L, ink); CardBar(centre, s, .09f, -.02f, right, w * .8f, .4f, L, ink); break;
                    case BgAntiAir:
                        CardBar(centre, s, -.06f, .02f, -.6f, w * .8f, .4f, L, ink); CardBar(centre, s, .07f, .02f, -.6f, w * .8f, .4f, L, ink);
                        CardBar(centre, s, 0, -.2f, right, w, .4f, L, ink); break;
                    case BgHowitzer:
                        CardBar(centre, s, .02f, .04f, -1.0f, w, .5f, L, ink); CardBar(centre, s, -.08f, -.18f, right, w, .34f, L, ink); break;
                    case BgBunker:
                        CardBar(centre, s, 0, -.1f, right, .12f, .48f, L, ink); CardBar(centre, s, 0, .04f, right, .1f, .26f, L, ink); break;
                    case BgTower:
                        CardBar(centre, s, 0, -.04f, 0, w, .42f, L, ink); CardBar(centre, s, 0, .17f, right, w, .32f, L, ink); break;
                    case BgOutpost:
                        CardBar(centre, s, 0, -.12f, right, .12f, .46f, L, ink);
                        for (int k = -1; k <= 1; k++) CardBar(centre, s, k * .18f, .04f, 0, .1f, .14f, L, ink);
                        break;
                    case BgRadar:
                        CardBar(centre, s, -.06f, .08f, -.6f, w, .32f, L, ink); CardBar(centre, s, .09f, .06f, .9f, w * .8f, .22f, L, ink);
                        CardBar(centre, s, 0, -.14f, 0, w, .22f, L, ink); break;
                    case BgRepair:
                        CardBar(centre, s, 0, 0, 0, .1f, .42f, L, ink); CardBar(centre, s, 0, 0, right, .1f, .42f, L, ink); break;
                }
                return;
            }
            // a square card with a stem down to the building: an installation, not a unit
            CardBar(centre, s, 0, 0, 0, .86f, .86f, 0, frame);
            CardBar(centre, s, 0, -.55f, 0, .07f, .26f, 0, frame);
            CardBar(centre, s, 0, 0, 0, .72f, .72f, th, card);
            switch (kind)
            {
                case BgBarracks:
                    CardBar(centre, s, 0, 0, diag, w, .82f, L, ink); CardBar(centre, s, 0, 0, -diag, w, .82f, L, ink); break;
                case BgVehicles:
                    CardBar(centre, s, 0, .13f, right, w, .5f, L, ink); CardBar(centre, s, 0, -.13f, right, w, .5f, L, ink);
                    CardBar(centre, s, -.25f, 0, 0, w, .26f, L, ink); CardBar(centre, s, .25f, 0, 0, w, .26f, L, ink); break;
                case BgHeavy:
                    CardBar(centre, s, 0, .06f, diag, .2f, .2f, L, ink); CardBar(centre, s, 0, -.2f, right, w, .52f, L, ink); break;
                case BgAirfield:
                    CardBar(centre, s, 0, 0, 0, w, .6f, L, ink); CardBar(centre, s, 0, .06f, right, w, .62f, L, ink);
                    CardBar(centre, s, 0, -.24f, right, w, .26f, L, ink); break;
                case BgDepot:
                    CardBar(centre, s, 0, .07f, 0, .34f, .26f, L, ink); CardBar(centre, s, 0, -.2f, right, w, .56f, L, ink); break;
                case BgPower:
                    CardBar(centre, s, .07f, .15f, -.5f, w, .32f, L, ink); CardBar(centre, s, 0, 0, 1.2f, w, .26f, L, ink);
                    CardBar(centre, s, -.07f, -.15f, -.5f, w, .32f, L, ink); break;
                case BgLab:
                    CardBar(centre, s, .13f, .13f, diag, w, .38f, L, ink); CardBar(centre, s, -.13f, -.13f, diag, w, .38f, L, ink);
                    CardBar(centre, s, -.13f, .13f, -diag, w, .38f, L, ink); CardBar(centre, s, .13f, -.13f, -diag, w, .38f, L, ink); break;
                case BgSilo:
                    CardBar(centre, s, 0, -.06f, 0, w, .52f, L, ink);
                    CardBar(centre, s, -.08f, .1f, -diag, w, .28f, L, ink); CardBar(centre, s, .08f, .1f, diag, w, .28f, L, ink); break;
                case BgWorks:
                    CardBar(centre, s, 0, -.15f, right, .14f, .58f, L, ink);
                    for (int k = -1; k <= 1; k++) CardBar(centre, s, k * .22f, .04f, 0, .12f, .16f, L, ink);
                    break;
            }
        }
    }
}
