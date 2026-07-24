# C4 — Messprotokoll (Hit-Relay auf NPCs)

**Status: gemischt, wie A1-C3.** Protokoll/Server sind mit echten Tests
**VERIFIED**. Alles Mod-seitige (`mod/md/XMP_Arena.xml`s neuer dritter Zweig in
`XMP_Arena_HandleHpState`, `mod/md/XMP_Coop.xml`s neue
`$XMP.CoopBubbleGameObjectByWireId`-Tabelle und die neue
`XMP_Coop_ForgetBubbleNpc`-Cue) ist wie bei A1-C3 ausschließlich auf
syntaktische XML-Gültigkeit geprüft (`System.Xml.XmlDocument.Load`), die
Semantik ist komplett ungeprüft — keine X4-Installation verfügbar.

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff, wie schon bei C1-C3): keine Funde, die vor
dem Commit behoben werden mussten. Der Test-Experte bestätigte Server = 
**VERIFIED** (147/147 Tests grün, inkl. 9 neuer `sessionManager`-Tests und 1
neuem NPC-Kill-Feed-Integrationstest; der bestehende Spieler-Kill-Feed-Test
bleibt unverändert grün) und Mod = **PLAUSIBLE** (beide XML-Dateien laden
weiterhin gültig, keine Logikfehler beim Nachlesen der Struktur gefunden,
insbesondere die Verschachtelung des neuen dritten Zweigs in
`XMP_Arena_HandleHpState` und die Exklusivität von `$XMP.
CoopBubbleGameObjectByWireId` gegenüber `$XMP.Proxies` pro Client). Der
Code-Review-Experte vergab **✅ Akzeptiert** ohne Änderungswunsch (die
parallelen Maps in `SessionManager` bleiben bewusst so, ein
`broadcastKillFeed` mit 6 Parametern gilt noch als lesbar, die
Ordering-Anforderung "vor `removeSpawn` lesen" ist an drei Stellen
dokumentiert). Der Sicherheits-Experte fand keinen KRITISCH/HOCH-Fund, aber
zwei bemerkenswerte Punkte (siehe Abschnitt 5).

## 1. Der eigentliche Umfang von C4: nicht "Hit-Relay bauen", sondern eine Lücke schließen

`docs/C3-messprotokoll.md` Abschnitt 5.6 hatte bereits vorweggenommen, dass
`hit_report`/`hp_state`/Zerstörung für NPC-Proxies **mechanisch schon
funktionieren** — NPCs durchlaufen exakt dieselbe, unveränderte
`XMP_Arena_HandleSpawn`-Kette wie Spielerschiffe und erben damit A4s unscoped
`event_object_attacked`-Hook. Was C4 tatsächlich fehlte, waren zwei konkrete,
unabhängige Lücken:

1. **Die REALE NPC nahm nie Schaden.** `XMP_Arena_HandleHpState` kannte bis
   C4 nur zwei Fälle: das eigene Schiff (`player.entity.id`) oder eine
   Proxy eines ANDEREN Mitglieds (`$XMP.Proxies`). Ein Client, der eine NPC
   exportiert (`XMP_Coop_BubbleCheck`, C3), hält für diese NPC aber gar
   keinen Proxy-Eintrag — sie ist auf seinem eigenen Client ein reales,
   lokales Objekt, kein Proxy. Ein zurücklaufendes `hp_state` für diese
   NPC-ID landete also in KEINEM der beiden Zweige und tat schlicht nichts:
   Schaden wurde nur auf den PROXIES der anderen Mitglieder sichtbar
   (kosmetischer Blackboard-Wert, ohne echte Konsequenz), nie auf dem
   echten Objekt selbst.
2. **Falsche Kill-Feed-Zuschreibung.** `server.ts`s `broadcastKillFeed` nutzte
   für den Opfernamen unconditionally `victimClientId`s `playerName` — für
   eine NPC ist das der EXPORTIERENDE Spieler (dessen `clientId` ist
   `spawn.owner` für NPC-Spawns genauso wie für das eigene Schiff), nicht die
   NPC selbst. Eine zerstörte NPC hätte also z. B. "Bob destroyed Alice"
   angezeigt, obwohl Alice nur die Existenz der NPC gemeldet, nicht selbst
   ihr Schiff verloren hat.

Beide Punkte wurden unabhängig behoben (Abschnitte 2 und 3). Kein
Protokoll-Wire-Format musste sich ändern — `hit_report`/`hp_state` sind seit
A4 bereits generisch genug.

## 2. Server — Kill-Feed-Zuschreibung (`server/src/`)

**`SessionManager`** bekommt eine neue parallele Map
`shipTypeByObjectId: Map<string, string>` (gleiches Idiom wie
`categoryByObjectId`), gepflegt in `recordSpawn`/`removeSpawn`/
`takeSpawnedObjectIds`, plus zwei neue Getter `categoryOf(objectId)` und
`shipTypeOf(objectId)` (bislang gab es nur die aggregierende
`npcSpawnCount()`, keinen direkten Nachschlag pro Objekt). `recordSpawn`s
neuer `shipType`-Parameter ist optional, damit bestehende Test-Aufrufe mit
weniger Argumenten gültig bleiben.

**`server.ts`**: `handleMessage`s spawn-Zweig übergibt jetzt `msg.shipType` an
`recordSpawn`. `destroyObject` liest `victimCategory`/`victimShipType` **vor**
`sessions.removeSpawn(...)` aus (dieselbe Reihenfolge-Anforderung, die
`victimClientId`/`ownerOf()` schon hatte — `removeSpawn` löscht beide neuen
Maps symmetrisch). `broadcastKillFeed` bekommt zwei neue Parameter und
unterscheidet jetzt: `category === "npc"` → Opfername ist `victimShipType`
(Fallback `"an NPC ship"`, rein defensiv, `shipType` ist ein Pflichtfeld auf
dem Wire); sonst unverändert der bisherige Spieler-Namens-Lookup.

Getestet in `server/tests/sessionManager.test.ts` (9 neue Tests:
`categoryOf`/`shipTypeOf` lesen, Default `"player"`, Aufräumen nach
`removeSpawn`/`takeSpawnedObjectIds` symmetrisch zu `ownerOf`, Respawn
überschreibt den alten `shipType`) und `server/tests/session.test.ts` (1 neuer
Integrationstest: eine über die volle WebSocket-Kette zerstörte NPC erzeugt
`"Bob destroyed ship_par_s_scout_01_a_macro"`, nicht `"Bob destroyed Alice"` —
Regressionsschutz für den bestehenden Spieler-Kill-Feed-Test bleibt
unverändert grün).

## 3. Mod — echte NPC-Schadensanwendung (`mod/md/`)

### 3.1 `XMP_Coop.xml` — ein Objekt-Handle statt nur Positions-Snapshots

`XMP_Coop_BubbleCheck` (C3) liest pro Tick nur Skalarfelder aus
`$XMP.CoopBubbleEntry` (Position, Rotation, Hull, ...) und verwirft die
Objektreferenz danach — für C3s Zweck (Export als `spawn`/`state_update`)
reichte das. C4 braucht die Referenz selbst weiter, also wird sie jetzt in
einer neuen Tabelle `$XMP.CoopBubbleGameObjectByWireId.{id}` gehalten,
aktualisiert bei JEDEM Tick, an dem die NPC noch gefunden wird (nicht nur bei
Neuentdeckung) — dieselbe "immer frisch halten"-Überlegung wie
`CoopBubbleLastSeenAt`.

Symmetrisches Aufräumen an zwei Stellen: der bestehende Stale-Timeout-Despawn
(NPC verlässt den Radius, ohne zerstört zu werden) löscht jetzt zusätzlich
`$XMP.CoopBubbleGameObjectByWireId.{id}` — dieselbe Art Leck, die C3s Review
bereits einmal für `CoopBubbleLastSeenAt` gefunden und behoben hatte,
hier von Anfang an mitbehoben statt erst in einer künftigen Review-Runde
gefunden zu werden. Die neue Cue `XMP_Coop_ForgetBubbleNpc` (siehe 3.2)
übernimmt das Aufräumen für den ZWEITEN Fall (echte Zerstörung).

### 3.2 `XMP_Coop_ForgetBubbleNpc` — Aufräumen außerhalb der Tick-Schleife

Der bestehende Stale-Timeout-Despawn-Pass baut `$XMP.CoopBubbleKnownIds` schon
während des Iterierens neu auf (Survivors-Liste). Eine durch `hp_state`
ausgelöste Zerstörung passiert aber NICHT innerhalb dieser Schleife, sondern
von außen (aus `XMP_Arena_HandleHpState`, einer anderen Datei). Die neue Cue
`XMP_Coop_ForgetBubbleNpc` (Parameter: `$XMP.CoopForgetObjectId`) baut
`$XMP.CoopBubbleKnownIds` einmalig neu auf (dasselbe "neu aufbauen statt
mutieren"-Idiom wie überall sonst in dieser Datei) und löscht alle drei
Pro-ID-Tabellen. Ohne das würde eine echte Zerstörung erst nach
`$XMP.CoopBubbleStaleTimeoutSec` (5s) vom nächsten Tick als (irreführendes)
`"left_bubble"`-Despawn nachbehandelt — harmlos (das Objekt ist ja schon weg,
`find_object` findet es ohnehin nicht mehr), aber eine unnötige, verzögerte
Extra-Nachricht mit falscher Begründung.

### 3.3 `XMP_Arena.xml` — dritter Zweig in `XMP_Arena_HandleHpState`

Der bestehende `do_if`/`else`-Zweig (eigenes Schiff / Proxy eines anderen
Mitglieds) bekommt einen dritten, verschachtelten Fall: falls
`$XMP.CoopBubbleGameObjectByWireId.{objectId}.exists` — also eine der EIGENEN,
lokal exportierten NPCs — wird `set_object_hull`/`set_object_shield` auf das
ECHTE Objekt angewendet (erste Verwendung dieser beiden Aktionen auf ein
Objekt, das weder das eigene Schiff noch ein unverwundbarer Proxy ist; neue,
unbestätigte Annahme, dass sie identisch funktionieren). Hull ≤ 0 löst
`destroy_object` (mit Explosion) plus `XMP_Coop_ForgetBubbleNpc` aus.

Die drei Fälle (eigenes Schiff / fremder Proxy / eigene reale NPC) sind
gegenseitig exklusiv PRO CLIENT, ohne dass irgendwo Host/Gast unterschieden
werden muss (dasselbe symmetrische Architekturprinzip wie C1-C3): eine
NPC-ID ist für einen gegebenen Client entweder ein Proxy (er hat sie per
`spawn` empfangen) oder ein eigenes reales Objekt (er hat sie selbst per
`XMP_Coop_BubbleCheck` exportiert), nie beides — `XMP_Coop_BubbleCheck`s
eigener Ausschlussfilter (C3, gegen `$XMP.ProxyWireIdByGameId`) verhindert
das strukturell.

### 3.4 Akzeptierte, bewusst nicht gelöste Punkte

- **Keine Fraktions-Reputationskonsequenz** (PlanMod.md C4 selbst warnt:
  "Reputation! Vorsicht mit Fraktions-Konsequenzen"): `destroy_object` trägt
  keinen simulierten Angreifer/keine Waffe, X4s eigenes
  Reputationssystem registriert also gar keine Standsänderung — weder
  Bonus für die Zerstörung einer feindlichen NPC noch Malus für eine
  befreundete. Bewusst sicher-durch-Weglassen statt einer echten
  Reputations-Gutschrift/-Belastung, die eine neue, ungetestete API
  bräuchte.
- **NPC-Reaktionslatenz** (PlanMod.md C4 "Erwartung dokumentieren"): Schaden
  erreicht die echte NPC erst nach dem vollen Rundlauf (lokale Trefferkennung
  beim Angreifer → `hit_report` an den Server → `hp_state` zurück an den
  Exporteur). Etwaige KI-Reaktion (Ausweichen, Zurückschießen) startet erst
  danach — dieselbe akzeptierte Latenz-Einordnung wie A4s "um die Ecke
  getroffen" für Spielerschiffe. Gut genug für Eskorte/Unterstützungsfeuer,
  matschig für präzises Fokusfeuer (PlanMod.md's eigene Einschätzung).
- Kill-Attribution ist damit auf der SOZIALEN Ebene gelöst (Kill-Feed-Text),
  nicht auf der spielmechanischen (Reputation) — eine bewusste, dokumentierte
  Entscheidung, keine Lücke.

## 5. Von der Sicherheits-Review gefunden, bewusst nicht in C4 behoben

Kein KRITISCH/HOCH-Fund. Zwei MITTEL-Einstufungen, beide zu bestehenden,
bereits in `docs/C3-messprotokoll.md` Abschnitt 6 (Punkte 6 und 7) offen
vermerkten strukturellen Lücken:

1. **C4 macht C3s zwei offene Budget-Lücken erstmals real-destruktiv statt
   nur kosmetisch.** Vor C4 blieb ein Überschreiten des pro-`clientId`
   multiplizierbaren NPC-Budgets (mehrere WebSocket-Verbindungen desselben
   Clients) bzw. das Fehlen eines globalen Pro-Session-NPC-Caps folgenlos —
   NPCs waren reine kosmetische Proxies bei den anderen Mitgliedern. Seit
   `XMP_Arena_HandleHpState`s neuem dritten Zweig kann ein `hit_report` gegen
   eine beliebige getrackte NPC-ID (server-seitig bewusst nicht
   Ownership-geprüft, seit A4/C3 unverändert) das ECHTE Objekt beim
   Exporteur zerstören. Empfehlung der Review: den in C3 bereits
   vorgemerkten session-weiten NPC-Cap vorziehen, bevor C4 zusammen mit
   A5s `--public`-Modus betrieben wird. **Nicht in diesem Milestone
   behoben** — dieselbe "dokumentieren statt lösen"-Entscheidung wie C3
   sie für diese beiden Punkte bereits getroffen hat, hier nur mit
   aktualisierter Risikoeinschätzung.
2. **`shipType` bleibt roh in `shipTypeByObjectId` gespeichert** (nur
   längenbeschränkt via `MAX_MACRO_NAME_LENGTH`, keine
   Kontrollzeichen-Filterung). Der tatsächliche Kill-Feed-Pfad ist bereits
   durch die bestehende, nachgelagerte agent-seitige `sanitizeForPipe`-
   Behandlung (`agent/src/pipeSanitize.ts`) vor MD-Extraktions-Korruption
   geschützt — kein neues Loch. NIEDRIG eingestuft; optionale
   Konsistenz-Verbesserung (Sanitizing bereits bei `recordSpawn`) für eine
   spätere Gelegenheit vorgemerkt, nicht in C4 umgesetzt (kein aktueller
   Schadenspfad, nur Verteidigung gegen eine hypothetische künftige
   Direktnutzung, z. B. Logging).

## 6. Nächste Schritte

1. X4-Installation nötig, um alle drei neuen Mod-Annahmen zu prüfen: (a) dass
   `$XMP.CoopBubbleEntry` (ein `find_object`-Ergebnis-Eintrag) über einen
   kompletten Tick-Zyklus hinweg als gültige, weiter verwendbare Objektreferenz
   gespeichert werden kann (nicht nur für die Dauer einer einzelnen Cue-Aktion
   gültig); (b) dass `set_object_hull`/`set_object_shield`/`destroy_object`
   identisch auf ein reales, nicht von diesem Mod erzeugtes NPC-Objekt wirken
   wie auf `player.entity`; (c) dass ein bereits zerstörtes `find_object`-Match
   beim nächsten `XMP_Coop_BubbleCheck`-Tick sauber verschwindet, ohne Fehler.
2. Reale Beobachtung, wie sich die dokumentierte NPC-Reaktionslatenz in der
   Praxis anfühlt (Abschnitt 3.4) — Tuning-Kandidat, falls zu träge.
3. C5 ("Sektorwechsel") aufsetzen.
