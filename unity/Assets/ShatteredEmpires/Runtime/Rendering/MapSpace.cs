using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Rendering
{
    /// <summary>
    /// The one conversion between the game's map coordinates and Unity's world. Map data (server,
    /// Godot reference, every Core calculation) is right-handed: x east, y up, z south. Unity is
    /// left-handed, so drawing map coordinates directly would mirror the world east-west. Unity world
    /// space is therefore (x, y, -z): north is +z, east stays +x, and wrapping still runs along x.
    /// Everything that reaches the GPU or the camera goes through here; all game logic stays in map
    /// coordinates.
    /// </summary>
    public static class MapSpace
    {
        /// <summary>Map point to Unity world.</summary>
        public static float3 W(float x, float y, float z) => new float3(x, y, -z);
        public static float3 W(float3 map) => new float3(map.x, map.y, -map.z);
        public static Vector3 ToUnity(Vector3 map) => new Vector3(map.x, map.y, -map.z);
        /// <summary>Unity world point to map coordinates.</summary>
        public static Vector3 ToMap(Vector3 unity) => new Vector3(unity.x, unity.y, -unity.z);
        /// <summary>A heading measured in the map (atan2(dx, dz)) as a Unity yaw for models facing +z.</summary>
        public static float Yaw(float mapYaw) => math.PI - mapYaw;
        public static float MapYaw(float dx, float dz) => math.atan2(dx, dz);
    }
}
