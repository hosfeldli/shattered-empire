using SE.Core.World;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using UnityEngine;

namespace SE.Runtime.CameraControl
{
    /// <summary>
    /// Strategy camera: pan (the camera key scheme's pan keys, the arrows, screen edges, middle drag), zoom toward
    /// the cursor, rotate (Alt + left or middle drag, or the rotate keys). In the default Arrow scheme WASD is free for orders.
    /// The focus is kept in map coordinates and in the base image: crossing the seam recentres
    /// by exactly one period, and because everything is drawn at the image nearest the camera nothing
    /// moves on screen. Camera motion only moves the view; it never rebuilds world data.
    /// </summary>
    public sealed class RtsCamera
    {
        public readonly Camera Cam;
        /// <summary>Focus point in map coordinates (x east, z south).</summary>
        public Vector3 Focus;
        public float Distance = 40f, TargetDistance = 40f;
        public float Yaw;
        public float MinDistance = 1.6f, MaxDistance = 260f;   // zoom-in capped further out (workstream A, Rowen)
        public bool EdgePan = true;
        /// <summary>Pan speed multiplier (a player setting).</summary>
        public float PanSpeed = 1f;
        public bool UserControl = true;
        public bool PointerOverUi;
        public bool PlacementRotation;
        /// <summary>Set while the terrain brush is armed: Ctrl + mouse wheel sizes the brush instead of zooming.</summary>
        public bool BrushScroll;
        /// <summary>Degrees of yaw per pixel of Alt + drag.</summary>
        public float MouseRotateSpeed = .25f;
        /// <summary>True while an Alt + drag is turning the view (the commander ignores that click).</summary>
        public bool MouseRotating => mouseRotate;
        bool mouseRotate;
        WorldModel world;
        Vector3 velocity;   // map units per second

        public RtsCamera(Camera cam) { Cam = cam; }

        public void Bind(WorldModel w) => world = w;

        /// <summary>
        /// The furthest the match camera may zoom out on this map: the framed ground (0.72 x Distance tall at the
        /// focus, times the aspect wide, 0.72 / sin(pitch) deep on the ground) stays inside the map, so the edge of
        /// the ocean slab and the void beyond it never show. Large maps keep <see cref="MaxDistance"/>.
        /// </summary>
        public float ZoomOutLimit
        {
            get
            {
                if (world == null || !world.Ready || !Telephoto || Cam.orthographic) return MaxDistance;
                var g = world.Grid;
                // half the framed ground per unit of Distance: across the screen, and along the view on the ground
                float halfWide = .36f * Mathf.Max(1f, Cam.aspect), halfDeep = .36f / Mathf.Sin(BasePitch * Mathf.Deg2Rad);
                // the view turns (yaw), so fit the turned frame's axis-aligned extent
                float c = Mathf.Abs(Mathf.Cos(Yaw * Mathf.Deg2Rad)), s = Mathf.Abs(Mathf.Sin(Yaw * Mathf.Deg2Rad));
                float across = g.Wrap ? float.MaxValue : g.Period * .5f / (halfWide * c + halfDeep * s);
                float deep = g.Depth * .5f / (halfWide * s + halfDeep * c);
                return Mathf.Clamp(Mathf.Min(across, deep) * .9f, 40f, MaxDistance);
            }
        }

        /// <summary>
        /// How far (in hexes) the focus may be scrolled past the edge of the map at mid and far zoom (user request
        /// 2026-11-18: "scroll just a little bit further past the edge"). The margin scales with the zoom, so close in
        /// the map edge can come to about the middle of the screen, and the ocean horizon fills what lies beyond.
        /// </summary>
        public float OverscrollHexes = 5f;
        public float OverscrollMargin => Mathf.Clamp(Distance * .35f, 1.5f, OverscrollHexes * 1.5f);

        /// <summary>
        /// The range the focus is kept in (map coordinates). It used to keep the telephoto frame on the map (or the
        /// focus on it); it now reaches <see cref="OverscrollMargin"/> further on every non-wrapping side.
        /// </summary>
        void FocusLimits(out float x0, out float x1, out float z0, out float z1)
        {
            var g = world.Grid;
            float m = OverscrollMargin, ex = 0f, ez = 0f;
            if (Telephoto && !Cam.orthographic)
            {
                float k = Distance * .8f;   // proportional to the zoom, so zooming never jumps the focus
                float halfWide = .36f * Mathf.Max(1f, Cam.aspect) * k, halfDeep = .36f / Mathf.Sin(BasePitch * Mathf.Deg2Rad) * k;
                float c = Mathf.Abs(Mathf.Cos(Yaw * Mathf.Deg2Rad)), s = Mathf.Abs(Mathf.Sin(Yaw * Mathf.Deg2Rad));
                ex = halfWide * c + halfDeep * s; ez = halfWide * s + halfDeep * c;
            }
            // a frame wider than the map stays centred (within the margin); the limits meet continuously at that point
            if (ex * 2 < g.Period) { x0 = ex - m; x1 = g.Period - ex + m; } else { x0 = g.Period * .5f - m; x1 = g.Period * .5f + m; }
            if (ez * 2 < g.Depth) { z0 = ez - m; z1 = g.Depth - ez + m; } else { z0 = g.Depth * .5f - m; z1 = g.Depth * .5f + m; }
        }

        /// <summary>Slows a pan as the focus nears its limit, so it comes to rest at the edge instead of stopping dead.</summary>
        void EaseAtEdges(ref Vector3 v)
        {
            if (world == null || !world.Ready) return;
            FocusLimits(out float x0, out float x1, out float z0, out float z1);
            float soft = Mathf.Max(.5f, OverscrollMargin * .6f);
            if (!world.Grid.Wrap)
            {
                if (v.x > 0) v.x *= Mathf.Clamp01((x1 - Focus.x) / soft);
                else if (v.x < 0) v.x *= Mathf.Clamp01((Focus.x - x0) / soft);
            }
            if (v.z > 0) v.z *= Mathf.Clamp01((z1 - Focus.z) / soft);
            else if (v.z < 0) v.z *= Mathf.Clamp01((Focus.z - z0) / soft);
        }

        /// <summary>A fixed pitch for cinematic shots (negative: follow the zoom).</summary>
        public float PitchOverride = -1f;
        /// <summary>Camera shake amount (set from nearby blasts; decays in the effects system).</summary>
        public float Shake;

        /// <summary>The strategic view keeps one fixed oblique pitch at every zoom.</summary>
        public const float BasePitch = 52f;
        // Close in, the view flattens from the command angle toward a low, over-the-shoulder battlefield view.
        public float Pitch => PitchOverride >= 0 ? PitchOverride : Mathf.Lerp(BasePitch, 16f, Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(2.6f, .2f, Distance)));

        /// <summary>When set, the camera glides after this map point (a followed unit or formation); any manual pan stops following.</summary>
        public System.Func<Vector3?> FollowTarget;
        public bool Following => FollowTarget != null;

        // where the camera was before each jump (Backspace returns there)
        readonly System.Collections.Generic.List<(Vector3 focus, float distance)> history = new System.Collections.Generic.List<(Vector3, float)>();

        /// <summary>The camera position in map coordinates.</summary>
        public Vector3 MapPosition => MapSpace.ToMap(ViewLod.EyeOr(Cam));   // the logical eye (see ViewLod)

        public void FocusTile(int tile, float distance)
        {
            if (world == null || !world.Ready || tile < 0) return;
            Remember();
            Focus = new Vector3(world.Grid.CenterX(tile), Focus.y, world.Grid.CenterZ(tile));
            Distance = TargetDistance = distance;
        }

        /// <summary>Glide (not cut) to a map point, keeping the zoom unless one is given; the jump is remembered.</summary>
        public void JumpTo(Vector3 map, float distance = -1f)
        {
            Remember();
            jumpTarget = map; jumping = true;
            if (distance > 0) TargetDistance = distance;
        }

        Vector3 jumpTarget;
        bool jumping;

        void Remember()
        {
            if (history.Count > 0 && (history[history.Count - 1].focus - Focus).sqrMagnitude < 4f) return;
            history.Add((Focus, TargetDistance));
            if (history.Count > 16) history.RemoveAt(0);
        }

        /// <summary>Return to where the camera was before the last jump.</summary>
        public bool Back()
        {
            if (history.Count == 0) return false;
            var (f, d) = history[history.Count - 1];
            history.RemoveAt(history.Count - 1);
            jumpTarget = f; jumping = true; TargetDistance = d; FollowTarget = null;
            return true;
        }

        /// <summary>A screen-relative direction (x right, y forward) as a map-space vector.</summary>
        Vector3 ScreenToMap(float right, float forward)
        {
            var u = Quaternion.Euler(0, Yaw, 0) * new Vector3(right, 0, forward);
            return new Vector3(u.x, 0, -u.z);
        }

        public void Update(float dt)
        {
            if (UserControl)
            {
                float right = 0, forward = 0;
                // the pan keys follow the camera key scheme (Arrow keys or WASD); the arrows always pan as well
                // unless the player bound one of them to an order
                if (InputFacade.PanHeld("pan_up", KeyCode.UpArrow)) forward += 1;
                if (InputFacade.PanHeld("pan_down", KeyCode.DownArrow)) forward -= 1;
                if (InputFacade.PanHeld("pan_left", KeyCode.LeftArrow)) right -= 1;
                if (InputFacade.PanHeld("pan_right", KeyCode.RightArrow)) right += 1;
                var mp = InputFacade.MousePosition;
                if (!PointerOverUi && EdgePan && Application.isFocused && mp.x >= 0 && mp.y >= 0 && mp.x <= Screen.width && mp.y <= Screen.height)
                {
                    const float edge = 6f;
                    if (mp.x < edge) right -= 1; else if (mp.x > Screen.width - edge) right += 1;
                    if (mp.y < edge) forward -= 1; else if (mp.y > Screen.height - edge) forward += 1;
                }
                if (!PlacementRotation && InputFacade.ActionHeld("rotate_left")) Yaw -= 90f * dt;
                if (!PlacementRotation && InputFacade.ActionHeld("rotate_right")) Yaw += 90f * dt;
                // Alt + left or middle drag (started over the map) turns the view until the button is released
                if (!mouseRotate && InputFacade.Alt && !PointerOverUi && (InputFacade.LeftDown || InputFacade.MiddleDown)) mouseRotate = true;
                if (mouseRotate && !InputFacade.LeftHeld && !InputFacade.MiddleHeld) mouseRotate = false;
                if (mouseRotate) Yaw += InputFacade.MouseDelta.x * MouseRotateSpeed;
                if (InputFacade.Action("back")) Back();
                var dir = ScreenToMap(right, forward);
                if (dir.sqrMagnitude > 1f) dir.Normalize();
                bool manual = dir.sqrMagnitude > 0.01f || InputFacade.MiddleHeld;
                if (manual) { FollowTarget = null; jumping = false; }   // the player's hand always wins
                var want = dir * Distance * (InputFacade.Shift ? 2.4f : 1.1f) * PanSpeed;
                velocity = Vector3.Lerp(velocity, want, 1f - Mathf.Exp(-dt * 10f));
                EaseAtEdges(ref velocity);
                Focus += velocity * dt;
                if (InputFacade.MiddleHeld && !PointerOverUi && !mouseRotate)
                {
                    var d = InputFacade.MouseDelta;
                    Focus += ScreenToMap(-d.x, -d.y) * Distance * 0.0022f;
                }
                // following a unit, or gliding to a jump target, eases the focus there
                Vector3? goal = jumping ? jumpTarget : FollowTarget?.Invoke();
                if (FollowTarget != null && goal == null) FollowTarget = null;   // the followed unit is gone
                if (goal is Vector3 gp && world != null && world.Ready)
                {
                    float dx = world.Grid.DxWrap(Focus.x, gp.x), dz = gp.z - Focus.z;
                    float k = 1f - Mathf.Exp(-dt * (jumping ? 6f : 4f));
                    Focus += new Vector3(dx * k, 0, dz * k);
                    if (jumping && dx * dx + dz * dz < 0.01f) jumping = false;
                }
                float scroll = PointerOverUi || (BrushScroll && InputFacade.Ctrl) ? 0 : InputFacade.Scroll;
                if (Mathf.Abs(scroll) > 0.01f)
                {
                    // zoom toward the point under the cursor
                    float before = TargetDistance;
                    TargetDistance = Mathf.Clamp(TargetDistance * Mathf.Pow(0.85f, scroll), MinDistance, ZoomOutLimit);
                    if (TryGround(InputFacade.MousePosition, out var hit))
                    {
                        float k = 1f - TargetDistance / before;
                        Focus += new Vector3(hit.x - Focus.x, 0, hit.z - Focus.z) * k * 0.6f;
                    }
                }
            }
            // a small map is never zoomed out past its own edges (final pass: the square ocean slab and the grey
            // void around it showed at 120+ on the sandbox island); jumps and scripted zooms obey the same cap
            if (Telephoto) TargetDistance = Mathf.Min(TargetDistance, ZoomOutLimit);
            Distance = Mathf.Lerp(Distance, TargetDistance, 1f - Mathf.Exp(-dt * 9f));
            if (Cam.orthographic) Cam.orthographicSize = Distance * .36f;
            Apply();
        }

        public void Apply()
        {
            if (Cam.orthographic) Cam.orthographicSize = Distance * .36f;
            if (world != null && world.Ready)
            {
                var g = world.Grid;
                if (g.Wrap) Focus.x = g.BaseX(Focus.x);   // seam: shift by whole periods (invisible)
                FocusLimits(out float x0, out float x1, out float z0, out float z1);
                if (!g.Wrap) Focus.x = Mathf.Clamp(Focus.x, x0, x1);
                Focus.z = Mathf.Clamp(Focus.z, z0, z1);
                // past the edge the focus stands over the ocean (sea level), not a clamped edge hex
                bool onMap = Focus.z >= 0 && Focus.z <= g.Depth && (g.Wrap || (Focus.x >= 0 && Focus.x <= g.Period));
                float y = onMap ? world.GroundHeight(Focus.x, Focus.z) : 0f;
                Focus.y = Mathf.Lerp(Focus.y, Mathf.Max(0, y), 0.2f);
            }
            // look north (+z in Unity space) and down; yaw turns the view
            var look = Quaternion.Euler(Pitch, Yaw, 0);
            var focusUnity = MapSpace.ToUnity(Focus);
            var shake = Shake > 0.001f ? new Vector3(Mathf.PerlinNoise(Time.unscaledTime * 23f, 0.3f) - 0.5f, Mathf.PerlinNoise(0.7f, Time.unscaledTime * 21f) - 0.5f, 0) * Shake * Mathf.Min(1.5f, Distance * 0.03f) : Vector3.zero;
            // (workstream A: projection) the match camera is a telephoto perspective: a narrow field of view
            // from further back, framing the same ground height as the zoom distance did, so the view keeps
            // a little depth (more close in, almost flat at strategic zoom) without the wide-angle distortion
            float eyeDistance = Distance;
            if (Telephoto && !Cam.orthographic)
            {
                if (baseFov < 0) baseFov = Cam.fieldOfView;
                float fov = Mathf.Lerp(TelephotoFovNear, TelephotoFovFar, Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(3f, 140f, Distance)));
                Cam.fieldOfView = fov;
                eyeDistance = Distance * .36f / Mathf.Tan(fov * .5f * Mathf.Deg2Rad);
            }
            else if (baseFov > 0 && !Cam.orthographic) { Cam.fieldOfView = baseFov; baseFov = -1f; }
            var eye = focusUnity - look * Vector3.forward * eyeDistance + look * shake;
            // a low battlefield camera must never sink into the hillside behind it
            if (world != null && world.Ready && Distance < 6f)
            {
                float floor = world.GroundHeight(eye.x, -eye.z) + Mathf.Max(.025f, Distance * .08f);
                if (eye.y < floor) eye.y = floor;
            }
            Cam.transform.SetPositionAndRotation(eye, look);
            Cam.farClipPlane = Mathf.Max(600f, eyeDistance + Distance * 6f);
            Cam.nearClipPlane = Mathf.Clamp(eyeDistance * 0.02f, 0.006f, 8f);
            ViewLod.Set(focusUnity - look * Vector3.forward * Distance, eyeDistance - Distance, Telephoto && !Cam.orthographic);
        }

        /// <summary>The in-match telephoto projection (workstream A); off for the menu and cinematic cameras.</summary>
        public bool Telephoto;
        /// <summary>Telephoto field of view (degrees) fully zoomed in and at strategic zoom.</summary>
        public float TelephotoFovNear = 30f, TelephotoFovFar = 14f;
        float baseFov = -1f;

        /// <summary>The ground point (map coordinates) under a screen position, ray-marched against the terrain.</summary>
        public bool TryGround(Vector2 screen, out Vector3 mapPoint)
        {
            var ray = Cam.ScreenPointToRay(screen);
            mapPoint = default;
            if (ray.direction.y > -1e-4f) return false;
            float t = (Focus.y - ray.origin.y) / ray.direction.y;
            if (t < 0) return false;
            var p = ray.origin + ray.direction * t;
            if (world != null && world.Ready)
            {
                for (int k = 0; k < 5; k++)
                {
                    float h = world.GroundHeight(p.x, -p.z);
                    t = (h - ray.origin.y) / ray.direction.y;
                    if (t < 0) break;
                    p = ray.origin + ray.direction * t;
                }
            }
            mapPoint = MapSpace.ToMap(p);
            return true;
        }

        /// <summary>Screen position of a map point (z &lt; 0 when behind the camera).</summary>
        public Vector3 ToScreen(Vector3 mapPoint) => Cam.WorldToScreenPoint(MapSpace.ToUnity(mapPoint));
    }
}
