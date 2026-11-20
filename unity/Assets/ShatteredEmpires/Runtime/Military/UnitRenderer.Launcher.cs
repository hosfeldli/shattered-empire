using System;
using SE.Core.Units;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// The missile battery sets up to fire (2026-11-19, server ACTION_UNITS.missile_battery.setup = 5 s). Its launch pod
    /// is drawn apart from the chassis: flat on the load bed for travel; while the server reports it setting up (flag
    /// 1024) the four stabiliser jacks lower and the pod eases up about its rear hinge to the firing angle over the set-up
    /// time; deployed (512) it stays raised along the hull, which the server keeps turned onto the target; on the move it
    /// folds back down. The eased 0..1 progress lives in deployState (the mortar team's, unused by vehicles). The raised
    /// pod's tip is kept per unit so missile launches leave from it (GameBootstrap.WeaponMuzzle).
    /// </summary>
    public sealed partial class UnitRenderer
    {
        /// <summary>Pod hinge on the chassis (model units): the close-range RocketTruck and the operational MeshKit.Rocket.</summary>
        static readonly float3 PodHinge = new float3(0, .20f, -.46f), PodHingeLo = new float3(0, .20f, -.5f);
        /// <summary>From the hinge to the middle of the tubes' muzzles, along the pod (model units).</summary>
        static readonly float3 PodMuzzle = new float3(0, .09f, .58f), PodMuzzleLo = new float3(0, .12f, .6f);
        const float PodElevation = 40f * Mathf.Deg2Rad;
        /// <summary>Seconds the pod takes to raise while setting up (the server's set-up is 5 s; the flag lands a tick late).</summary>
        const float PodRaiseTime = 4.8f;
        /// <summary>Stabiliser jacks under the housings at the bed's corners (lateral, along; model units).</summary>
        static readonly float2[] JackSpots = { new float2(-.27f, -.47f), new float2(.27f, -.47f), new float2(-.27f, .12f), new float2(.27f, .12f) };
        float3[] launcherTip = new float3[0];

        void LauncherStep(int slot, int flags, bool moving)
        {
            if (launcherTip.Length != deployState.Length) Array.Resize(ref launcherTip, deployState.Length);
            bool deployed = (flags & DeployedFlag) != 0, settingUp = (flags & SettingUpFlag) != 0;
            bool want = !moving && (deployed || settingUp);
            // raise over the set-up time, finish quickly once deployed, fold down briskly to drive off
            float rate = !want ? (moving ? 1.3f : .6f) : deployed ? 1.2f : 1f / PodRaiseTime;
            deployState[slot] = Mathf.MoveTowards(deployState[slot], want ? 1f : 0f, frameDt * rate);
        }

        /// <summary>Jacks first (the first third), then the pod (from a quarter on), both eased.</summary>
        void LauncherPose(int slot, out float jacks, out float raise)
        {
            float d = slot < deployState.Length ? deployState[slot] : 0f;
            jacks = Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(d / .35f));
            raise = Mathf.SmoothStep(0f, 1f, Mathf.Clamp01((d - .25f) / .75f));
        }

        /// <summary>The pod (raised by the pose) and the stabiliser jacks, on a chassis drawn at <paramref name="at"/> (Unity space).</summary>
        void AddLauncherRig(int slot, float3 at, quaternion rot, float scale, float4 paint, bool operational)
        {
            LauncherPose(slot, out float jacks, out float raise);
            var tilt = quaternion.RotateX(-PodElevation * raise);   // nose up about the rear hinge
            var hinge = operational ? PodHingeLo : PodHinge;
            var podAt = at + math.rotate(rot, hinge * scale);
            var podRot = math.mul(rot, tilt);
            if (operational) batches[(int)Model.LauncherPod].Add(InstanceData.TRS(podAt, podRot, new float3(scale), paint));
            else details[(int)Detail.RocketPod].Add(InstanceData.TRS(podAt, podRot, new float3(scale), paint));
            // where a missile leaves: the muzzle end of the pod, as an offset from the unit's ground point in map space
            var tip = math.rotate(rot, (hinge + math.rotate(tilt, operational ? PodMuzzleLo : PodMuzzle)) * scale);
            if (slot < launcherTip.Length) launcherTip[slot] = new float3(tip.x, tip.y, -tip.z);
            if (jacks <= .01f) return;
            // stabilisers: a leg runs down out of each housing to a foot pad on the ground
            var steel = new float4(.50f, .53f, .52f, 0f);
            float top = .17f, foot = Mathf.Lerp(.15f, -.004f, jacks);
            foreach (var j in JackSpots)
            {
                var footAt = at + math.rotate(rot, new float3(j.x, foot, j.y) * scale);
                batches[(int)Model.Plate].Add(InstanceData.TRS(footAt, rot, new float3(.024f, top - foot, .024f) * scale, steel));
                batches[(int)Model.Plate].Add(InstanceData.TRS(footAt, rot, new float3(.075f * jacks, .014f, .075f * jacks) * scale, steel));
            }
        }

        /// <summary>
        /// Where a missile battery's missile leaves its raised pod, as an offset from the unit's ground point (map space).
        /// False when the unit is not a drawn launcher.
        /// </summary>
        public bool TryLauncherTip(UnitStore store, int id, out float3 offset)
        {
            offset = default;
            if (!store.SlotOf.TryGetValue(id, out int s) || s >= launcherTip.Length || s >= ids.Length || ids[s] != id) return false;
            offset = launcherTip[s];
            return math.lengthsq(offset) > 0f;
        }
    }
}
