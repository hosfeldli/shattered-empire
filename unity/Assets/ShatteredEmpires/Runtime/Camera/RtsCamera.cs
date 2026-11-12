using SE.Core.World;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using UnityEngine;

namespace SE.Runtime.CameraControl
{
    /// <summary>
    /// Strategy camera: pan (WASD, arrows, screen edges, middle drag), zoom toward the cursor, rotate
    /// (Q/E). The focus is kept in map coordinates and in the base image: crossing the seam recentres
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
        public float MinDistance = 2.5f, MaxDistance = 260f;
        public bool EdgePan = true;
        /// <summary>Pan speed multiplier (a player setting).</summary>
        public float PanSpeed = 1f;
        public bool UserControl = true;
        WorldModel world;
        Vector3 velocity;   // map units per second

        public RtsCamera(Camera cam) { Cam = cam; }

        public void Bind(WorldModel w) => world = w;

        /// <summary>A fixed pitch for cinematic shots (negative: follow the zoom).</summary>
        public float PitchOverride = -1f;
        /// <summary>Camera shake amount (set from nearby blasts; decays in the effects system).</summary>
        public float Shake;

        /// <summary>The strategic view keeps one fixed oblique pitch at every zoom.</summary>
        public const float BasePitch = 52f;
        public float Pitch => PitchOverride >= 0 ? PitchOverride : BasePitch;

        /// <summary>When set, the camera glides after this map point (a followed unit or formation); any manual pan stops following.</summary>
        public System.Func<Vector3?> FollowTarget;
        public bool Following => FollowTarget != null;

        // where the camera was before each jump (Backspace returns there)
        readonly System.Collections.Generic.List<(Vector3 focus, float distance)> history = new System.Collections.Generic.List<(Vector3, float)>();

        /// <summary>The camera position in map coordinates.</summary>
        public Vector3 MapPosition => MapSpace.ToMap(Cam.transform.position);

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
                if (InputFacade.ActionHeld("pan_up") || InputFacade.Held(KeyCode.UpArrow)) forward += 1;
                if (InputFacade.ActionHeld("pan_down") || InputFacade.Held(KeyCode.DownArrow)) forward -= 1;
                if (InputFacade.ActionHeld("pan_left") || InputFacade.Held(KeyCode.LeftArrow)) right -= 1;
                if (InputFacade.ActionHeld("pan_right") || InputFacade.Held(KeyCode.RightArrow)) right += 1;
                var mp = InputFacade.MousePosition;
                if (EdgePan && Application.isFocused && mp.x >= 0 && mp.y >= 0 && mp.x <= Screen.width && mp.y <= Screen.height)
                {
                    const float edge = 6f;
                    if (mp.x < edge) right -= 1; else if (mp.x > Screen.width - edge) right += 1;
                    if (mp.y < edge) forward -= 1; else if (mp.y > Screen.height - edge) forward += 1;
                }
                if (InputFacade.ActionHeld("rotate_left")) Yaw -= 90f * dt;
                if (InputFacade.ActionHeld("rotate_right")) Yaw += 90f * dt;
                if (InputFacade.Action("back")) Back();
                var dir = ScreenToMap(right, forward);
                if (dir.sqrMagnitude > 1f) dir.Normalize();
                bool manual = dir.sqrMagnitude > 0.01f || InputFacade.MiddleHeld;
                if (manual) { FollowTarget = null; jumping = false; }   // the player's hand always wins
                var want = dir * Distance * (InputFacade.Shift ? 2.4f : 1.1f) * PanSpeed;
                velocity = Vector3.Lerp(velocity, want, 1f - Mathf.Exp(-dt * 10f));
                Focus += velocity * dt;
                if (InputFacade.MiddleHeld)
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
                float scroll = InputFacade.Scroll;
                if (Mathf.Abs(scroll) > 0.01f)
                {
                    // zoom toward the point under the cursor
                    float before = TargetDistance;
                    TargetDistance = Mathf.Clamp(TargetDistance * Mathf.Pow(0.85f, scroll), MinDistance, MaxDistance);
                    if (TryGround(InputFacade.MousePosition, out var hit))
                    {
                        float k = 1f - TargetDistance / before;
                        Focus += new Vector3(hit.x - Focus.x, 0, hit.z - Focus.z) * k * 0.6f;
                    }
                }
            }
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
                else Focus.x = Mathf.Clamp(Focus.x, 0, g.Period);
                Focus.z = Mathf.Clamp(Focus.z, 0, g.Depth);
                float y = world.GroundHeight(Focus.x, Focus.z);
                Focus.y = Mathf.Lerp(Focus.y, Mathf.Max(0, y), 0.2f);
            }
            // look north (+z in Unity space) and down; yaw turns the view
            var look = Quaternion.Euler(Pitch, Yaw, 0);
            var focusUnity = MapSpace.ToUnity(Focus);
            var shake = Shake > 0.001f ? new Vector3(Mathf.PerlinNoise(Time.unscaledTime * 23f, 0.3f) - 0.5f, Mathf.PerlinNoise(0.7f, Time.unscaledTime * 21f) - 0.5f, 0) * Shake * Mathf.Min(1.5f, Distance * 0.03f) : Vector3.zero;
            Cam.transform.SetPositionAndRotation(focusUnity - look * Vector3.forward * Distance + look * shake, look);
            Cam.farClipPlane = Mathf.Max(600f, Distance * 6f);
            Cam.nearClipPlane = Mathf.Clamp(Distance * 0.02f, 0.05f, 2f);
        }

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
