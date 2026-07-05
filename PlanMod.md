# PlanMod.md — X4: Foundations Multiplayer über die Modding-Pipeline

> Ziel: Multiplayer-Erlebnisse in X4: Foundations **ohne Engine-Zugriff**, ausschließlich über
> Bordmittel des Modding-Systems (XML-Diffs, Mission-Director-Scripts, AI-Scripts, Lua/UI)
> plus externe Prozesse via Named-Pipe-API.
>
> Leitprinzip: **Wir bauen den Multiplayer nicht IN die Simulation, sondern NEBEN sie.**
> Die lokale Simulation jedes Clients bleibt unangetastet und autoritativ für ihr eigenes Universum.

---

## 0. Gemeinsame Basis-Infrastruktur (Voraussetzung für beide Phasen)

### 0.1 Kommunikationskette

```
X4 Client A ↔ Named Pipe ↔ Agent A (Go/Python) ↔ WebSocket ↔ Relay-Server ↔ Agent B ↔ Named Pipe ↔ X4 Client B
```

| Komponente | Technologie | Verantwortung |
|---|---|---|
| X4-Mod | MD-Scripts, AI-Scripts, ggf. Lua | Zustandsexport, Proxy-Spawning, Proxy-Steuerung, Hit-Relay |
| Pipe-Bridge | SirNukes Mod Support APIs (Named Pipes) | Bidirektionaler Datenkanal Spiel ↔ Agent |
| Agent | Go (bevorzugt) oder Python | Pipe-I/O, Serialisierung (JSON), WebSocket-Client, lokale Vorverarbeitung |
| Server | Go, WebSockets | Relay, Session-Management, HP-Autorität, Matchmaking (minimal) |

### 0.2 Nachrichtenprotokoll (JSON über Pipe und WebSocket)

Grundtypen (Versionierung von Anfang an einbauen: `"v": 1`):

- `state_update` — Position, Rotation, Geschwindigkeitsvektor, Timestamp, Sequenznummer
- `spawn` / `despawn` — Objekt-Lifecycle (Schiffstyp, Loadout-Kurzform, Owner)
- `hit_report` — Schadensmeldung: Ziel-ID, Schadenswert, Schadenstyp (Hull/Shield), Quelle
- `hp_state` — autoritativer HP-Zustand vom Server zurück an beide Clients
- `fire_event` — kosmetisch: "Spieler X feuert Waffe Y" für Fake-Projektile am Proxy
- `session` — Join/Leave/Ready/Countdown
- `chat` — trivial, aber wertvoll für Koordination

### 0.3 MD-seitiger Export (beide Phasen identisch)

- Cue mit periodischem Takt (Ziel: 10 Hz, realistisch validieren — MD-Cues takten
  nicht framegenau; tatsächliche erreichbare Rate in Schritt A1 messen!)
- Export des eigenen Spielerschiffs: Position, Rotation, Geschwindigkeit
- Schreiben in die Pipe über die Mod-Support-API

### 0.4 Bekannte harte Grenzen (akzeptiert, nicht lösbar per Mod)

- MD kann Objekte nur teleportieren, nicht framegenau bewegen → Dead Reckoning via AI-Script
- Projektile sind nicht synchronisierbar → Hit-Reporting-Modell (Client-autoritative Treffer)
- Keine Frame-Level-Interpolation → Restlatenz/Artefakte bei harten Manövern bleiben sichtbar
- SETA/Pause bricht geteilte Zeit → per Konvention/Erkennung behandeln, nicht technisch lösbar

---

## Phase 1 — Arena (PvP-Duell im leeren Sektor)

**Ziel-Erlebnis:** Zwei Spieler verabreden sich, treffen sich in einem dedizierten Arena-Sektor,
kämpfen mit eigenen (echten, verlierbaren) Schiffen. Late-Game-Geldabfluss als Feature:
Wer Asgards verlieren kann, hat einen Grund für die zwanzigste Werft.

### 1.1 Arena-Universum (XML-Content)

- [ ] Eigene Galaxy-Map: ein einzelner Sektor, Custom Gamestart
- [ ] Keine Fraktionen, keine Jobs, keine Wirtschaft, keine God-Module-Aktivität
- [ ] Kartenvarianten als statische Geometrie (nur Seed/Auswahl wird übertragen, Kollision
      danach deterministisch auf beiden Clients identisch):
  - [ ] Leerer Raum (Referenz/Debug)
  - [ ] Asteroidenfeld (Deckung, Ambush-Taktik, LoS-Brüche gegen Turret-Boote)
  - [ ] Trümmerfeld (Wracks aus vorhandenen Assets)
  - [ ] Nebelregion (Sensor-Reduktion über bestehende Region-Definitionen)

### 1.2 Meilensteine

**A1 — Telemetrie-Export (Fundament + Realitätscheck)**
- [ ] Pipe-Verbindung Spiel ↔ Agent stabil
- [ ] Eigene Schiffsposition mit Timestamp/Sequenznummer rausschreiben
- [ ] **Messen: tatsächlich erreichbare MD-Update-Rate** (kritische Kennzahl für alles Weitere)
- [ ] Agent loggt/visualisiert den Stream (Debug-Ansicht reicht)

**A2 — Statisches Proxy-Schiff (Moment der Wahrheit)**
- [ ] Remote-Spieler wird als Schiff gespawnt (`spawn`-Nachricht mit Schiffstyp)
- [ ] Bewegung zunächst naiv per Teleport (`set_object_position`) bei jedem Update
- [ ] **Bewertung: Wie schlimm ist das Ruckeln wirklich?** → Go/No-Go-Entscheidung
      und Baseline für den Vergleich mit A3

**A3 — Dead Reckoning**
- [ ] AI-Script fliegt das Proxy-Schiff auf extrapolierte Zielposition
      (Position + Geschwindigkeitsvektor × Latenz)
- [ ] Engine-Flugsteuerung erzeugt framegenau glatte Bewegung; Netzwerk-Updates
      ändern nur das Ziel, nie die Position direkt
- [ ] Tuning: Extrapolationshorizont, Snap-Schwelle (ab welcher Abweichung hart
      teleportieren statt nachfliegen), Verhalten bei Boost/harten Drehungen
- [ ] Kollisionsvermeidung des AI-Scripts aktiv lassen (Sicherheitsabstand zu Geometrie)

**A4 — Kampf**
- [ ] Proxy-Schiff lokal unverwundbar / lokaler Schaden wird ignoriert
- [ ] Hit-Reporting: lokaler Treffer am Proxy → `hit_report` an Server
- [ ] Server ist HP-Autorität: verrechnet Schaden, broadcastet `hp_state`
- [ ] Clients wenden `hp_state` auf das jeweils betroffene Schiff an
      (Hull/Shield-Manipulation per Script)
- [ ] Kosmetik: `fire_event` → Proxy feuert Fake-Projektile (reine Optik, Treffer
      kommen ausschließlich über hit_report/hp_state)
- [ ] Zerstörung: `hp_state` = 0 → kontrollierte Zerstörungssequenz auf beiden Seiten
- [ ] Bekannte Schwäche dokumentieren: Client-side hit detection = "um die Ecke
      getroffen werden" bei >100 ms Latenz. Akzeptiert für V1.

**A5 — Session & Komfort**
- [ ] Lobby-Minimalismus: Session-Code, Ready-Check, Countdown, Sieg/Niederlage-Erkennung
- [ ] Schiffs-Loadout-Übertragung (Kurzform: Typ + Waffen + wesentliche Ausrüstung)
- [ ] Regel-Presets: Schiffsklassen-Limits (S/M-only vs. Capital erlaubt)
- [ ] SETA/Pause-Erkennung → Gegner benachrichtigen, Match ggf. einfrieren
- [ ] Optional: Spectator als drittes Proxy-Paar ohne Waffenfreigabe

### 1.3 Erfolgs-/Abbruchkriterien Phase 1

- **Erfolg:** Zwei Spieler können sich zuverlässig sehen, umfliegen, beschießen und
  zerstören. Bewegung bei normalen Manövern glaubwürdig. Duell fühlt sich nach
  "Geisterduell mit Spannung" an, nicht nach Diashow.
- **Erwartungsmanagement:** Elite-Dangerous-Dogfighting-Präzision ist NICHT das Ziel
  und per Mod nicht erreichbar. Das steht so auch im README.
- **Abbruch/Pivot:** Wenn A2/A3 zeigen, dass die MD-Update-Rate unter ~3–5 Hz liegt
  und Dead Reckoning das nicht kompensiert → Fokus auf langsamere Schiffsklassen
  (Capital-Duelle sind toleranter) oder asynchrone Modi.

---

## Phase 2 — Coop im Universum des Hosts (Bubble-Sync + Kommando-Relay)

**Ziel-Erlebnis:** Gast besucht das Universum des Hosts, fliegt im Verband, schaut sich
das Imperium an, hilft eingeschränkt im Kampf. Spezialmodus: Gast fliegt das Schiff
des Hosts, Host läuft im Schiff herum ("Remote-Cockpit").

**Architekturprinzip:** Host-Universum = einzige Wahrheit. Gast startet in leerem
Custom-Universum (keine eigene Simulation, die dagegen arbeitet) und sieht ausschließlich
Proxy-Objekte. Alle Scripts laufen weiterhin lokal beim Host — die Bedingung
"alle Objektinformationen sofort verfügbar" bleibt für die Simulation erfüllt.
Aufwandsschätzung: Faktor 5–10 gegenüber Phase 1, aber derselbe Baukasten.

### 2.1 Meilensteine

**C1 — Statischer Sektor-Mirror**
- [ ] Host exportiert beim Gast-Join den aktuellen Sektor: Stationen, Gates,
      Asteroidenfelder, Regionen (einmalige Übertragung, danach statisch)
- [ ] Gast-Client spawnt alles als Proxies in seinem leeren Universum
- [ ] Ergebnis: Gast "steht" im Sektor des Hosts und sieht dessen Welt

**C2 — Host-Schiff als dynamisches Objekt (= Arena-Code wiederverwendet)**
- [ ] Host-Spielerschiff wird beim Gast als Proxy mit Dead Reckoning gespiegelt
- [ ] Gast-Schiff wird beim Host gespiegelt (exakt Arena-Mechanik, Rückkanal)
- [ ] **Emotionaler Meilenstein: "Ich fliege im Universum meines Freundes neben ihm her"**
- [ ] Hier Go/No-Go für die Ausbaustufen C3–C6

**C3 — NPC-Bubble mit Interest Management**
- [ ] Host exportiert NPC-Schiffe im Radius um den Gast
- [ ] Priorisierung: volle Update-Rate nur für die ~10 nächsten/relevantesten Objekte
- [ ] Ferner Verkehr: 1 Update / mehrere Sekunden oder kosmetische "Fahrpläne"
- [ ] Objekt-Lifecycle: Spawn/Despawn bei Bubble-Ein-/Austritt
- [ ] Budget definieren: max. Proxy-Anzahl beim Gast (Performance-Messung!)

**C4 — Hit-Relay auf NPCs**
- [ ] Gast meldet Treffer auf NPC-Proxies → Host wendet Schaden in der echten
      Simulation an → neuer Zustand fließt als Update zurück
- [ ] Erwartung dokumentieren: NPC-Reaktion kommt mit Latenz, Ausweichen wirkt
      nachgezogen. Gut genug für Eskorte/Unterstützung, matschig für Fokusfeuer.
- [ ] Kill-Attribution: Abschüsse des Gasts werden dem Host-Universum korrekt
      zugerechnet (Reputation! Vorsicht mit Fraktions-Konsequenzen)

**C5 — Sektorwechsel**
- [ ] Gate-Durchflug des Gasts: Bubble abreißen, neuen Sektor übertragen
- [ ] Als expliziter "Ladebildschirm-Moment" gestalten (Fade/Hinweis), kein
      nahtloser Übergang nötig
- [ ] Edge Case: Host und Gast in verschiedenen Sektoren → beide Bubbles parallel
      pflegen oder Gast-Bubble priorisieren (Entscheidung nach C3-Performance-Daten)

**C6 — Kommando-Relay (Befehle, jede Interaktion = eigenes Mini-Protokoll)**

Prinzip: Menü-Interaktionen des Gasts sind Transaktionen gegen den Host-Zustand.
Jede einzelne wird als Request → Host-Validierung → Bestätigung → lokale Abspielung
gebaut. Bewusst inkrementell, sortiert nach Wert/Aufwand:

- [ ] **Docking**: "Gast will an Station X docken" → Host prüft, bestätigt →
      Gast spielt Docking am Proxy ab. (Ohne Relay: rein physisches Andocken am
      Proxy möglich, aber ohne Konsequenzen)
- [ ] **Reparatur/Nachschub** an Host-Stationen (Host zahlt oder verrechnet)
- [ ] **Handel** (Gast ↔ Host-Wirtschaft): Host führt Transaktion aus, Ergebnis-Relay
- [ ] **Befehle an Host-Schiffe**: Gast darf (mit Freigabe des Hosts) einzelnen
      Schiffen/Flotten des Hosts Karten-Befehle geben → als Kommando-Relay,
      Host-Client führt aus. Rechtemodell: Host vergibt Rollen ("Flottenkommando",
      "nur eigene Eskorte", "nur zuschauen")
- [ ] Missionsannahme/gemeinsame Missionen: bewusst NACH hinten geschoben
      (höchste Komplexität, geringster Kern-Nutzen)

**C7 — Remote-Cockpit-Modus (Gast fliegt Host-Schiff, Host läuft im Schiff)**

Gutmütigstes Szenario, hohe Priorität nach C2 möglich (unabhängig von C3–C6):
- [ ] Rollen-Switch: Gast erhält Flugkontrolle über eine lokale Kopie des Host-Schiffs
      (null Eingabelatenz beim Piloten — Latenz landet vollständig beim Host, der
      sie als stehender Beobachter im lokalen Bezugssystem des Innenraums nicht spürt)
- [ ] Host-Seite: Schiff wird von AI-Script auf extrapolierte Zielvorgaben geflogen
      (nie teleportieren — Engine-Flugsteuerung erzeugt framegenau glatte Bewegung)
- [ ] Kollisionsschaden für das synchronisierte Schiff host-seitig deaktivieren/dämpfen
      (Wahrheit über Schaden kommt über Hit-Relay, nicht über Replik-Kollisionen)
- [ ] Sicherheitsabstands-Parameter im AI-Script (Replik darf nicht in Asteroiden
      fliegen, die der Gast knapp verfehlt)
- [ ] Übergabe-Protokoll: Kontrolle anfordern/übergeben/entziehen (Host behält Veto)

**C8 — SETA/Pause-Politik**
- [ ] Erkennung von SETA/Pause auf Host-Seite → Gast-Benachrichtigung + Gast-Schiff
      einfrieren ("Zeitanomalie"-Framing als kosmetische Lösung)
- [ ] Empfohlene Konvention im README: kein SETA solange verbunden
- [ ] Kein Anspruch auf elegante technische Lösung — dokumentierte Grenze

### 2.2 Erfolgskriterien Phase 2

- C2 erreicht = Kernerlebnis steht (gemeinsames Fliegen im Host-Universum)
- C7 erreicht = "Beifahrer-Koop" als rundes, vorzeigbares Feature
  (bestes Verhältnis Erlebnisqualität zu Sync-Aufwand im ganzen Projekt)
- C3–C6 sind Ausbaustufen nach Bedarf und Performance-Realität

---

## 3. Explizite Nicht-Ziele (per Mod unerreichbar — siehe PlanEngine.md)

- Frame-genaue Interpolation von Remote-Objekten
- Echte Projektil-Synchronisation / serverseitige Lag Compensation
- Shared Universe mit synchronisierter Wirtschaftssimulation
- Präzises kompetitives Dogfighting auf Netcode-Niveau moderner Multiplayer-Titel
- Nahtlose Menü-/UI-Integration für den Gast (jedes Relay bleibt Stückwerk)

## 4. Offene Fragen / Risiken (früh validieren)

1. **Reale MD-Update-Rate** unter Last (A1) — die eine Zahl, an der alles hängt
2. Pipe-Durchsatz bei C3-Objektmengen (Serialisierungskosten im MD?)
3. Verhalten der AI-Flugsteuerung bei sehr hochfrequenten Zielwechseln (A3-Tuning)
4. Stabilität von Spawn/Despawn großer Proxy-Mengen (Savegame-Verschmutzung? →
   Coop-Sessions grundsätzlich in Wegwerf-Saves des Gasts)
5. Versionskompatibilität: Mod-Version + X4-Version + DLC-Bestand beider Spieler
   müssen matchen (Handshake beim Session-Start prüft das)

## 5. Repo-Struktur (Vorschlag)

```
/mod/            X4-Extension (content.xml, md/, aiscripts/, maps/, ui/)
/agent/          Go-Agent (Pipe-I/O, WebSocket-Client)
/server/         Go-Relay-Server (Sessions, HP-Autorität)
/protocol/       JSON-Schema der Nachrichten, versioniert
/docs/           PlanMod.md, PlanEngine.md, Messprotokolle (A1!), Architektur
```
