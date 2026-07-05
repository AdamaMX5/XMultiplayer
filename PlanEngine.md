# PlanEngine.md — X4: Foundations Multiplayer mit Engine-Zugriff

> Dieses Dokument sammelt, was **vermutlich** möglich wird, wenn Zugriff auf den
> internen Engine-Code besteht (Anstellung/Freelance bei Egosoft oder offizielle
> Kooperation). Es ist bewusst als Konzept-/Argumentationspapier geschrieben:
> Alles hier ist Hypothese auf Basis von öffentlich Bekanntem über die Engine —
> keine Insider-Information. Erste Aufgabe bei echtem Zugriff wäre die Validierung
> der Annahmen in Abschnitt 6.
>
> Kernthese: **Die Probleme der Mod-Variante (PlanMod.md) sind keine konzeptionellen
> Probleme, sondern reine Zugriffsprobleme.** Mit Engine-Zugriff fallen sie der Reihe nach.

---

## 1. Ausgangslage und das Lokalitäts-Argument

Der historische Haupteinwand gegen X-Multiplayer (u.a. von Bernd Lehahn vertreten):
*Alle Scripts sind auf lokale Ausführung ausgelegt; Informationen über alle Objekte
stehen der Simulation jederzeit sofort zur Verfügung.* Daraus folgt korrekt:
**Shared Universe mit voller Simulation ist ein Mammutprojekt** — Simulationskern,
Out-of-Sector-Modell, SETA, Pause, alles müsste neu gedacht werden, in einer
Codebasis mit Wurzeln bis in die X2/X3-Ära.

Die Antwort dieses Papiers: Das Argument gilt für Shared Universe — **nicht für
instanzierte und asymmetrische Modi.** Beide hier vorgeschlagenen Modi lassen die
Simulation vollständig lokal:

- **Arena-Instanz:** dedizierter Sektor ohne Wirtschaft/Jobs/Fraktionen → es gibt
  fast keine Scripts, die synchron laufen müssten; die Objektliste ist winzig und
  serverautoritativ. Multiplayer NEBEN der Simulation, nicht darin.
- **Coop im Host-Universum:** alle Scripts laufen weiterhin lokal — beim Host, als
  einziger Wahrheit. Der Gast ist aus Simulationssicht nur ein weiteres Schiff mit
  externem Input. Die Bedingung "alle Informationen sofort verfügbar" bleibt erfüllt.

Zusätzliches Argument: **Beide Modi benötigen null neues Balancing.** Keine
Item-Inflation, kein PvP-Meta, das Schiffswerte kaputtmacht, keine Waffen-Retunings.
Die Arena *konsumiert* sogar Late-Game-Wirtschaft (Schiffsverluste als Geldabfluss)
und adressiert damit das bekannte Motivationsloch, sobald die Wirtschaftsmaschine steht.

Infrastruktur-Vorleistung existiert: **Ventures** beweisen Accounts,
Server-Kommunikation und Objekt-Transfer zwischen Universen. Der Vorschlag ist
inkrementell: "Ventures++", nicht "X4 wird ein MMO".

---

## 2. Was mit Engine-Zugriff sofort lösbar wird

Direkte Auflösung der harten Grenzen aus PlanMod.md Abschnitt 3:

| Problem (Mod-Variante) | Lösung (Engine-Variante) |
|---|---|
| MD kann nur teleportieren; Dead Reckoning als Krücke | Eigener Bewegungsmodus für Remote-Entities im Entity-Update: Snapshot-Interpolation/-Extrapolation, framegenau glatt |
| Update-Rate durch MD-Cue-Takt begrenzt (~einstellige Hz) | Netzwerk-Snapshots mit 20–60 Hz direkt im Engine-Loop |
| Projektile nicht synchronisierbar; Fake-Schüsse + Hit-Reporting | Deterministische Projektil-Replikation (Event mit Seed + Timestamp, beidseitig identisch simuliert) ODER serverautoritative Hit-Detection |
| Client-side hit detection ("um die Ecke getroffen") | **Lag Compensation**: Server spult Positionen um die Client-Latenz zurück (Half-Life/Source-Modell) → faire, präzise Treffer |
| Pipe/Agent/JSON-Umweg | Nativer Netzwerk-Layer im Client |
| Gast-Menüs/UI nur als Stückwerk-Relays | Echte UI-Integration: Gast-Interaktionen als first-class Netzwerk-Transaktionen |
| Bubble-Sync als Proxy-Nachbau | Echtes Replikationssystem mit Interest Management auf Engine-Ebene |

**Konsequenz: echtes Dogfighting-Gefühl wird erreichbar** — das eine Erlebnisziel,
das die Mod-Variante prinzipiell nicht liefern kann.

---

## 3. Modus A: Instanzierte Arena / Koop-PvP-Sektoren ("Ventures++")

### Konzept
Ein dedizierter Sektor, der nicht von der lokalen Wirtschaftssimulation getrieben
wird, sondern von einem autoritativen Server. Beim Betreten wechselt der Client
**für diesen Sektor** in einen Netzwerk-Modus; beim Verlassen übernimmt wieder die
lokale Simulation. Das umgeht elegant das unlösbare Problem, zwei komplette
Wirtschaftssimulationen zu syncen.

### Technische Bausteine
- **Server-autoritativer Sektor-Zustand**: begrenzte Objektzahl (Spielerschiffe,
  wenige Umgebungsobjekte), Snapshot-Broadcast mit Delta-Kompression
- **Client-Prediction fürs eigene Schiff** + Reconciliation (Standard-Modell)
- **Snapshot-Interpolation für Fremdobjekte** (Puffer von 2–3 Snapshots, ~100 ms
  Interpolationsverzug — unsichtbar, aber butterweich)
- **Lag Compensation** für Hitscan-/Schnellprojektil-Waffen; langsame Projektile
  (Torpedos, Plasmablasen) deterministisch repliziert
- **Statische Kartengeometrie per Seed**: Asteroiden-/Trümmerfelder deterministisch
  generiert, nur der Seed wird übertragen; Nebel/Regionen aus bestehenden Definitionen
- **Zerstörbare Umgebung als Events** ("Objekt X zerstört bei Timestamp T"), keine
  Physik-Synchronisation nötig
- **Schiffs-Import**: Spieler bringt echtes Schiff aus seinem Universum mit
  (Ventures-Transfermechanik), Verlust ist permanent → Late-Game-Sink

### Spielmodi (billig erweiterbar, nutzen vorhandene Assets)
- Symmetrisches Duell (1v1, S/M oder Capital)
- Team-Gefechte (2v2+), Flotten-Slots mit Punktebudget
- Asymmetrisch: "Verteidige das Wrack", Konvoi-Überfall, King-of-the-Asteroid
- Spectator-Slots, Replay über Snapshot-Aufzeichnung (fällt fast gratis ab)

### Aufwandseinschätzung
Als Team-Projekt in **Monaten denkbar, nicht Jahren** — weil die Kernsimulation
unangetastet bleibt und Ventures-Infrastruktur (Accounts, Server, Transfer)
wiederverwendet wird. Größte Einzelposten: Netzwerk-Layer im Client (Prediction/
Interpolation/Reconciliation), Server-Sim des Sektors, Anti-Cheat-Minimum.

---

## 4. Modus B: Drop-in-Koop im Host-Universum ("Ein Universum, ein Host")

### Konzept
Spieler B fliegt ein Schiff im Universum von Spieler A. Das Universum von A ist die
einzige Wahrheit; die gesamte Simulation läuft unverändert bei A. Synchronisiert
werden nur Input und Zustand einzelner Schiffe plus der Sichtbarkeits-Stream für B.
**Kein Script muss je auf Netzwerkdaten warten.**

### Technische Bausteine
- **Replikations-Stream Host → Gast**: Objekte im Interessensbereich des Gasts
  (Interest Management: Distanz + Relevanz), mit nativer Interpolation beim Gast
- **Input-Stream Gast → Host**: Steuerinput oder High-Level-Flugzustand des
  Gast-Schiffs; Host-Simulation integriert es als normales Schiff
- **Gast-UI als Netzwerk-Transaktionen**: Handel, Docking, Reparatur, Missions-
  interaktion — jeweils Request → Host-Validierung → Ergebnis. Mit Engine-Zugriff
  als einheitliches RPC-Muster statt (wie in der Mod-Variante) als Einzel-Relays
- **Rechte-/Rollenmodell**: Host vergibt Befugnisse (nur fliegen / eigene Eskorte
  befehligen / Flottenkommando / Handel auf Host-Konto)
- **Remote-Cockpit als Spezialfall**: Gast fliegt ein Host-Schiff, Host bewegt sich
  frei im Schiff. Mit Engine-Interpolation trivial glatt (der Innenraum ist ohnehin
  ein lokales Bezugssystem — Positionskorrekturen des Schiffs erschüttern die
  Innenperspektive nicht). Latenz liegt vollständig beim Piloten-Gast in dessen
  lokaler Prediction versteckt
- **SETA/Pause-Politik**: im Koop deaktiviert oder an Konsens beider Spieler
  gebunden (UI-Prompt). Kein technisches Problem mehr, reine Design-Entscheidung
- **Sektorwechsel des Gasts**: Streaming des neuen Interessensbereichs, mit
  Engine-Zugriff als kurzer Übergang statt Ladebildschirm-Abriss

### Warum das deutlich billiger ist als echte Symmetrie
Es gibt keinen zweiten Simulationszustand. Kein Determinismus-Zwang, kein Lockstep,
keine Konfliktauflösung zwischen zwei Wahrheiten. Der Gast ist ein Client im
klassischen Server-Client-Sinn — der "Server" ist zufällig das laufende Spiel des
Hosts. Die Host-Performance-Frage (Simulation + Replikation + eigenes Spiel) ist
der wichtigste zu validierende Punkt (→ Abschnitt 6).

---

## 5. Explizit NICHT vorgeschlagen (und warum)

**Volles Shared-Universe-Multiplayer.** Bleibt auch mit Engine-Zugriff ein
Mammutprojekt, weil die Simulation auf Single-Player-Annahmen gebaut ist:
- SETA ist mit geteilter Zeit inkompatibel; Pause ebenso
- Das Out-of-Sector-Modell (vereinfachte Simulation ohne Spielerpräsenz) müsste
  neu gedacht werden, wenn in jedem Sektor ein Spieler sein könnte
- Der Simulationskern müsste deterministisch oder serverseitig laufen — beides
  bedeutet, große über Jahrzehnte gewachsene Code-Bereiche anzufassen
- Und: Es würde massives Balancing-Neuland erzwingen — genau das, was die beiden
  vorgeschlagenen Modi bewusst vermeiden

Dieses Papier positioniert die zwei Modi als das, was sie sind: **der maximale
Multiplayer-Nutzen bei minimalem Eingriff in den Simulationskern.**

---

## 6. Annahmen, die bei echtem Engine-Zugriff zuerst zu validieren sind

1. **Entity-/Bewegungssystem**: Lässt sich ein Remote-Bewegungsmodus (Interpolation
   statt Simulation) pro Objekt sauber einhängen, ohne Physik/Kollision zu brechen?
2. **Trennbarkeit der Sektor-Simulation**: Kann ein einzelner Sektor aus der
   God/Jobs/Wirtschafts-Maschinerie herausgelöst und extern getrieben werden
   (Arena-Modus), ohne dass globale Systeme hineingreifen?
3. **Host-Budget (Koop)**: CPU-/Bandbreiten-Kosten der Replikation auf dem
   Host-Client bei realen Universen (späte Saves mit riesigen Imperien!)
4. **UI-Architektur**: Wie stark hängen Menü-Aktionen an der Annahme "lokaler,
   sofort verfügbarer Simulationszustand"? (Kern des Lokalitäts-Arguments auf
   UI-Ebene — bestimmt die Kosten der Gast-Transaktionen)
5. **Ventures-Infrastruktur**: Wie viel von Account-System, Server-Backend und
   Transfer-Protokoll ist für instanzierte Live-Sessions wiederverwendbar?
6. **Determinismus-Inseln**: Sind Projektilflug/ballistische Waffen bei gleichem
   Seed/Input auf zwei Clients bit-identisch? (Entscheidet: deterministische
   Replikation vs. reine Server-Autorität für Projektile)
7. **Savegame-Integrität**: Sauberes Ein-/Ausklinken von Netzwerk-Sessions ohne
   Save-Verschmutzung (Gast-Objekte, Reputation, Kill-Attribution)

---

## 7. Referenzmaterial (ausgereifte, gut dokumentierte Muster)

- **Source-Engine-Netcode-Dokumentation** (Valve): Prediction, Interpolation,
  Lag Compensation — das Grundvokabular für Modus A
- **GDC-Talks zu Overwatch** (Netcode/ECS-Replikation) und **Rocket League**
  (Physik-Sync, Client-Prediction unter Latenz)
- Gaffer on Games (Glenn Fiedler): Snapshot-Kompression, deterministischer Lockstep
  vs. State-Sync — Entscheidungsgrundlagen für Abschnitt 6.6
- Ventures (Egosoft) als hauseigener Präzedenzfall für Online-Infrastruktur

---

## 8. Pitch-Kurzfassung (für ein einseitiges Konzeptpapier)

> **Zwei Multiplayer-Modi. Null Balancing-Impact. Simulation bleibt unangetastet.
> Ventures-Infrastruktur als Basis.**
>
> 1. **Arena-Instanzen**: Server-autoritative PvP-Sektoren. Late-Game-Sink —
>    Spieler verlieren echte Schiffe und bekommen endlich einen Grund für ihre
>    Werften-Imperien. Monate, nicht Jahre.
> 2. **Drop-in-Koop**: Ein Freund fliegt im eigenen Universum mit. Ein Host, eine
>    Wahrheit, alle Scripts bleiben lokal. Beantwortet das Lokalitäts-Argument
>    direkt statt es zu bestreiten.
>
> Der Mod-Prototyp (PlanMod.md) demonstriert beide Prinzipien mit Bordmitteln —
> als Machbarkeitsnachweis und Messlatte dafür, wie viel besser die native
> Umsetzung wäre.
