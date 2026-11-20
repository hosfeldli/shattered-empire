using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Visuals of the per-building upgrades (2026-11-20, docs/gameplay-overhaul/BASE_MENU_REWORK.md §6, §7). Keyed on the
    /// building record fields the server sends: <c>Path</c> ("aa" / "ai" / "av") and <c>Level</c> (path level 1..3) on the
    /// perimeter turrets (city_turret), <c>Gun</c> (0..3) on the headquarters (town), <c>Level</c> on an outpost (fort).
    /// <list type="bullet">
    /// <item>Perimeter anti-air: the AA battery's twin flak head (quad at level 2+), a rotating radar dish at level 3.</item>
    /// <item>Perimeter anti-infantry: the twin MG head (heavier at level 2+), a grenade launcher box from level 2 and a
    /// searchlight at level 3, both turning with the head.</item>
    /// <item>Perimeter anti-vehicle: the anti-armour emplacement's long cannon head, a wire-guided missile box at level 3.</item>
    /// <item>Headquarters centre turret (Gun 1..3): a gun turret on the roof mount (the AT heads: longer barrel at 2, twin
    /// heavy barrels at 3) with a small spinning fuze radar from level 2.</item>
    /// <item>Outpost level 3: a radar mast with a spinning dish and a red beacon inside the fort.</item>
    /// </list>
    /// Turning props are boxes in their own head batch (drawn and cleared with the heads in AnimateTurrets), so nothing
    /// is recomposed per frame and no new asset is needed. Facility level props are CityRenderer.LevelDressing.cs.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        // TurretMount.Kit bits
        const int MountGrenade = 1, MountSearchlight = 2, MountMissiles = 4, MountRadar = 8, MountFuzeRadar = 16, MountMast = 32;
        const string KitBoxKey = "\u0001upgrade_kit_boxes";
        static readonly string[] AaHeads = { "Def_aa_head1", "Def_aa_head2", "Def_aa_head3" };
        static readonly string[] MgHeads = { "Def_mg_head1", "Def_mg_head2", "Def_mg_head3" };
        static readonly string[] AtHeads = { "Def_at_head1", "Def_at_head2", "Def_at_head3" };

        static string HeadAt(string[] heads, int level)
        {
            int i = Mathf.Clamp(level, 1, 3) - 1;
            return ModelLibrary.Get(heads[i]) != null ? heads[i] : heads[0];
        }

        /// <summary>
        /// After AuthoredDefense set a mount up: the perimeter turret's head by its chosen path, and the props its level
        /// adds; an outpost's radar mast at level 3. Resets the kit on every other mount.
        /// </summary>
        void UpgradeMount(in BuildingRecord b, TurretMount m, int level)
        {
            m.Scale = 1f; m.Kit = 0;
            if (b.Type == "city_turret")
            {
                switch (b.Path)
                {
                    case "aa":
                        m.Head = HeadAt(AaHeads, level); m.Kind = TurretKind.AntiAir; m.Scale = .78f;
                        if (level >= 3) m.Kit |= MountRadar;
                        break;
                    case "ai":
                        m.Head = HeadAt(MgHeads, level >= 2 ? 3 : 2); m.Kind = TurretKind.MachineGun;   // head 2 is the twin MG
                        if (level >= 2) m.Kit |= MountGrenade;
                        if (level >= 3) m.Kit |= MountSearchlight;
                        break;
                    case "av":
                        m.Head = HeadAt(AtHeads, level); m.Kind = TurretKind.AntiTank; m.Scale = .82f;
                        if (level >= 3) m.Kit |= MountMissiles;
                        break;
                }
            }
            else if ((b.Type == "fort" || b.Type == "outpost") && b.Level >= 3) m.Kit |= MountMast;
        }

        /// <summary>
        /// The headquarters' centre turret (Gun 1..3) on its roof mount; false when it has none (the old city-AA mount
        /// then applies). Called while composing the HQ (<see cref="composing"/> is its id).
        /// </summary>
        bool CentreTurret(in Ctx c, float3 roof)
        {
            if (composing < 0 || !structures.Buildings.TryGetValue(composing, out var hq) || hq.Gun < 1) return false;
            if (c.Stage >= 2) { mounts.Remove(composing); return true; }   // knocked out with the roof
            Put(Part.Cylinder, roof, c.Yaw, new float3(.17f, .02f, .17f), new float3(.62f, .61f, .57f) * c.Tint);
            if (!mounts.TryGetValue(composing, out var mount)) mounts[composing] = mount = new TurretMount { Aim = c.Yaw };
            mount.Pivot = roof + new float3(0, .02f, 0);
            mount.Rest = c.Yaw; mount.Head = HeadAt(AtHeads, hq.Gun); mount.Kind = TurretKind.AntiTank; mount.Level = hq.Gun;
            mount.Memory = hq.Memory; mount.Color = math.lerp(new float3(.86f, .87f, .82f), c.Civ, .55f) * c.Tint;
            mount.Scale = .8f; mount.Kit = hq.Gun >= 2 ? MountFuzeRadar : 0;
            return true;
        }

        InstanceBatch KitBoxes()
        {
            if (headBatches.TryGetValue(KitBoxKey, out var batch)) return batch;
            batch = new InstanceBatch(MeshKit.Box, RenderResources.Instanced, 32) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
            headBatches[KitBoxKey] = batch;
            return batch;
        }

        /// <summary>A box centred at <paramref name="local"/> (times <paramref name="k"/>) in a Unity frame, turned about its centre.</summary>
        static void MountBox(InstanceBatch batch, float3 at, quaternion frame, float k, float3 local, quaternion turn, float3 size, float3 color, float glow = 0)
        {
            var q = math.mul(frame, turn);
            var centre = at + math.rotate(frame, local * k);
            batch.Add(InstanceData.TRS(centre - math.rotate(q, new float3(0, size.y * .5f * k, 0)), q, size * k, new float4(color, glow)));
        }

        /// <summary>The upgrade props of one mount, per frame (from AnimateTurrets, after its head).</summary>
        void MountKit(TurretMount m, float3 pivot, float time, int id)
        {
            var batch = KitBoxes();
            float k = m.Scale, dim = m.Memory ? .6f : 1f, glow = m.Memory ? 0f : 1f;
            var at = MapSpace.W(pivot);
            var aim = quaternion.RotateY(MapSpace.Yaw(m.Aim));
            var rest = quaternion.RotateY(MapSpace.Yaw(m.Rest));
            var none = quaternion.identity;
            float3 dark = new float3(.16f, .17f, .16f) * dim, steel = new float3(.55f, .57f, .56f) * dim, olive = new float3(.32f, .35f, .23f) * dim;
            var spin = quaternion.RotateY(m.Memory ? 0f : time * 1.8f + id * .7f);
            if ((m.Kit & MountGrenade) != 0)
            {
                // automatic grenade launcher on the head's left cheek
                MountBox(batch, at, aim, k, new float3(-.1f, .06f, .05f), none, new float3(.05f, .05f, .13f), olive);
                MountBox(batch, at, aim, k, new float3(-.1f, .06f, .125f), none, new float3(.032f, .032f, .03f), dark);
            }
            if ((m.Kit & MountSearchlight) != 0)
            {
                // searchlight on a yoke over the right of the head, its lens lit
                MountBox(batch, at, aim, k, new float3(.08f, .1f, 0), none, new float3(.015f, .05f, .015f), dark);
                MountBox(batch, at, aim, k, new float3(.08f, .15f, .01f), none, new float3(.075f, .07f, .07f), steel);
                MountBox(batch, at, aim, k, new float3(.08f, .15f, .048f), none, new float3(.06f, .055f, .008f), new float3(1f, .94f, .74f) * dim, 1.4f * glow);
            }
            if ((m.Kit & MountMissiles) != 0)
            {
                // wire-guided missile box on the left of the cannon
                MountBox(batch, at, aim, k, new float3(-.16f, .11f, .04f), none, new float3(.075f, .085f, .24f), olive);
                for (int t = -1; t <= 1; t += 2)
                    MountBox(batch, at, aim, k, new float3(-.16f + t * .018f, .11f, .162f), none, new float3(.026f, .026f, .008f), dark);
            }
            if ((m.Kit & MountRadar) != 0)
            {
                // search radar on a post behind the flak head, rotating
                MountBox(batch, at, rest, k, new float3(0, .14f, -.24f), none, new float3(.03f, .28f, .03f), dark);
                var dish = math.mul(spin, quaternion.RotateX(-.3f));
                MountBox(batch, at, rest, k, new float3(0, .3f, -.24f), dish, new float3(.2f, .11f, .014f), steel);
                MountBox(batch, at, rest, k, new float3(0, .3f, -.24f) + math.rotate(dish, new float3(0, 0, .04f)), dish, new float3(.014f, .014f, .06f), dark);
            }
            if ((m.Kit & MountFuzeRadar) != 0)
            {
                // the centre gun's small fuze radar beside it
                MountBox(batch, at, rest, k, new float3(.16f, .06f, -.13f), none, new float3(.022f, .12f, .022f), dark);
                MountBox(batch, at, rest, k, new float3(.16f, .135f, -.13f), math.mul(spin, quaternion.RotateX(-.25f)), new float3(.11f, .07f, .012f), steel);
            }
            if ((m.Kit & MountMast) != 0)
            {
                // outpost radar mast: a braced lattice post from the court floor (the fort's mount is .19 above it)
                var foot = new float3(-.2f, -.19f, -.17f);
                MountBox(batch, at, rest, 1f, foot + new float3(0, .31f, 0), none, new float3(.035f, .62f, .035f), steel);
                for (int r = 0; r < 3; r++)
                    MountBox(batch, at, rest, 1f, foot + new float3(0, .12f + r * .17f, 0), quaternion.RotateY(r * .8f), new float3(.08f, .012f, .012f), dark);
                var dish = math.mul(spin, quaternion.RotateX(-.3f));
                MountBox(batch, at, rest, 1f, foot + new float3(0, .66f, 0), dish, new float3(.22f, .12f, .016f), steel);
                MountBox(batch, at, rest, 1f, foot + new float3(0, .74f, 0), none, new float3(.022f, .022f, .022f), new float3(.95f, .15f, .1f) * dim,
                    glow * (.6f + .6f * math.step(.5f, math.frac(time * .8f + id * .13f))));
            }
        }
    }
}
