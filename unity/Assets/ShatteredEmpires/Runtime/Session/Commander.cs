using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.CameraControl;
using SE.Runtime.Input;
using SE.Runtime.Military;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Selection and orders. Selection feedback is immediate and local; orders are intents sent to the
    /// server with a visible pending state until the server accepts or refuses them. A refusal shows
    /// the server's reason; nothing is ever reported as refused unless the server said so.
    /// </summary>
    public sealed class Commander
    {
        readonly ClientSession session;
        readonly RtsCamera cam;
        readonly UnitRenderer units;
        Vector2 dragStart;
        bool dragging;
        float lastClick;
        public readonly List<Order> Orders = new List<Order>();
        public string Feedback = "";
        public float FeedbackUntil;

        public sealed class Order
        {
            public Vector3 MapPoint;
            public int Rid;
            public string State = "pending";   // pending, accepted, refused
            public string Reason;
            public float Time;
        }

        public Commander(ClientSession s, RtsCamera c, UnitRenderer u) { session = s; cam = c; units = u; }

        public bool Dragging(out Rect rect)
        {
            var p = InputFacade.MousePosition;
            rect = Rect.MinMaxRect(Mathf.Min(dragStart.x, p.x), Mathf.Min(dragStart.y, p.y), Mathf.Max(dragStart.x, p.x), Mathf.Max(dragStart.y, p.y));
            return dragging && rect.width > 6 && rect.height > 6;
        }

        bool ScreenOf(int slot, out Vector2 screen)
        {
            screen = default;
            ref var u = ref session.Units.Records[slot];
            if (!units.TryGetPosition(session.Units, u.Id, out var xz)) return false;
            var g = session.World.Grid;
            float x = g.NearX(xz.x, cam.Focus.x);
            var p = cam.ToScreen(new Vector3(x, session.World.GroundHeight(x, xz.y), xz.y));
            if (p.z <= 0) return false;
            screen = p;
            return true;
        }

        public void Update(float time, bool pointerOverUi)
        {
            if (!session.Ready) return;
            var mouse = InputFacade.MousePosition;
            if (!pointerOverUi && InputFacade.LeftDown) { dragStart = mouse; dragging = true; }
            if (dragging && InputFacade.LeftUp)
            {
                dragging = false;
                bool add = InputFacade.Shift;
                if (!add) units.Selected.Clear();
                var rect = Rect.MinMaxRect(Mathf.Min(dragStart.x, mouse.x), Mathf.Min(dragStart.y, mouse.y), Mathf.Max(dragStart.x, mouse.x), Mathf.Max(dragStart.y, mouse.y));
                bool box = rect.width > 6 && rect.height > 6;
                bool doubleClick = !box && time - lastClick < 0.3f;
                lastClick = time;
                int best = -1; float bestD = 18f * 18f; int bestType = -1;
                var st = session.Units;
                for (int s = 0; s < st.SlotCount; s++)
                {
                    ref var u = ref st.Records[s];
                    if (!u.InUse || (u.Owner != session.CivId && !session.Spectator)) continue;
                    if (!ScreenOf(s, out var sp)) continue;
                    if (box) { if (rect.Contains(sp)) units.Selected.Add(u.Id); continue; }
                    float d = (sp - mouse).sqrMagnitude;
                    if (d < bestD) { bestD = d; best = u.Id; bestType = u.TypeIndex; }
                }
                if (best >= 0)
                {
                    units.Selected.Add(best);
                    if (doubleClick)
                        for (int s = 0; s < st.SlotCount; s++)
                        {
                            ref var u = ref st.Records[s];
                            if (u.InUse && u.Owner == session.CivId && u.TypeIndex == bestType && ScreenOf(s, out var sp) && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height) units.Selected.Add(u.Id);
                        }
                }
            }
            // forget units that left view or died
            units.Selected.RemoveWhere(id => !session.Units.SlotOf.ContainsKey(id));
            if (!pointerOverUi && InputFacade.RightDown && units.Selected.Count > 0 && cam.TryGround(mouse, out var ground))
            {
                int tile = session.World.Grid.TileAt(ground.x, ground.z);
                if (tile >= 0) Move(tile, ground, InputFacade.Shift || InputFacade.Ctrl, time);
            }
            if (units.Selected.Count > 0 && InputFacade.Pressed(KeyCode.H)) Stance("hold", time);
            Orders.RemoveAll(o => time - o.Time > (o.State == "pending" ? 8f : 1.5f));
        }

        void Move(int tile, Vector3 point, bool attackMove, float time)
        {
            var ids = new JArray();
            foreach (var id in units.Selected) ids.Add(id);
            var order = new Order { MapPoint = point, Time = time };
            Orders.Add(order);
            var cmd = new JObject { ["c"] = "move", ["units"] = ids, ["tile"] = tile };
            if (attackMove) cmd["attackMove"] = true;
            order.Rid = session.Net?.Command(cmd, r => Resolve(order, r)) ?? -1;
            if (session.Net == null) order.State = "accepted";
        }

        void Stance(string stance, float time)
        {
            var ids = new JArray();
            foreach (var id in units.Selected) ids.Add(id);
            session.Net?.Command(new JObject { ["c"] = "stance", ["units"] = ids, ["stance"] = stance }, r => Say(r.Error ?? "Holding position", time));
        }

        void Resolve(Order order, ServerMessage reply)
        {
            order.Time = Time.unscaledTime;
            if (reply.Error != null) { order.State = "refused"; order.Reason = reply.Error; Say(reply.Error, order.Time); }
            else order.State = "accepted";
        }

        void Say(string text, float time) { Feedback = text; FeedbackUntil = time + 3f; }
    }
}
