using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Draws SE/Shroud: never-explored ground as a drifting bank of volumetric cloud (see the shader). One
    /// full-screen triangle per frame; the camera depth texture is requested while it is active. The shader's
    /// rays come from here: the world-space ray origin and direction at the four screen corners, so the march
    /// is exact for both the perspective camera and the orthographic action-RTS camera.
    /// </summary>
    public sealed class Shroud : System.IDisposable
    {
        static readonly int ParamsId = Shader.PropertyToID("_SE_ShroudParams");
        static readonly int LitId = Shader.PropertyToID("_SE_ShroudLit");
        static readonly int ShadeId = Shader.PropertyToID("_SE_ShroudShade");
        static readonly int WindId = Shader.PropertyToID("_SE_ShroudWind");
        static readonly int HazeId = Shader.PropertyToID("_SE_HazeColor");
        static readonly int CloudLayerId = Shader.PropertyToID("_SE_CloudLayer");
        static readonly int OnId = Shader.PropertyToID("_SE_ShroudOn");
        static readonly int RayOriginId = Shader.PropertyToID("_SE_ShroudRayO");
        static readonly int RayDirectionId = Shader.PropertyToID("_SE_ShroudRayD");
        static readonly int CameraId = Shader.PropertyToID("_SE_ShroudCam");
        readonly Material material;
        readonly Mesh triangle;
        Vector2 drift;
        Camera target;
        Matrix4x4 rayOrigins, rayDirections;
        public bool Active { get; private set; }

        public Shroud()
        {
            // shipped through Resources, so the player build always contains it
            var shader = Resources.Load<Shader>("Shaders/Shroud");
            if (shader == null) shader = Shader.Find("SE/Shroud");
            if (shader == null) { Debug.LogWarning("Shattered Empires: SE/Shroud shader missing; fog of war draws without the cloud bank"); return; }
            material = new Material(shader) { name = "SE shroud", hideFlags = HideFlags.DontSave };
            triangle = new Mesh { name = "SE shroud triangle", hideFlags = HideFlags.DontSave };
            triangle.SetVertices(new[] { new Vector3(-1, -1, 0), new Vector3(3, -1, 0), new Vector3(-1, 3, 0) });
            triangle.SetTriangles(new[] { 0, 1, 2 }, 0);
            triangle.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            RenderPipelineManager.beginCameraRendering += BeginCamera;
        }

        /// <summary>Per frame. <paramref name="on"/>: a match is showing (sky clouds); <paramref name="fogOfWar"/>: unexplored ground is shrouded.</summary>
        public void Draw(Camera cam, bool on, bool fogOfWar, bool wrap, Vector2 wind, float dt, float daylight)
        {
            // nothing to draw (and no depth copy to pay for) without fog of war on the orthographic camera, which has no sky clouds
            Active = on && material != null && cam != null && (fogOfWar || !cam.orthographic);
            if (!Active) Shader.SetGlobalFloat(OnId, 0);
            if (!Active) return;
            target = cam;
            drift += wind * dt * .25f;
            var haze = Shader.GetGlobalColor(HazeId);
            if (haze.maxColorComponent < .05f) haze = new Color(.70f, .74f, .78f);
            float day = Mathf.Clamp01(daylight);
            var lit = Color.Lerp(haze, Color.white, .7f) * Mathf.Lerp(.4f, 1.12f, day);
            var shade = Color.Lerp(haze, new Color(.36f, .40f, .47f), .5f) * Mathf.Lerp(.3f, .85f, day);
            Shader.SetGlobalVector(ParamsId, new Vector4(wrap ? 1 : 0, -.4f, 6.5f, fogOfWar ? 2.4f : 0f));
            // low cumulus 325-525 m up, seen toward the horizon from a low perspective camera only; never from
            // the orthographic action camera, which looks down on the battlefield
            Shader.SetGlobalVector(CloudLayerId, new Vector4(13f, 21f, cam.orthographic ? 0f : 1f, 0));
            Shader.SetGlobalColor(LitId, lit);
            Shader.SetGlobalFloat(OnId, fogOfWar ? 1 : 0);
            Shader.SetGlobalColor(ShadeId, shade);
            Shader.SetGlobalVector(WindId, new Vector4(drift.x, Time.time, drift.y, 0));
            SetRays(cam);
            Graphics.RenderMesh(new RenderParams(material) { camera = cam, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false,
                worldBounds = new Bounds(cam.transform.position, Vector3.one * 1e5f) }, triangle, 0, Matrix4x4.identity);
        }

        // Re-derive the rays just before the camera renders, in case it moved after Draw (late camera updates).
        void BeginCamera(ScriptableRenderContext context, Camera cam)
        {
            if (Active && cam == target && material != null) SetRays(cam);
        }

        /// <summary>
        /// Corner rays (bottom-left, bottom-right, top-left, top-right): origin on the camera plane, direction
        /// scaled to a unit step along the view axis, so scene point = origin + direction * linear eye depth.
        /// </summary>
        void SetRays(Camera cam)
        {
            float near = cam.nearClipPlane, far = Mathf.Max(cam.farClipPlane, near + 1e-3f);
            for (int k = 0; k < 4; k++)
            {
                float u = k & 1, v = k >> 1;
                var p0 = cam.ViewportToWorldPoint(new Vector3(u, v, near));
                var p1 = cam.ViewportToWorldPoint(new Vector3(u, v, far));
                var d = (p1 - p0) / (far - near);
                var o = p0 - d * near;
                rayOrigins.SetRow(k, new Vector4(o.x, o.y, o.z, 0));
                rayDirections.SetRow(k, new Vector4(d.x, d.y, d.z, 0));
            }
            material.SetMatrix(RayOriginId, rayOrigins);
            material.SetMatrix(RayDirectionId, rayDirections);
            material.SetVector(CameraId, new Vector4(cam.orthographic ? 1 : 0, near, far, 0));
        }

        public void Dispose()
        {
            RenderPipelineManager.beginCameraRendering -= BeginCamera;
            if (material != null) Object.Destroy(material);
            if (triangle != null) Object.Destroy(triangle);
        }
    }
}
