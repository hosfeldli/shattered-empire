using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The field guide: how the game works, searchable, with the sound and music credits at the end.
    /// One component for the main menu and the pause menu. It fills its parent (flex-grow 1); only the
    /// topic list scrolls.
    /// </summary>
    public static class FieldGuide
    {
        /// <summary>The action RTS ruleset (wheels, Build and Terrain docks, bases with sockets).</summary>
        static readonly (string topic, string text)[] ActionTopics =
        {
            ("Scout and capture", "Move infantry into a ruin’s command zone. Hostile ground troops contest it, and progress decays if the zone is abandoned. Once it is secured, click it and choose Establish base."),
            ("Your base", "Click your headquarters to open the base wheel; its health bar floats above it. The top segment raises the base tier (it shows the next era's pips and disappears at Tier III). The headquarters trains militia and scout buggies, each with its upgrade line just to its left. Engineers opens the engineer panel: 3, 5 and 8 engineers by tier, who build what you place, repair automatically and requeue when lost, and their three upgrades (armoured vests, a utility car, power tools). The circles at the bottom are this base's production, the rally point and every base's production. Click an empty pad on the base to build there. Click a perimeter turret to choose its path (anti-air, anti-infantry or anti-vehicle) and upgrade the centre turret. Technology unlocked at any base is available faction-wide."),
            ("Production", "Click a production building to open its wheel: four units, each with its own upgrade line just to its left, and the building upgrade at the top (units trained there leave with veterancy). Upgrades are bought per building and show on the units they apply to. Click a unit to queue it, Shift+click queues five, right-click cancels one and Ctrl+click repeats production; Alt+click queues one in every selected building. Units are produced one at a time in the order you queued them; each type keeps its own count and cancel. Double-click a building to select every one of its type on screen and share one order. Queued units reserve command capacity until they deploy or you cancel."),
            ("Materials and Energy", "Ground troops collect material drops on contact, without a return trip. Capture abandoned energy plants for extra Energy. Materials Processors and Energy Generators add passive income. The bars beside the minimap show each resource with its average income per second; hover or click one for the breakdown."),
            ("Command an army", "Box-select or double-click similar units. Right-click to move, capture or attack; Shift queues the order. {attack} then a click attack-moves (red marker); press {attack} twice for every combat unit on screen, or Ctrl+{attack} for the whole army. {stance} cycles the stance: aggressive, defensive, hold fire. {hold} holds, {withdraw} withdraws and {follow} follows with the camera. A crossed-out cursor means the selected units cannot reach that ground. The unit wheel ({commands}) holds abilities, air missions and digging in; basic orders never need it. Ctrl+1–9 saves a group and 1–9 recalls it. The idle-units button on the minimap selects units with nothing to do. On the selection panel, click a unit box to keep only those units, or Shift+click it to drop them."),
            ("Aircraft and patrols", "With aircraft selected, press {air_patrol} and click waypoints (Shift+click adds more; Enter, {air_patrol} or right-click sends the route). Aircraft fly the circuit until fuel runs low, return to the nearest airfield or headquarters to refuel, then resume. The fuel row on the selection panel shows the lowest tank."),
            ("Command wheels", "Every wheel has nine segments, with upgrades at the top. The circle in the middle names the segment under the pointer, with its description, cost and why it is locked. Digits 1–9 pick segments clockwise from twelve o’clock while the pointer is over the wheel, and 0 turns the page when there is one. Escape goes back one ring, then closes the wheel."),
            ("Draw a battle line", "Right-drag to deploy ground units along the terrain. Infantry take the front; vehicles and artillery deploy behind them. {flip} flips the facing, Alt makes it an advancing line and Shift queues it."),
            ("Terrain and slopes", "Hover a unit to see how steep a slope it can climb and how it crosses rivers. Infantry climb the steepest ground (more slowly up hills) and wade any river, but enter dense forest only along a road. Tracked vehicles climb less and cross marsh; wheeled vehicles climb least and avoid marsh. Mountains and peaks are impassable to every ground unit. Vehicles ford narrow rivers but need a bridge over wide ones, and a road lets any unit up a slope that is otherwise too steep. Routes go around ground a unit cannot climb, so a vehicle may take a long way through a pass."),
            ("Stance rings", "The ring under a unit shows its stance: a solid ring is defensive (the default: returns fire and holds its area), a dashed ring is aggressive (chases and engages), a double ring is holding position, and a dotted ring is hold fire. The hover card names the stance too."),
            ("Combined arms", "Infantry capture objectives and benefit from cover. Anti-armor teams counter vehicles. Artillery threatens clustered defenses; mortars, field guns and missile batteries must stop and set up before they fire, and missile batteries cannot engage anything within 3.5 hexes, so escort them. Aircraft need room to operate around air defense."),
            ("Build and Terrain", "Build ({build}, or the button at the bottom centre) opens the build wheel: trenches, roads, sandbags, watchtowers, bunkers, anti-armor and anti-air emplacements, and outposts. An outpost is a tiny base: one build plot per tier, militia (scout buggies from tier 2) and an engineer at tier 3. Defenses, sandbags, roads and trenches can go on your own land or neutral ground (never in another player’s territory; defenses cost ×3 far beyond your border); outposts stay inside your territory. The cursor says why when you can’t build. {rotate_left} and {rotate_right} rotate a defense before you place it, and Shift+click keeps placing; roads and trenches are drawn as routes. Your base engineers walk out and build what you place. Terrain ({terrain}) paints ground works: pick raise, lower, flatten or smooth, then drag across your territory like a brush ({brush_smaller} and {brush_larger}, or Ctrl + mouse wheel, change the brush size) and release to send the engineers. The cost grows with the hexes painted."),
            ("Rally and reinforcements", "Rally, on a base or building wheel, sets where new units gather. With production selected, right-click sets a move rally point and {attack} then a click sets an attack-move rally point. Reinforce group sends a building’s new units straight to one of your control groups."),
            ("Victory", "Military Domination: destroy opposing headquarters and prevent their recovery (a faction with a recovery window can reclaim a ruin and reestablish command). Decisive Domination: from minute 18, a team that holds about two thirds of the operational headquarters with two and a half times its rivals’ army for 90 seconds wins; a countdown under the clock shows who is on the way, and retaking a headquarters or rebuilding your army breaks it."),
            ("Camera and shortcuts", "{Pan} or the screen edges pan (Shift is faster; Settings › Controls switches between Arrow keys and WASD), Alt + drag turns the view, middle-drag moves the camera and the mouse wheel zooms toward the cursor. Click the round minimap to jump there; right-click it to send the selected units; {minimap_zoom} cycles its local and close views. {alert} jumps to the latest attack. Pause and the game menu are at the top right. Every shortcut can be changed in Settings."),
        };

        /// <summary>The legacy strategic ruleset.</summary>
        static readonly (string topic, string text)[] LegacyTopics =
        {
            ("Camera", "{Pan} or the screen edges pan (Shift is faster); the mouse wheel zooms toward the cursor; middle-drag drags the map; Alt + drag, or {rotate_left} and {rotate_right}, turn. Double-click open ground to centre there; {back} returns to the previous view; {alert} jumps to the latest alert."),
            ("Selecting", "Click a unit, or drag a box. Shift adds to the selection; double-click selects every unit of that type on screen. Ctrl+1–9 stores a group, 1–9 recalls it, and pressing it twice brings the camera there."),
            ("Orders", "Right-click moves. {attack} then a click attack-moves (twice: every combat unit on screen; Ctrl+{attack}: the whole army). {stance} cycles stance, {hold} holds, {withdraw} withdraws. {follow} follows the selection with the camera."),
            ("Battle lines", "Right-drag across the map to draw a line: you see where every unit will stand before you let go. {flip} flips the facing, Alt makes it an advancing line, Shift queues it after current orders, Esc cancels."),
            ("Building", "Open Build ({build}), pick a building and click a highlighted site; drag to place several. Roads, bridges and trenches are drawn as routes. Sites wait for materials if you can't afford them yet."),
            ("Cities and mayors", "Select a town to see its people, homes and jobs. Guide Growth tells the mayor what to build next and where; the mayor never spends what you reserved for your own projects."),
            ("Resources", "Hover any resource at the top to see what produces it, what uses it, and what to do when it runs short. Power, people and the next era are always in view."),
            ("Research", "Open Research ({research}). Click an available technology to start it, Shift+click to queue it with everything it needs. Search finds technologies by what they unlock; hover one to see where it leads."),
            ("Eras", "Five eras: Reclamation, Industrial Recovery, Mechanization, Networked Warfare and Advanced Systems. Buildings keep the style of the era they were built in; upgrading brings them up to date."),
            ("Units", "Infantry (militia, rifle squads, engineers, mortars, special forces), vehicles (scout buggies, armoured cars, infantry carriers, infantry fighting vehicles, tanks, autonomous tanks, field guns, self-propelled artillery, air defence, missile batteries) and aircraft (Warthog ground-attack jets, bombers, helicopters, drones, strike swarms)."),
            ("Battlefields", "Fighting leaves its mark: craters, mud, wrecks and ruins stay. Trenches dug into the ground protect infantry; they join the bunkers and forts beside them."),
            ("Alerts", "Critical alerts interrupt with a banner; important ones appear as small notices with a Go button; everything else is written in the Chronicle (Overview). Concluded battles get a result card."),
            ("Settings", "Interface scale, reduced motion, screen shake, weather intensity, high-contrast markers, camera speed and every shortcut can be changed in Settings."),
        };

        /// <summary>The guide for the given ruleset; fills its parent.</summary>
        public static VisualElement Build(bool actionRts) => Build(actionRts, false);

        /// <summary>The guide; <paramref name="openCredits"/> opens the sound and music credits and scrolls to them.</summary>
        public static VisualElement Build(bool actionRts, bool openCredits)
        {
            var host = new VisualElement();
            host.AddToClassList("se-guide");
            host.style.flexGrow = 1;
            host.style.flexShrink = 1;
            host.style.minHeight = 0;

            var search = new TextField();
            search.AddToClassList("field");
            search.AddToClassList("se-menu-field");
            search.AddToClassList("se-guide-search");
            search.textEdition.placeholder = "Search the guide…";
            host.Add(search);

            var scroll = new ScrollView(ScrollViewMode.Vertical)
            {
                horizontalScrollerVisibility = ScrollerVisibility.Hidden,
                verticalScrollerVisibility = ScrollerVisibility.Auto,
                mouseWheelScrollSize = 38,
            };
            scroll.AddToClassList("bounded-scroll");
            scroll.AddToClassList("se-guide-scroll");
            scroll.style.flexGrow = 1;
            scroll.style.flexShrink = 1;
            scroll.style.minHeight = 0;
            host.Add(scroll);

            var entries = new List<(VisualElement el, string text)>();
            foreach (var (topic, raw) in actionRts ? ActionTopics : LegacyTopics)
            {
                string text = SE.Runtime.Input.InputFacade.Expand(raw);   // {attack} → the bound key
                var item = new VisualElement();
                item.AddToClassList("se-guide-entry");
                var heading = new Label(topic);
                heading.AddToClassList("se-guide-topic");
                item.Add(heading);
                var body = new Label(text);   // text already has the bound keys filled in
                body.AddToClassList("se-guide-text");
                body.style.whiteSpace = WhiteSpace.Normal;
                item.Add(body);
                scroll.Add(item);
                entries.Add((item, (topic + " " + text).ToLowerInvariant()));
            }

            var empty = new Label("Nothing in the guide matches that.");
            empty.AddToClassList("se-guide-text");
            empty.style.display = DisplayStyle.None;
            scroll.Add(empty);

            Foldout credits = null;
            var creditText = Resources.Load<TextAsset>("Audio/Credits");
            if (creditText != null)
            {
                credits = new Foldout { text = "Sound and music credits", value = openCredits };
                credits.AddToClassList("se-guide-credits");
                var body = new Label(creditText.text);
                body.AddToClassList("se-guide-text");
                body.style.whiteSpace = WhiteSpace.Normal;
                credits.Add(body);
                scroll.Add(credits);
                if (openCredits)
                {
                    var target = credits;
                    scroll.schedule.Execute(() => scroll.ScrollTo(target)).ExecuteLater(50);
                }
            }

            search.RegisterValueChangedCallback(e =>
            {
                string q = (e.newValue ?? "").Trim().ToLowerInvariant();
                int shown = 0;
                foreach (var (el, text) in entries)
                {
                    bool on = q.Length == 0 || text.Contains(q);
                    el.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
                    if (on) shown++;
                }
                empty.style.display = shown == 0 ? DisplayStyle.Flex : DisplayStyle.None;
                if (credits != null) credits.style.display = q.Length == 0 || "sound music credits".Contains(q) ? DisplayStyle.Flex : DisplayStyle.None;
            });
            return host;
        }
    }
}
