namespace SE.Runtime.UI
{
    /// <summary>
    /// Compatibility entry points for the shell (Hud.cs). Every command now lives on the radial wheels
    /// (Hud.Base.cs) and the defensive build bar (Hud.DefenseBar.cs); the old Field-construction menu,
    /// rail tooltips and contextual command cards are gone (spec E19, E20, E22, E23).
    /// </summary>
    public sealed partial class Hud
    {
        /// <summary>Escape inside the action context: same as <see cref="CloseCommandContext"/>.</summary>
        bool CloseActionContext() => CloseCommandContext();

        /// <summary>The old "build" shortcut: arms the defensive build bar instead of opening a menu.</summary>
        void OpenFieldMenu() => ToggleDefenseBarArmed();
    }
}
