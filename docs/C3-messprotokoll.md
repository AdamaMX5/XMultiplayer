# C3 — Messprotokoll (NPC-Bubble mit Interest Management)

**Status: gemischt, wie A1-C2.** Protokoll, Server und Agent sind mit echten
Tests **VERIFIED** (330 Tests grün insgesamt: 84 protocol + 108 agent + 138
server, `npm test --workspaces`). Alles Mod-seitige (`mod/md/XMP_Coop.xml`s
neue `XMP_Coop_BubbleTuningDefaults`/`XMP_Coop_BubbleCheck`-Cues) ist wie bei
A1-C2 ausschließlich auf syntaktische XML-Gültigkeit geprüft
(`System.Xml.XmlDocument.Load`), die Semantik ist komplett ungeprüft — keine
X4-Installation verfügbar. **Anders als C2** (das mod-seitig fast nichts Neues
brauchte) ist C3s Mod-Code der bisher umfangreichste und spekulativste in
diesem Projekt: die erste MD-Logik, die Enumeration + Distanz-Sortierung +
zustandsbehaftete Mengenverfolgung + zeitbasierte Bereinigung kombiniert,
gegenüber der C1s bereits als "höchstes Risiko" geframten Sektor-Enumeration
noch eine Stufe komplexer ist.

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff, wie schon bei C1/C2): drei Funde wurden vor
dem Commit behoben. Der Test-Experte fand ein echtes, bis dahin
undokumentiertes Speicherleck in `XMP_Coop_BubbleCheck`:
`$XMP.CoopBubbleLastSeenAt.{id}` wurde beim Despawn NIE bereinigt (nur
`$XMP.CoopBubbleKnown.{id}`), was die Zeitstempel-Tabelle über eine
Spielsitzung hinweg unbegrenzt wachsen lässt (funktional harmlos, da bei
Wiedereintritt überschrieben, aber real) — jetzt symmetrisch mitbereinigt. Der
Sicherheits-Experte stufte die vollständige Umgehung von `shipClassPreset`
für `category: "npc"`-Spawns zunächst als KRITISCH ein; nach genauerer
Prüfung (NPC-Proxies sind, wie jeder Proxy, lokal unverwundbar und
nicht-spielbar, siehe Abschnitt 3) wurde das als bewusste, dokumentierte
Entscheidung bestätigt statt behoben — aber der zugehörige Code wurde
verschärft: die vorherige `else`-Verzweigung in `server.ts` behandelte
JEDEN Wert außer `"player"` als NPC; jetzt wird explizit auf `"npc"`
geprüft und jeder unerwartete Wert fail-closed abgelehnt (aktuell durch
`parseMessage` ohnehin unerreichbar, aber robust gegen eine künftige
Erweiterung des Enums). Der Code-Review-Experte bemängelte einen
irreführenden Kommentar zur NPC-Budget-Ausnahme (behoben) und regte an,
die aus dem MD-Dialekt resultierende JSON-Aufbau-Duplikation explizit zu
dokumentieren statt sie unkommentiert zu lassen (ergänzt). Zwei vom
Sicherheits-Experten zusätzlich gefundene, strukturelle (nicht C3-spezifische,
aber durch C3 verstärkt sichtbare) Lücken — Budget-Vervielfachung über
mehrere WebSocket-Verbindungen desselben Clients, fehlende globale
Pro-Session-NPC-Obergrenze — wurden NICHT in diesem Milestone behoben,
sondern bewusst als offene Punkte vorgemerkt (Abschnitt 6).

## 1. Der wichtigste Fund vor jeder Mod-Implementierung: bestehende Caps blockierten das Vorhaben

PlanMod.md beschreibt C3 knapp: Host exportiert NPC-Schiffe im Radius um den
Gast, Priorisierung (~10 nächste volle Rate, ferne seltener), Lifecycle
(Spawn/Despawn bei Bubble-Ein-/Austritt), Budget. Der naheliegende Ansatz —
NPCs einfach als gewöhnliche `spawn`/`despawn`/`state_update`-Nachrichten zu
behandeln, exakt wie C2 es für Spielerschiffe tut — kollidiert mit ZWEI
bereits bestehenden Schutzmechanismen, bevor überhaupt eine Zeile Mod-Code
geschrieben wurde:

1. **A4s Spawn-Cap** (`SessionManager.hasOtherActiveSpawn`): "ein aktiver
   Spawn pro Client" — ursprünglich gegen Ressourcen-Erschöpfung durch
   beliebig viele Schiffs-Spawns gedacht. Ein Exporteur, der bis zu ~10 NPCs
   gleichzeitig ankündigen will, hätte ab dem ZWEITEN NPC-Spawn-Versuch
   serverseitig abgelehnt werden können — das ganze Vorhaben wäre praktisch
   funktionsunfähig gewesen.
2. **`SHIP_MACRO_WHITELIST`** (`shipMacros.ts`): eine kleine, handverlesene
   Liste von Arena-PvP-Startschiffen. Echte X4-NPCs (Frachter, Miner,
   Kapitalschiffe, jede Rasse/Fraktion) würden diese Liste fast durchgängig
   verfehlen — NPC-Spiegelung wäre gegen die bestehende Whitelist faktisch
   nicht funktionsfähig gewesen.

Beide Funde erzwangen echte Protokoll-/Server-/Agent-Änderungen, nicht nur
Mod-Code — anders als C2, das komplett ohne Protokolländerung auskam.

## 2. Protokoll — `SpawnMessage.category` (`protocol/src/`)

Ein neues, optionales Feld `category?: "player" | "npc"` auf `spawn`
(`messages.ts`), das bei Abwesenheit als `"player"` behandelt wird (volle
A1-C2-Kompatibilität, kein Wire-Format-Bruch). Zusätzlich:
`MAX_NPC_SPAWNS_PER_CLIENT = 10` (`limits.ts`, exakt PlanMod.md's eigene Zahl
"~10 nächsten/relevantesten Objekte" — verdoppelt als Antwort auf "Budget
definieren"). `parseMessage` validiert `category`, falls vorhanden, gegen die
zwei erlaubten Werte, UND — neu, gilt für JEDEN `spawn`, nicht nur `npc` —
begrenzt `shipType` jetzt auf `MAX_MACRO_NAME_LENGTH` (64 Zeichen, aus C1
wiederverwendet): harmlos für `player`-Spawns (alle Whitelist-Einträge sind
weit darunter), der einzige Größenschutz, den `npc`-Spawns ohne eigene
Whitelist bekommen. `canonical.ts` serialisiert `category` nur, wenn
vorhanden. Getestet in `protocol/tests/parse.test.ts` (6 neue Tests) und
`canonical.test.ts` (Roundtrip inkl. optionalem Feld).

## 3. Server — zwei unabhängige Budgets statt eines geteilten (`server/src/`)

**`SessionManager`** bekommt eine neue parallele Map
`categoryByObjectId: Map<string, SpawnCategory>` (gepflegt in
`recordSpawn`/`removeSpawn`/`takeSpawnedObjectIds`, gleiches Muster wie die
bestehenden `ownerByObjectId`/`spawnsByMember`) und eine neue Methode
`npcSpawnCount(memberId)`. **Bewusste Design-Entscheidung:** `hasOtherActiveSpawn`
selbst bleibt **komplett unverändert** (keine Kategorie-Filterung, keine neuen
Tests für sein bestehendes Verhalten nötig) — `server.ts`s `handleMessage`
ruft es stattdessen für `category === "npc"`-Spawns einfach gar nicht mehr auf
und prüft stattdessen den neuen, separaten `npcSpawnCount(clientId) >=
MAX_NPC_SPAWNS_PER_CLIENT`-Cap. Diese Trennung (statt `hasOtherActiveSpawn`
selbst kategorie-bewusst umzubauen) hält den Blast-Radius auf bereits
getesteten A4-Code minimal — kein bestehender Test musste angepasst werden.

Für `category === "player"` bleiben `isKnownShipMacro`/`isShipClassAllowed`
(Whitelist + Schiffsklassen-Preset) exakt wie bisher; für `category ===
"npc"` werden BEIDE übersprungen (weder die Arena-Whitelist noch das
S/M-Klassen-Preset ergeben für beliebige NPC-Typen Sinn). Der bestehende
Respawn-Gate (`existingOwner === clientId` → ablehnen) gilt unverändert für
BEIDE Kategorien — ein Client kann keine bereits aktive NPC- oder
Spieler-Spawn-ID erneut senden, ohne vorher sauber zu despawnen.

Getestet in `server/tests/npcSpawn.test.ts` (neu, 7 Tests: unwhitelistete
NPC-Shiptype wird durchgelassen, unwhitelistete Player-Shiptype weiterhin
abgelehnt, ein Client kann gleichzeitig einen Spieler- UND einen NPC-Spawn
halten, ein zweiter Spieler-Spawn bleibt weiterhin blockiert,
Cap-Durchsetzung bei `MAX_NPC_SPAWNS_PER_CLIENT + 1`, ein Despawn gibt einen
NPC-Slot frei, ein Doppel-Spawn-Versuch für dieselbe noch aktive NPC-ID wird
vom bestehenden Respawn-Gate abgefangen) und `server/tests/sessionManager.test.ts`
(7 neue Unit-Tests für `npcSpawnCount()`).

## 4. Agent — Whitelist-Bypass + Sanitizing für NPCs (`agent/src/`)

`decideRelay()` (`relayFilter.ts`): die `shipType`-Whitelist-Prüfung greift
jetzt nur noch, wenn `msg.category !== "npc"` — ein NPC-Spawn mit beliebigem
`shipType` wird durchgelassen (die einzige Grenze ist die bereits erwähnte
Längenbegrenzung aus `parseMessage`). `state_update`s Arena-Bounds-Prüfung
bleibt UNVERÄNDERT und gilt identisch für NPCs wie für alles andere — die
±500km-Grenze (`ARENA_BOUNDS_METERS`) ist großzügig genug für reale
X4-Sektorgrößen bemessen (dieselbe Baseline, die C2s Spieler-Schiff-Mirroring
schon unverändert nutzt) und brauchte keine Anpassung.

`sanitizeForPipe()` (`pipeSanitize.ts`) bekam einen neuen Zweig: für
`category: "npc"`-Spawns werden `objectId` UND `shipType` mit
`sanitizeForPipeExtraction()` behandelt — dieselbe Begründung wie C1s
`sector_object`-Felder (kein Whitelist-Schutz mehr, also braucht der
MD-Extraktor den Zeichen-Schutz). **Bewusst NICHT mitbehoben:** ein
`category: "player"`-Spawn (oder ganz ohne `category`) bleibt bei seinem
bereits seit A2 bestehenden, unveränderten Verhalten — `shipType` ist dort
whitelist-geprüft (kein Freitext), `objectId` bleibt der bereits seit C1
dokumentierte, bewusst nicht geschlossene Altfall. Getestet in
`agent/tests/relayFilter.test.ts` (2 neue Tests) und
`agent/tests/pipeSanitize.test.ts` (3 neue Tests).

## 5. Mod — `XMP_Coop_BubbleTuningDefaults`/`XMP_Coop_BubbleCheck` (`mod/md/XMP_Coop.xml`)

### 5.1 Bubble-Zentrum: bewusste Abweichung von PlanMod.md's Wortlaut

PlanMod.md sagt "Host exportiert NPC-Schiffe im Radius um den GAST" — impliziert
ein Zentrum auf der POSITION DES ANDEREN Mitglieds. C3 zentriert die Bubble
stattdessen auf die EIGENE Schiffsposition des Exporteurs. Begründung: im
Standardfall "gemeinsam fliegen" (2 Spieler) konvergieren beide Zentren
näherungsweise; eine echte "Bubble um jedes ANDERE Mitglied" bräuchte eine
Aufzählung ALLER aktuellen Session-Mitglieder, für die es in diesem Codebase
noch keinen Mechanismus gibt (`$XMP.ProxyObjectIdByOwner` ist nur eine
Nachschlagetabelle NACH Namen, keine iterierbare Liste). Für die 2-Spieler-
Praxis ist der Unterschied gering; bei echten 3+-Spieler-Sessions oder wenn
Host/Gast in verschiedenen Sektoren fliegen, müsste diese Vereinfachung
überarbeitet werden — PlanMod.md selbst benennt genau diese Situation bereits
als offenen Entscheidungspunkt für C5 ("nach C3-Performance-Daten").

### 5.2 Enumeration: `find_object` um drei neue Annahmen erweitert

`XMP_Coop_FindObjectsOfClass` (C1) kannte bisher nur `class`/`sector`/
`multiple`. C3 braucht zusätzlich `position`/`maxdist` (Radius-Filter) und
`sortbydistanceto` (nach Entfernung sortiertes Ergebnis) — DREI neue
angenommene Attribute derselben Aktion, plus einen neuen `class`-Wert
(`'ship'`, neben C1s `'station'`/`'gate'`/`'asteroid'`/`'region'`). Bewusst
KEINE vierte neue Annahme (ein hypothetisches `resultmaxcount`-Attribut) für
die Budget-Begrenzung — die läuft stattdessen über einen simplen
MD-seitigen Zähler-Vergleich (dasselbe bereits erprobte `do_all`/Zähler-Muster).

### 5.3 Ausschlussfilter: eigenes Schiff + bereits bekannte Proxies

Ohne Filterung würde ein Fremdspieler-Proxy (real existierendes,
KI-gesteuertes lokales Objekt, siehe `$XMP.ProxyWireIdByGameId`, A2) selbst
als "NPC" re-exportiert — ein Proxy-eines-Proxys, sinnlos und für den
betroffenen Fremdspieler sogar ein Proxy SEINES EIGENEN Schiffs. Der Filter
prüft `entry.id != player.entity.id` UND `not
$XMP.ProxyWireIdByGameId.{entry.id}.exists`. **Bewusst nicht gefiltert:**
lokale, spielereigene NPCs (z. B. eigene Eskorte-/Minenschiffe) — die würden
ebenfalls als "NPC" exportiert, was für V1 als akzeptabel bewertet wird
(weiterhin sichtbare, bewegte Objekte, die der andere Spieler plausibel sehen
möchte).

### 5.4 Lifecycle: Zeitstempel-basierte Bereinigung statt "seen this tick"-Flag

MD hat keinen bestätigten Weg, eine geschlüsselte Tabelle
(`$XMP.CoopBubbleKnown.{id}` für jede zuvor bekannte ID) pro Tick
vollständig zurückzusetzen. Statt eines Boolean-Flags, das jeden Tick neu
gesetzt/gelöscht werden müsste, verwendet `XMP_Coop_BubbleCheck` einen
Zeitstempel (`$XMP.CoopBubbleLastSeenAt.{id} = player.age`), aktualisiert bei
jedem Fund, und eine separate Bereinigungs-Runde, die alles als "verlassen"
behandelt, dessen letzter Zeitstempel älter als `$XMP.CoopBubbleStaleTimeoutSec`
(5s, 2.5x der 2s-Takt-Zeit) ist — exakt dasselbe Idiom, das
`aiscripts/XMP.ProxyPilot.xml`s Dead Reckoning bereits für seinen eigenen
Update-Timeout nutzt (A3). Die bekannte-IDs-Liste
(`$XMP.CoopBubbleKnownIds`) wird bei jedem Bereinigungsdurchlauf komplett neu
aufgebaut (nur Überlebende), nicht in-place mutiert — dasselbe
"Neu-Aufbau-statt-Mutation"-Muster wie C1s `$XMP.CoopExportObjects`.

### 5.5 Ein einziger Takt statt zwei Prioritätsstufen (dokumentierte Vereinfachung)

Alle verfolgten NPCs (bis zu `$XMP.CoopBubbleMaxObjects` = 10, exakt
`MAX_NPC_SPAWNS_PER_CLIENT` gespiegelt) bekommen dieselbe
`state_update`-Taktrate (`$XMP.CoopBubbleTickIntervalSec` = 2s) — PlanMod.md's
"volle Rate für nahe, seltener für ferne" wird NICHT als echtes Zwei-Stufen-
System umgesetzt. Der nächste-N-Cutoff (kombiniert mit den nach Entfernung
sortierten `find_object`-Ergebnissen) erreicht "relevanteste Objekte
zuerst" bereits implizit, ohne eine zweite, langsamere Stufe zu brauchen.
Dead Reckoning (A3) ist genau der Mechanismus, der eine gröbere Taktrate als
die 10Hz-Spielertelemetrie durch Extrapolation überbrücken soll — 2s liegt
komfortabel innerhalb dessen, was die bestehende Tuning-Grenze
(`$XMP.DeadReckoningUpdateTimeoutSec` = 5s) bereits toleriert.

### 5.6 Emergentes, nicht beabsichtigtes C4-Verhalten

Weil NPC-Proxies exakt dieselbe, unveränderte `XMP_Arena_HandleSpawn`-Kette
durchlaufen wie Spielerschiffe, erben sie automatisch A4s UNSCOPED,
universumsweiten `event_object_attacked`-Hook
(`XMP_Arena_OnProxyAttacked`) — `hit_report`/`hp_state`/Zerstörung
funktionieren also technisch schon HEUTE für NPC-Proxies, obwohl PlanMod.md
das explizit erst für C4 ("Hit-Relay auf NPCs") vorsieht. Bekannter,
akzeptierter Schönheitsfehler: das Kill-Feed (`server.ts`s
`broadcastKillFeed`) würde die Zerstörung eines NPCs dem EXPORTIERENDEN
Spieler zuschreiben ("Alice destroyed ..."), da `spawn.owner`/die
Server-Ownership für NPCs dieselbe Client-Zuordnung nutzt wie für das eigene
Schiff. Korrektes NPC-Naming/Kill-Attribution ist C4s Aufgabe, hier bewusst
nicht vorweggenommen.

## 6. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren; `find_object`s drei neue
   Attribute (`position`/`maxdist`/`sortbydistanceto`) UND den neuen
   `class='ship'`-Wert als Erstes prüfen — ohne funktionierende Enumeration
   bleibt die Bubble dauerhaft leer.
2. Reale Performance-Messung (PlanMod.md's eigene Forderung) mit einem
   dicht besiedelten Sektor: taugt `$XMP.CoopBubbleTickIntervalSec` = 2s,
   `$XMP.CoopBubbleMaxObjects` = 10, `$XMP.CoopBubbleRadius` = 20km? Alle
   vier Zahlen sind unverifizierte Platzhalter.
3. Falls die Performance-Daten es rechtfertigen: echtes Zwei-Stufen-System
   (schnellere Taktrate für die nächsten ~3-5, langsamere für den Rest)
   nachrüsten, statt der aktuellen Ein-Takt-Vereinfachung (Abschnitt 5.5).
4. Bubble-Zentrum auf "Position jedes ANDEREN Mitglieds" verallgemeinern,
   sobald eine echte Session-Mitglieder-Aufzählung existiert (Abschnitt 5.1)
   — relevant für 3+-Spieler-Sessions und für C5s "Host/Gast in
   verschiedenen Sektoren"-Fall.
5. C4 ("Hit-Relay auf NPCs") aufsetzen — insbesondere die Kill-Feed-Namensgebung
   für NPCs korrigieren (Abschnitt 5.6) statt des aktuellen impliziten
   "als wäre es der Spieler selbst"-Verhaltens.
6. **Von der Sicherheits-Review gefunden, bewusst nicht in C3 behoben**
   (strukturell, nicht C3-spezifisch, aber durch C3s 10er-NPC-Budget in der
   Auswirkung verzehnfacht): `npcSpawnCount()`/`hasOtherActiveSpawn()` sind
   rein pro-`clientId` gescoped, und `clientId` ist pro WebSocket-Verbindung
   ein frischer `randomUUID()` — ein Client mit mehreren gleichzeitigen
   Verbindungen (bis `maxConnectionsPerIp`, Default 50) könnte sein
   NPC-Budget entsprechend vervielfachen. Dieselbe Lücke existiert strukturell
   seit A4 für den Ein-Spieler-Schiff-Cap, dort mit ×1 statt ×10 Auswirkung.
   Perspektivisch: Budget an IP oder Session-Mitgliedschaft statt an
   `clientId` koppeln.
7. **Ebenfalls von der Sicherheits-Review gefunden:** keine GLOBALE
   Pro-Session-Obergrenze für NPC-Proxies, nur die Pro-Client-Grenze — bei
   kleinen Coop-Sessions (2-4 Spieler, 4×10=40 Proxies max.) unbedenklich,
   bei A5s `--public`/Internet-Modus ohne Mitgliederlimit theoretisch
   relevant. Ein session-weiter NPC-Cap (defense in depth, analog zu den
   bestehenden Verbindungs-/Sessions-Limits aus A5) wäre der nächste Schritt,
   bevor Internet-Betrieb mit aktivem C3 in Betracht gezogen wird.
