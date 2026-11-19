namespace SE.Runtime.App
{
    /// <summary>
    /// Client diagnostics (docs/TELEMETRY.md): feeds <see cref="ClientTelemetry"/> once per frame with the frame time,
    /// the main-thread work, the Present phase timings, the camera and the network. Benchmarks and stress runs
    /// (which never talk to a live server) are left out.
    /// </summary>
    public sealed partial class GameBootstrap
    {
        ClientTelemetry telemetry;

        void TelemetryFrame(double frameMs, double mainMs)
        {
            if (phase == Phase.Stress || perfRunning || opts == null || opts.Has("review")) return;
            telemetry ??= new ClientTelemetry();
            bool inMatch = phase == Phase.Playing && session != null && session.Ready;
            float interp = inMatch ? session.Units.NewestTime - session.Units.RenderTime : 0f;
            telemetry.Frame(Now, frameMs, mainMs, inMatch, PhaseNames, phaseMs, inMatch && rts != null ? rts.Distance : 0f, inMatch && units != null ? units.Drawn : 0, interp);
            telemetry.Step(Now, net, session);
        }
    }
}
