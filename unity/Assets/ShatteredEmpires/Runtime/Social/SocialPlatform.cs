using System;

namespace SE.Runtime.Social
{
    /// <summary>
    /// Friends and invites around a server-run match (Steam today). The platform never carries game
    /// traffic: a host's lobby carries the server's match code, and accepting an invite joins that
    /// match on the authoritative server, exactly like the Electron client's desktop/steam.cjs.
    /// </summary>
    public interface ISocialPlatform
    {
        bool Available { get; }
        string Status { get; }
        string PlayerName { get; }
        /// <summary>Open (or reuse) a friends-only lobby for this match code and show the invite dialog.</summary>
        void InviteFriends(string matchCode, string matchName);
        /// <summary>Raised with a match code when the player accepts an invite or launches from one.</summary>
        event Action<string> JoinRequested;
        void Tick();
        void Shutdown();
    }

    public static class SocialPlatform
    {
        sealed class None : ISocialPlatform
        {
            public bool Available => false;
            public string Status => "Steam is not part of this build";
            public string PlayerName => "";
            public void InviteFriends(string matchCode, string matchName) { }
            public event Action<string> JoinRequested { add { } remove { } }
            public void Tick() { }
            public void Shutdown() { }
        }

        static ISocialPlatform current;
        static Func<ISocialPlatform> factory;

        /// <summary>Platform assemblies (SE.Steam) register themselves at start-up.</summary>
        public static void Register(Func<ISocialPlatform> create) => factory = create;

        public static ISocialPlatform Current
        {
            get
            {
                if (current == null)
                {
                    try { current = factory != null ? factory() : new None(); }
                    catch (Exception e) { UnityEngine.Debug.LogWarning("Social platform failed: " + e.Message); current = new None(); }
                }
                return current;
            }
        }
    }
}
