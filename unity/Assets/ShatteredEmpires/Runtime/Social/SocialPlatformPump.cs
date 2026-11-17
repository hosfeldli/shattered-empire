using UnityEngine;

namespace SE.Runtime.Social
{
    /// <summary>
    /// Pumps platform callbacks (SteamAPI.RunCallbacks) every frame in every phase: menu, loading, the match
    /// lobby and the match. Created by <see cref="SocialPlatform.Current"/>; hidden and kept across scenes.
    /// </summary>
    public sealed class SocialPlatformPump : MonoBehaviour
    {
        // Update runs in every scene and phase (the object is DontDestroyOnLoad); unscaled by Time.timeScale
        void Update() => SocialPlatform.Created?.Tick();
        void OnApplicationQuit() => SocialPlatform.Created?.Shutdown();
    }
}
