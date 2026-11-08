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
        public bool UserControl = true;
        WorldModel world;
        Vector3 velocity;   // map units per second

        public RtsCamera(Camera cam) { Cam = cam; }

        public void Bind(WorldModel w) => world = w;

        public float Pitch => Mathf.Lerp(48f, 72f, Mathf.InverseLerp(MinDistance, MaxDistance * 0.6f, Distance));

        /// <summary>The camera position in map coordinates.</summary>
        public Vector3 MapPosition => MapSpace.ToMap(Cam.transform.position);

        public void FocusTile(int tile, float distance)
        {
            if (world == null || !world.Ready || tile < 0) return;
            Focus = new Vector3(world.Grid.CenterX(tile), Focus.y, world.Grid.CenterZ(tile));
            Distance = TargetDistance = distance;
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
                if (InputFacade.Held(KeyCode.W) || InputFacade.Held(KeyCode.UpArrow)) forward += 1;
                if (InputFacade.Held(KeyCode.S) || InputFacade.Held(KeyCode.DownArrow)) forward -= 1;
                if (InputFacade.Held(KeyCode.A) || InputFacade.Held(KeyCode.LeftArrow)) right -= 1;
                if (InputFacade.Held(KeyCode.D) || InputFacade.Held(KeyCode.RightArrow)) right += 1;
                var mp = InputFacade.MousePosition;
                if (EdgePan && Application.isFocused && mp.x >= 0 && mp.y >= 0 && mp.x <= Screen.width && mp.y <= Screen.height)
                {
                    const float edge = 6f;
                    if (mp.x < edge) right -= 1; else if (mp.x > Screen.width - edge) right += 1;
                    if (mp.y < edge) forward -= 1; else if (mp.y > Screen.height - edge) forward += 1;
                }
                if (InputFacade.Held(KeyCode.Q)) Yaw -= 90f * dt;
                if (InputFacade.Held(KeyCode.E)) Yaw += 90f * dt;
                var dir = ScreenToMap(right, forward);
                if (dir.sqrMagnitude > 1f) dir.Normalize();
                var want = dir * Distance * 1.1f;
                velocity = Vector3.Lerp(velocity, want, 1f - Mathf.Exp(-dt * 10f));
                Focus += velocity * dt;
                if (InputFacade.MiddleHeld)
                {
                    var d = InputFacade.MouseDelta;
                    Focus += ScreenToMap(-d.x, -d.y) * Distance * 0.0022f;
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
            Apply();
        }

        public void Apply()
        {
            if (world != null && world.Ready)
            {
                var g = world.Grid;
                if (g.Wrap) Focus.x = g.BaseX(Focus.x);   // seam: shift by whole periods (invisible)
                Focus.z = Mathf.Clamp(Focus.z, 0, g.Depth);
                float y = world.GroundHeight(Focus.x, Focus.z);
                Focus.y = Mathf.Lerp(Focus.y, Mathf.Max(0, y), 0.2f);
            }
            // look north (+z in Unity space) and down; yaw turns the view
            var look = Quaternion.Euler(Pitch, Yaw, 0);
            var focusUnity = MapSpace.ToUnity(Focus);
            Cam.transform.SetPositionAndRotation(focusUnity - look * Vector3.forward * Distance, look);
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
