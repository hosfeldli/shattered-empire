using System;
using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    public sealed partial class Hud
    {
        sealed class PickupReward { public Label Label; public Vector3 Point; public float At; }
        readonly List<PickupReward> pickupRewards = new List<PickupReward>(12);
        // Materials collected from pickups (time, amount): the top bar's average income includes the last minute
        readonly List<(float at, int amount)> pickupIncome = new List<(float, int)>(32);

        /// <summary>Materials per second from pickups over the last 60 s.</summary>
        float PickupIncome(float time)
        {
            int sum = 0;
            for (int i = pickupIncome.Count - 1; i >= 0; i--)
            {
                if (time - pickupIncome[i].at > 60f || pickupIncome[i].at > time + 1f) { pickupIncome.RemoveAt(i); continue; }
                sum += pickupIncome[i].amount;
            }
            return sum / 60f;
        }

        public void ShowPickupReward(float3 point, int amount, float time)
        {
            if (amount > 0) pickupIncome.Add((time, amount));
            if (pickupRewards.Count >= 12) { pickupRewards[0].Label.RemoveFromHierarchy(); pickupRewards.RemoveAt(0); }
            var label = L($"+{amount} Materials", "pickup-reward"); label.pickingMode = PickingMode.Ignore;
            // rises over the world for 1.9 s: moved by translate (no layout pass per frame)
            label.style.left = 0; label.style.top = 0; label.usageHints = UsageHints.DynamicTransform;
            root.Add(label);
            pickupRewards.Add(new PickupReward { Label = label, Point = new Vector3(point.x, point.y, point.z), At = time });
        }
        public void DrawPickupRewards(Func<Vector3, Vector3> project, float time)
        {
            for (int i = pickupRewards.Count - 1; i >= 0; i--)
            {
                var reward = pickupRewards[i]; float elapsed = time - reward.At;
                if (elapsed > 1.9f || MenuVisible) { reward.Label.RemoveFromHierarchy(); pickupRewards.RemoveAt(i); continue; }
                var sp = project(reward.Point + Vector3.up * (.10f + elapsed * .07f));
                var p = ToPanel(sp); reward.Label.style.translate = new Translate(p.x - 55, p.y - 16);
                reward.Label.style.opacity = Mathf.Clamp01((1.9f - elapsed) * 2);
                reward.Label.style.display = sp.z > 0 ? DisplayStyle.Flex : DisplayStyle.None;
            }
        }
    }
}
