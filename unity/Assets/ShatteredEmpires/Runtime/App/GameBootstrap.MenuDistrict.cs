using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    public sealed partial class GameBootstrap
    {
        float menuSnapshotAt, menuStarted;
        Vector2 menuHeadquarters;

        void StageMenuWorld()
        {
            var w = session.World; var g = w.Grid;
            int center = -1; float best = float.MaxValue;
            bool Dry(float x, float z)
            {
                int t = g.TileAt(x, z);
                return t >= 0 && w.Biome[t] >= 2 && w.Biome[t] < 8 && !w.IsLake(t) && !w.IsRiver(t);
            }
            for (int t = 0; t < g.N; t++)
            {
                float x = g.CenterX(t), z = g.CenterZ(t);
                if (!Dry(x, z)) continue;
                bool fit = true;
                for (int i = 0; i < 8 && fit; i++)
                {
                    float a = .44f + i * math.PI / 4;
                    float px = x + math.sin(a) * 2.0f, pz = z + math.cos(a) * 1.9f;
                    fit = Dry(px - .5f, pz) && Dry(px + .5f, pz) && Dry(px, pz - .5f) && Dry(px, pz + .5f);
                }
                if (!fit) continue;
                float score = Mathf.Abs(t % g.W - g.W * .5f) + Mathf.Abs(t / g.W - g.H * .5f) + w.Height[t] * 7;
                if (score < best) { best = score; center = t; }
            }
            if (center < 0) center = g.N / 2;
            menuHeadquarters = new Vector2(g.CenterX(center), g.CenterZ(center));
            var parcels = new BaseParcel[9];
            parcels[0] = new BaseParcel { Tile = center, Id = 0, Tier = 1, X = menuHeadquarters.x, Z = menuHeadquarters.y, Yaw = .44f, Width = 1.12f, Depth = 1.12f };
            var buildings = new List<BuildingRecord>();
            BuildingRecord Record(string type, BaseParcel p, int id) => new BuildingRecord
            { Id = id, City = 1, Slot = p.Id, Type = type, Tile = p.Tile, Owner = 0, Hp = 100, Done = true, Active = true,
                Progress = 100, Tier = 2, Era = 1, Level = 1, HasPosition = true, HasYaw = true, X = p.X, Z = p.Z, Yaw = p.Yaw };
            buildings.Add(Record("town", parcels[0], 1000));
            string[] types = { "depot", "motor_works", "barracks", null, "power_plant", "airfield", "armory", null };
            for (int i = 0; i < 8; i++)
            {
                float angle = .44f + i * math.PI / 4, radius = 1.92f + math.sin(i * 2.1f) * .09f;
                float x = menuHeadquarters.x + math.sin(angle) * radius * 1.05f, z = menuHeadquarters.y + math.cos(angle) * radius * .96f;
                var p = new BaseParcel { Id = 17 + i, Tier = i % 2 == 0 ? 1 : i == 1 || i == 5 ? 2 : 3, Tile = g.TileAt(x, z), X = x, Z = z,
                    Yaw = Mathf.Atan2(menuHeadquarters.x - x, menuHeadquarters.y - z), Width = .96f, Depth = .90f };
                parcels[i + 1] = p;
                if (types[i] != null) buildings.Add(Record(types[i], p, 1001 + i));
                w.Owner[p.Tile] = 0; w.Urban[p.Tile >> 3] |= (byte)(1 << (p.Tile & 7));
            }
            var site = new ObjectiveSite { Id = 1, Tile = center, X = menuHeadquarters.x, Z = menuHeadquarters.y, IsBase = true, Owner = 0,
                Headquarters = 1000, Tier = 2, VisualTier = 2, Capacity = 6, RingVersion = 1, Operational = true, Maturity = 35, Name = "Reclamation Command", Kind = "military", Parcels = parcels, Slots = Array.Empty<int>() };
            session.Objectives.Clear(); session.Objectives[1] = site;
            city.ActionRts = true; city.SetShowcaseRoads(null); city.SetObjectives(session.Objectives.Values);
            session.Structures.ApplyBuildings(buildings.ToArray(), w, session.DirtyCells);
            int road = center;
            for (int i = 0; i < 7; i++)
            {
                int next = g.Nb[road * 6]; if (next < 0 || !Dry(g.CenterX(next), g.CenterZ(next))) break;
                w.Road[road] |= 2; w.Road[next] |= 2 << 12; road = next;
            }
            w.ApplyUrban(w.Urban); w.MarkRoadsChanged(); session.Age = 1;
            // Offline set dressing: clustered woodland beyond the operating compound.
            // Nothing changes the authoritative match world or its navigation.
            for (int t = 0; t < g.N; t++)
            {
                float x = g.CenterX(t) - menuHeadquarters.x, z = g.CenterZ(t) - menuHeadquarters.y;
                if (x * x + z * z < 16 || !Dry(g.CenterX(t), g.CenterZ(t)) || w.IsUrban(t) || w.Road[t] != 0) continue;
                bool grove = (x + 4.5f) * (x + 4.5f) / 8 + (z - 3.8f) * (z - 3.8f) / 6 < 1 ||
                    (x - 4.8f) * (x - 4.8f) / 10 + (z - 4.9f) * (z - 4.9f) / 7 < 1;
                if (grove && t % 7 != 0) w.Biome[t] = 4;
            }
            terrain.MarkAllDirty();
            rts.Focus = new Vector3(menuHeadquarters.x - .70f, 0, menuHeadquarters.y + .35f);
            rts.Distance = rts.TargetDistance = 10.5f; rts.Yaw = -32; rts.PitchOverride = 33; rts.Apply();
            atmosphere.MenuMood();
            menuStarted = time; menuSnapshotAt = 0;
        }

        void AnimateMenuWorld()
        {
            if (time < menuSnapshotAt) return; menuSnapshotAt = time + .18f;
            var actors = new UnitWire[5]; var g = session.World.Grid;
            for (int i = 0; i < actors.Length; i++)
            {
                float x = menuHeadquarters.x + 2.6f + (i % 2) * .37f, z = menuHeadquarters.y + (i - 2) * .49f;
                actors[i] = new UnitWire { Id = 50 + i, Type = i < 2 ? "tank" : "rifle_squad", Owner = 0, Tile = g.TileAt(x, z), Next = -1, Hp = 100, Supply = 100, AirState = -1,
                    Motion = new WorldMotion { Present = true, X = x, Z = z, Yaw = math.PI * .5f } };
            }
            session.Units.Apply(new SnapshotMessage { Time = time - menuStarted + 1, Units = actors });
        }
    }
}
