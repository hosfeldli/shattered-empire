using System;
using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.UIElements;
using SE.Core.Protocol;

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

        /// <summary>A floating "+5 Materials" / "+5 Energy" over a cache: one per 5 supplies collected (gradual pickups).</summary>
        public void ShowPickupReward(float3 point, int amount, float time, string resource = "materials")
        {
            bool energy = resource == "energy";
            if (amount > 0 && !energy) pickupIncome.Add((time, amount));
            if (pickupRewards.Count >= 12) { pickupRewards[0].Label.RemoveFromHierarchy(); pickupRewards.RemoveAt(0); }
            var label = L($"+{amount} {(energy ? "Energy" : "Materials")}", "pickup-reward"); label.pickingMode = PickingMode.Ignore;
            label.EnableInClassList("energy", energy);
            // rises over the world for 1.9 s: moved by translate (no layout pass per frame)
            label.style.left = 0; label.style.top = 0; label.usageHints = UsageHints.DynamicTransform;
            root.Add(label);
            pickupRewards.Add(new PickupReward { Label = label, Point = new Vector3(point.x, point.y, point.z), At = time });
        }
        // a bar over each cache units are collecting from: the share still on the map
        readonly Dictionary<int, VisualElement> pickupBars = new Dictionary<int, VisualElement>();
        readonly List<int> pickupBarsGone = new List<int>();

        /// <summary>Progress bars over the caches being collected; <paramref name="project"/> maps a cache to the screen.</summary>
        public void DrawPickupProgress(Func<ResourcePickup, Vector3> project)
        {
            pickupBarsGone.Clear();
            foreach (var id in pickupBars.Keys)
                if (MenuVisible || !session.Pickups.TryGetValue(id, out var p) || p.Collecting <= 0 || p.Memory) pickupBarsGone.Add(id);
            foreach (int id in pickupBarsGone) { pickupBars[id].RemoveFromHierarchy(); pickupBars.Remove(id); }
            if (MenuVisible) return;
            foreach (var p in session.Pickups.Values)
            {
                if (p.Collecting <= 0 || p.Memory || p.Max <= 0) continue;
                if (!pickupBars.TryGetValue(p.Id, out var bar))
                {
                    bar = new VisualElement { pickingMode = PickingMode.Ignore, usageHints = UsageHints.DynamicTransform };
                    bar.AddToClassList("pickup-progress");
                    bar.EnableInClassList("energy", p.Resource == "energy");
                    var fill = new VisualElement { pickingMode = PickingMode.Ignore };
                    fill.AddToClassList("pickup-progress-fill");
                    bar.Add(fill);
                    root.Add(bar);
                    pickupBars[p.Id] = bar;
                }
                bar[0].style.width = Length.Percent(Mathf.Clamp01(p.Amount / (float)p.Max) * 100f);
                var sp = project(p);
                var pp = ToPanel(sp);
                bar.style.translate = new Translate(pp.x - 32, pp.y - 3);
                bar.style.display = sp.z > 0 ? DisplayStyle.Flex : DisplayStyle.None;
            }
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
