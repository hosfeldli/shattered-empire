using SE.Core.Protocol;
using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// Effects pass (2026-11-18, docs/gameplay-overhaul/EFFECTS.md): presentation of missile interceptions and the
    /// trees a strategic blast knocks down.
    ///
    /// Trees: the server clears the FOREST hexes a blast flattens (server/sim/shockwave.js; they arrive as ordinary
    /// geo updates and lose their forest). The sparse trees other biomes carry (groves on grassland, hill and
    /// tundra trees, and the grove trees a cleared hex keeps as grassland) are client scenery the server does not
    /// track, so the client knocks them down itself with the same height-aware shock field
    /// (<see cref="SE.Runtime.Effects.EffectsRenderer.ShockFallChance"/>): every tree in the core, then each tree
    /// with the fall chance of its hex. They go through the terrain's sticky TreeScars bits, so they stay down for
    /// the session (a reconnect regrows these sparse trees; the cleared forest itself is server state and stays cleared).
    /// </summary>
    public sealed partial class GameBootstrap
    {
        readonly HashSet<int> knockedChunks = new HashSet<int>();

        /// <summary>'mintercept': an air-defense interceptor kills a missile (s interceptor at ax/az, kill point bx/bz, w weapon).</summary>
        void PresentIntercept(CombatEvent e)
        {
            var world = session.World;
            var from = EventPoint(e, true, .1f);
            var at = EventPoint(e, false, 0);
            string weapon = e.Weapon >= 0 ? ProtocolDecoder.Str(session.Defs?["WEAPON_KEYS"]?[e.Weapon], "") : "";
            bool strategic = weapon == "warhead";
            if (!strategic && !Near(at, Mathf.Max(60f, rts.Distance * 3f))) return;
            from.x = world.Grid.NearX(from.x, at.x);
            fx.MissileIntercept(from, at, strategic);
            audioDirector?.Play(strategic ? "explosion_big" : "flak", at, 1f, strategic ? 30f : 6f, 3, rts.Distance);
        }

        /// <summary>Knock down the scenery trees inside the strategic shock in fx slot `slot` (see the class notes).</summary>
        void KnockTrees(int slot)
        {
            if (slot < 0 || terrain == null || fx == null) return;
            var world = session.World;
            var grid = world.Grid;
            var scars = terrain.TreeScars;
            if (scars == null || scars.Length != grid.N) return;
            var p = fx.ShockPoint(slot);
            float far = fx.ShockFar(slot) + 1f;
            knockedChunks.Clear();
            for (int t = 0; t < grid.N; t++)
            {
                float dz = grid.CenterZ(t) - p.z;
                if (dz > far || dz < -far) continue;
                float dx = grid.DxWrap(p.x, grid.CenterX(t));
                if (dx * dx + dz * dz > far * far) continue;
                float chance = fx.ShockFallChance(slot, dx, dz);
                if (chance <= 0f) continue;
                uint bits = 0;
                if (chance >= 1f) bits = ~0u;
                else for (int b = 0; b < 32; b++) if (TreeHash(t, b) < chance) bits |= 1u << b;
                if ((scars[t] | bits) == scars[t]) continue;
                scars[t] |= bits;
                knockedChunks.Add(world.ChunkOf(t));
            }
            if (knockedChunks.Count > 0) terrain.MarkDirty(knockedChunks);
        }

        static float TreeHash(int tile, int tree)
        {
            uint h = (uint)tile * 2654435761u ^ (uint)(tree + 1) * 2246822519u;
            h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
            return (h & 0xFFFFFF) / 16777216f;
        }
    }
}
