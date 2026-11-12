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
        public void ShowPickupReward(float3 point, int amount, float time)
        {
            if (pickupRewards.Count >= 12) { pickupRewards[0].Label.RemoveFromHierarchy(); pickupRewards.RemoveAt(0); }
            var label = L($"+{amount} Materials", "pickup-reward", root); label.pickingMode = PickingMode.Ignore;
            pickupRewards.Add(new PickupReward { Label = label, Point = new Vector3(point.x, point.y, point.z), At = time });
        }
        public void DrawPickupRewards(Func<Vector3, Vector3> project, float time)
        {
            for (int i = pickupRewards.Count - 1; i >= 0; i--)
            {
                var reward = pickupRewards[i]; float elapsed = time - reward.At;
                if (elapsed > 1.9f || MenuVisible) { reward.Label.RemoveFromHierarchy(); pickupRewards.RemoveAt(i); continue; }
                var sp = project(reward.Point + Vector3.up * (.10f + elapsed * .07f));
                var p = ToPanel(sp); reward.Label.style.left = p.x - 55; reward.Label.style.top = p.y - 16;
                reward.Label.style.opacity = Mathf.Clamp01((1.9f - elapsed) * 2);
                reward.Label.style.display = sp.z > 0 ? DisplayStyle.Flex : DisplayStyle.None;
            }
        }
    }
}
