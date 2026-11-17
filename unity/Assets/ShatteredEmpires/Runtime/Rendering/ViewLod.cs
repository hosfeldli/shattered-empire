using UnityEngine;

namespace SE.Runtime.Rendering
{
    /// <summary>
    /// The match camera is a telephoto perspective (a narrow field of view from further back), so the real
    /// eye sits well behind the point it would occupy at the logical zoom distance. Everything that picks a
    /// level of detail, a wrap image or a haze/fog range by "distance from the camera" reads the logical eye
    /// here instead, so detail bands follow the zoom exactly as they did before. Set by RtsCamera.Apply.
    /// </summary>
    public static class ViewLod
    {
        static readonly int EyeOffsetId = Shader.PropertyToID("_SE_EyeOffset");

        /// <summary>The logical eye: where a camera at the zoom distance would stand (Unity space).</summary>
        public static Vector3 Eye;
        /// <summary>How much further back the real eye is than the logical one (world units, 0 without telephoto).</summary>
        public static float EyeOffset;
        /// <summary>The match's telephoto camera is active (no low sky clouds, eye far above the field).</summary>
        public static bool Telephoto;
        public static bool Valid;

        public static void Set(Vector3 eye, float offset, bool telephoto)
        {
            Eye = eye; EyeOffset = offset; Telephoto = telephoto; Valid = true;
            Shader.SetGlobalFloat(EyeOffsetId, offset);
        }

        /// <summary>The logical eye when one has been set, otherwise the camera's own position.</summary>
        public static Vector3 EyeOr(Camera cam) => Valid ? Eye : cam.transform.position;
    }
}
