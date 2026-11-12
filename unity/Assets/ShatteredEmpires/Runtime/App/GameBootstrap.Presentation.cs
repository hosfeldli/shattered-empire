using SE.Core.Protocol;
using SE.Core.World;
using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    public sealed partial class GameBootstrap
    {
        float3 EventPoint(CombatEvent e, bool origin, float lift)
        {
            bool exact = origin ? e.HasOrigin : e.HasDestination;
            int id = origin ? e.Shooter : e.Target;
            if (!exact) return UnitOrTile(id, origin ? e.From : e.To, lift);
            float x = origin ? e.Origin.X : e.Destination.X, z = origin ? e.Origin.Z : e.Destination.Z;
            float altitude = session.Units.TryGet(id, out var u) && u.Motion.Present ? u.Motion.Altitude : 0;
            return new float3(x, session.World.GroundHeight(x, z) + lift + altitude, z);
        }

        float3 WeaponMuzzle(int id, float3 source, float3 target)
        {
            if (!session.ActionRts) return source;
            var dir = math.normalizesafe(new float3(target.x - source.x, 0, target.z - source.z));
            if (!session.Units.TryGet(id, out var u)) return source + new float3(0, .13f, 0);
            string type = session.Units.Types.Name(u.TypeIndex);
            bool infantry = type == "militia" || type == "rifle_squad" || type == "engineer" || type == "special_forces" || type == "anti_armor" || type == "exo_infantry";
            float length = infantry ? .035f : type.Contains("tank") || type == "sp_artillery" ? .30f : .12f;
            return source + dir * length + new float3(0, infantry ? .035f : .04f, 0);
        }
    }
}
