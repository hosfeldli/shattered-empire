using System;
using System.Collections.Generic;
using System.Reflection;
using SE.Runtime.Session;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Team colours for the world (buildings, flags, base markings, territory borders), read from the
    /// session's relation palette (ClientSession.CivColor: the local player always blue, allies teal,
    /// each rival a distinct red/orange/magenta/yellow/violet). In action mode the session returns LINEAR
    /// rgb; city tints are sRGB-style albedo values (the shaders decode them), so they are re-encoded here,
    /// otherwise every accent would come out dark and muddy.
    ///
    /// <see cref="Key"/> changes when the identity of "us" or the civ roster changes, so coloured cells can
    /// be recomposed. The session is found once by reflection behind the raw delegate (the bootstrap hands
    /// the renderer only <c>id => session.CivColor(id)</c>); without it, the owner last passed to a
    /// placement ghost stands in for the local civ.
    /// </summary>
    public sealed class TeamPalette
    {
        /// <summary>The session's civ colours.</summary>
        public Func<int, float4> Raw = _ => new float4(.6f, .6f, .6f, 0);
        /// <summary>True when Raw returns linear rgb (the action-mode relation palette).</summary>
        public bool LinearSource;
        /// <summary>Last owner handed to a placement ghost: always the local civ.</summary>
        public int GhostOwner = int.MinValue;

        readonly Dictionary<int, float4> cache = new Dictionary<int, float4>();
        object reflectedTarget;
        FieldInfo sessionField;
        bool searched;
        long key = long.MinValue;

        ClientSession Session()
        {
            var target = Raw?.Target;
            if (target is ClientSession direct) return direct;
            if (target == null) return null;
            if (!searched || !ReferenceEquals(target, reflectedTarget))
            {
                searched = true; reflectedTarget = target; sessionField = null;
                try
                {
                    foreach (var f in target.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
                        if (typeof(ClientSession).IsAssignableFrom(f.FieldType)) { sessionField = f; break; }
                }
                catch (Exception) { sessionField = null; }
            }
            try { return sessionField?.GetValue(target) as ClientSession; }
            catch (Exception) { return null; }
        }

        public int Local
        {
            get
            {
                var s = Session();
                if (s != null && s.CivId >= 0) return s.CivId;
                return GhostOwner != int.MinValue ? GhostOwner : -1;
            }
        }

        public long Key
        {
            get
            {
                var s = Session();
                int civs = s?.Welcome?.Civs?.Length ?? 0;
                return ((long)Local << 20) ^ ((long)civs << 8) ^ (LinearSource ? 2 : 0) ^ (s?.Spectator == true ? 1 : 0);
            }
        }

        /// <summary>Call once per frame; true when cached colours were discarded (recompose coloured geometry).</summary>
        public bool Refresh()
        {
            long k = Key;
            if (k == key) return false;
            key = k;
            cache.Clear();
            return true;
        }

        /// <summary>The owner's team colour as sRGB-style albedo (what city tints and the territory texture use).</summary>
        public float4 Color(int id)
        {
            if (cache.TryGetValue(id, out var cached)) return cached;
            var raw = Raw != null ? Raw(id) : new float4(.6f, .6f, .6f, 0);
            if (LinearSource)
                raw = new float4(Mathf.LinearToGammaSpace(math.max(raw.x, 0)), Mathf.LinearToGammaSpace(math.max(raw.y, 0)),
                    Mathf.LinearToGammaSpace(math.max(raw.z, 0)), raw.w);
            cache[id] = raw;
            return raw;
        }

        public bool IsLocal(int id) => id >= 0 && id == Local;
    }
}
