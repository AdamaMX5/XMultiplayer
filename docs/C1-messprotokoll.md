# C1 — Messprotokoll (Statischer Sektor-Mirror)

**Status: gemischt, wie A1-A5.** Die Protokoll-, Server- und Agent-Seite
(`protocol/src/messages.ts`/`parse.ts`/`canonical.ts`/`limits.ts`,
`server/src/server.ts`, `agent/src/pipeSanitize.ts`/`relayFilter.ts`) ist mit
echten Tests **VERIFIED** (299 Tests grün insgesamt: 78 protocol + 97 agent +
124 server, `npm test --workspaces`). Alles Mod-seitige (`mod/md/XMP_Coop.xml`,
neu, plus drei zusätzliche Dispatch-Zweige in `mod/md/XMP_Arena.xml`) ist wie
bei A1-A5 ausschließlich auf syntaktische XML-Gültigkeit geprüft
(`System.Xml.XmlDocument.Load`, PowerShell), die Semantik ist komplett
ungeprüft — keine X4-Installation verfügbar. Anders als bei A1-A5 gilt das für
C1 in verschärfter Form: dieses Milestone führt die erste Objekt-**Enumeration**
ein (statt nur Zugriff auf das eigene Spielerschiff oder einen einzelnen
Sektor-Vergleichswert), für die es im gesamten bisherigen Code kein
existierendes Muster gibt — siehe Abschnitt 3.

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff): Test-Experte, Sicherheits-Experte und
Code-Review-Experte haben den Stand unabhängig geprüft. Gefundene und
behobene Punkte sind direkt in die jeweiligen Abschnitte unten eingearbeitet
(nicht als separate Liste, um Redundanz zu vermeiden) — hier nur die Kurzfassung:
ein Recheneffekt im ersten Entwurf dieses Dokuments (falsche Testsumme), ein
Accessor-Fehler in `XMP_Coop.xml` (`.rotation` statt dem etablierten
`.quaternion`, Abschnitt 4.3), eine fehlende serverseitige Durchsetzung von
`sector_mirror.objectCount` (Abschnitt 2) und eine Lücke bei
`sector_object.objectId`-Sanitizing (Abschnitt 3) wurden noch vor diesem
Commit geschlossen. Ein nicht-blockierender DRY-Hinweis zu
`XMP_Coop_ExportSector` wurde ebenfalls umgesetzt (Abschnitt 4.2).

Dieses Milestone ist der Auftakt zu PlanMod.md Phase 2 ("Coop im Universum des
Hosts"), Meilenstein C1 ("Statischer Sektor-Mirror"): wenn ein `session`
`join` empfangen wird, exportiert jedes Session-Mitglied einmalig den Inhalt
seines EIGENEN aktuellen Sektors (Stationen, Gates, Asteroidenfelder,
Regionen) als Proxies an die anderen. Anders als PlanMod.md's Architektur-Text
suggeriert ("Host exportiert... Gast spawnt..."), gibt es dafür — bewusst,
siehe Abschnitt 4 — **keine Host/Gast-Unterscheidung**: das Protokoll und der
Server kennen diesen Begriff nirgends (Session-Mitglieder sind seit A1
symmetrisch), und C1 führt ihn nicht neu ein. Stattdessen exportiert JEDES
Mitglied symmetrisch seinen eigenen Sektor; ein Mitglied mit einem leeren
Sektor (die Arena, oder ein noch unbevölkerter Gast-Sektor) exportiert
schlicht null Objekte.

## 1. Protokoll — `sector_object`/`sector_mirror` (`protocol/src/`)

Zwei neue Nachrichtentypen (`messages.ts`), analog zum bestehenden Muster
(ein Feld `v`/`seq`/`ts` plus typspezifische Felder, siehe `spawn`/`fire_event`
als Vorbild):

- **`sector_object`**: ein Objekt pro Nachricht (nicht ein Array pro Sektor) —
  bewusste Entscheidung, weil `XMP_Arena_ExtractField` (der MD-seitige
  Feld-Extraktor, durch den JEDE eingehende Nachricht läuft) nur flache,
  nicht verschachtelte Objekte handhabt; ein Array von Objekten bräuchte einen
  zweiten, unbewiesenen Extraktions-Mechanismus, für den es kein Vorbild gibt.
  Felder: `objectId`, `objectType` (`"station"|"gate"|"asteroidfield"|
  "region"`, enum-validiert wie `hit_report.damageType`), `macroName`
  (String, längenbegrenzt auf `MAX_MACRO_NAME_LENGTH` = 64 — siehe Abschnitt 2),
  `position`/`rotation` (wiederverwendete `Vector3`/`Quaternion`-Typen).
- **`sector_mirror`**: klammert einen Schwung `sector_object`-Nachrichten mit
  `action: "begin"|"end"`; `begin` trägt optional `objectCount`, damit die
  Empfängerseite einen abgebrochenen Transfer erkennen kann, ohne eine eigene
  Timeout-Logik zu brauchen. Bewusst ein EIGENER Nachrichtentyp statt eine
  neue `SessionAction` — ein Sektor-Export betrifft Sektor-INHALT, nicht
  Session-Mitgliedschaft, und beide sollen unabhängig voneinander passieren
  können (z. B. ein erneuter Export, ausgelöst durch ein später beitretendes
  drittes Mitglied).

`canonical.ts`s `serializeCanonical` musste um beide Fälle erweitert werden —
nicht optional: der `switch` über `ProtocolMessage["type"]` hat keinen
`default`-Zweig, TypeScript erzwingt Exhaustivität, sodass ein Vergessen
dieses Schritts einen Kompilierfehler ergäbe, nicht nur eine Laufzeitlücke.

**Grenzen ohne Whitelist:** anders als `spawn.shipType` (geprüft gegen
`SHIP_MACRO_WHITELIST`, `shipMacros.ts`) gibt es für Stations-/Gate-/
Asteroidenfeld-/Regions-Makronamen noch keine Whitelist — die reale
X4-Namenskonvention für diese Objektklassen ist genauso ungeprüft wie A5s
drei Regions-Platzhalter (`docs/A5-messprotokoll.md` Abschnitt 9). Zwei
billige, whitelist-freie Grenzen stehen bis dahin stellvertretend dafür
(`limits.ts`): `MAX_MACRO_NAME_LENGTH` (64 Zeichen) und
`MAX_SECTOR_OBJECTS_PER_MIRROR` (2000, Grenze für `sector_mirror.objectCount`).

Getestet in `protocol/tests/parse.test.ts` (gültige/ungültige `objectType`,
Längengrenze, `objectCount`-Bereich) und `protocol/tests/canonical.test.ts`
(Roundtrip-Stabilität, optionales `objectCount` wird weggelassen statt
`null` serialisiert, wie beim bestehenden `maxHull`/`maxShield`-Muster).

## 2. Server — Pass-Through plus unabhängige Mengenbegrenzung (`server/src/server.ts`)

`sector_object`/`sector_mirror` brauchen — anders als `spawn`/`state_update`/
`despawn`/`fire_event` — **keine** `requireOwnership()`-Prüfung: statische
Sektor-Szenerie hat kein Objekt-EIGENTÜMER-Konzept wie ein Spielerschiff.

**Von der internen Sicherheits-Review gefunden und noch vor diesem Commit
behoben:** der erste Entwurf ließ beide Typen komplett durch den bestehenden
letzten `broadcast(...)`-Fallthrough laufen, ohne jede Mengenprüfung.
`sector_mirror.objectCount` ist aber eine reine SELBSTAUSKUNFT des Senders —
`parseMessage` prüft nur, dass der behauptete Wert im Bereich 0..
`MAX_SECTOR_OBJECTS_PER_MIRROR` liegt, vergleicht ihn aber nie mit der
tatsächlich gesendeten Menge. Ein Client hätte `begin objectCount:1` senden
und danach beliebig viele echte `sector_object`-Nachrichten hinterherschicken
können — der behauptete Wert wäre reine Kosmetik gewesen, keine wirksame
Grenze. **Fix:** ein neues `sectorMirrorCounts: Map<clientId, number>` in
`startRelayServer()`s Closure zählt UNABHÄNGIG vom Client-Claim mit, wie viele
`sector_object`-Nachrichten seit dem letzten `sector_mirror` `begin` dieses
Clients tatsächlich angekommen sind; `begin` setzt den Zähler auf 0 zurück,
jede weitere `sector_object`-Nachricht erhöht ihn, und sobald
`MAX_SECTOR_OBJECTS_PER_MIRROR` (2000) überschritten wird, werden weitere
`sector_object`-Nachrichten dieses Clients für den Rest des laufenden Mirrors
kommentarlos verworfen (nicht gebroadcastet), unabhängig vom ursprünglich
behaupteten `objectCount`. Aufräumen bei Disconnect über denselben
`socket.on("close", ...)`-Handler, der auch die Rate-Limiter zurücksetzt (kein
Leck über die Verbindungslebensdauer hinaus). `sector_mirror` `end` bleibt
reiner Pass-Through (kein Zustand zu bereinigen, die nächste `begin` setzt
ohnehin zurück).

Getestet in `server/tests/sectorMirror.test.ts` (7 Tests): Broadcast an
andere Mitglieder ohne Echo an den Sender, `begin`/`sector_object`/`end` in
korrekter Reihenfolge, Drop außerhalb einer Session, Drop bei ungültigem
`objectType`, Zustellung an alle Mitglieder einer 3-Client-Session, sowie zwei
gezielte Tests für die neue Mengenbegrenzung: Überschreiten von
`MAX_SECTOR_OBJECTS_PER_MIRROR` wird trotz kleiner behaupteter `objectCount`
durchgesetzt, und ein erneutes `begin` setzt den Zähler pro Client zurück
(ein zweiter, späterer Mirror wird nicht durch den ersten eingeschränkt).

**Lektion aus der Review-Runde selbst, nicht nur aus dem Produktivcode:** ein
erster Entwurf des Cap-Durchsetzungstests sendete testeigene 2000+ Nachrichten,
ohne das bestehende ALLGEMEINE Rate-Limit (A5, Standard 60 Kapazität/30 pro
Sekunde) für den Testserver hochzusetzen — die meisten Nachrichten wurden
dadurch schon vom allgemeinen Limiter verworfen, bevor der neue C1-spezifische
Zähler überhaupt greifen konnte, die Assertion schlug fehl, und weil das VOR
den `close()`-Aufrufen passierte, blieb der Test-WebSocketServer offen und der
gesamte `node --test`-Prozess hing unbegrenzt fest statt nur diesen einen Test
fehlschlagen zu lassen. Behoben durch ein hochgesetztes `generalRateLimit` für
diesen Test UND `try`/`finally` um alle Socket-/Server-`close()`-Aufrufe (jetzt
auch in diesem einen neuen Testpaar, nicht rückwirkend in den übrigen
Bestandstests dieser Datei, die dasselbe Risiko strukturell bereits vor C1
hatten).

## 3. Agent — `pipeSanitize.ts` um `macroName` erweitert (`agent/src/`)

`decideRelay()` (`relayFilter.ts`) braucht **keine** neue Sonderbehandlung:
ohne eigenen Fall greift bereits der Default (`{ forward: true }`) — es gibt
keine Arena-Bounds-Prüfung, die auf Sektor-Objekte anwendbar wäre (der
Host-Sektor kann irgendwo im echten Universum liegen, nicht in der kleinen
Arena), und kein Orphan-Filter-Konzept (Sektor-Objekte sind nicht an einen
`knownObjectIds`-Spawn gebunden). Getestet in `agent/tests/relayFilter.test.ts`
(2 neue Tests: Weiterleitung unabhängig von Position/`knownObjectIds`).

`pipeSanitize.ts`s `sanitizeForPipe()` bekam neue Zweige für
`sector_object.macroName` UND `objectId` — dieselbe
`sanitizeForPipeExtraction()`-Behandlung wie `playerName`/`chat.from`/
`chat.text` seit A5 (entfernt `{`/`}`/`,`, die Zeichen, an denen
`XMP_Arena_ExtractField`s naive Extraktion zerbricht). Beide Felder sind noch
weiter draußen auf dem Vertrauens-Spektrum als `shipType`: `shipType` wird VOR
`sanitizeForPipe` bereits gegen `SHIP_MACRO_WHITELIST` geprüft (`decideRelay`),
für `macroName`/`objectId` existiert noch keine äquivalente Whitelist
(Abschnitt 1) — die Längengrenze aus `parseMessage` begrenzt nur `macroName`s
Größe (`objectId` hat außer der globalen `MAX_MESSAGE_BYTES`-Nachrichtengrenze
keine eigene), aber nur `sanitizeForPipeExtraction` hier schützt den
MD-Extraktor vor problematischen Zeichen in beiden Feldern.

**Von der internen Sicherheits-Review gefunden:** der erste Entwurf
sanitisierte nur `macroName`, mit einer pauschalen Kommentar-Begründung
("objectId/etc. are either server-controlled or already whitelisted
elsewhere"), die für `sector_object.objectId` schlicht falsch war — es ist ein
frei vom Client gewählter String ohne Whitelist. Ein böswilliger Client hätte
`objectId: "{evil},"` senden können, was dieselbe Extraktion-bricht-Lücke
ausgelöst hätte wie ein ungeschütztes `macroName`, nur mit der Konsequenz,
dass auch NACHFOLGENDE Felder derselben Pipe-Zeile korrumpiert würden. Fix:
`objectId` bekommt jetzt dieselbe `sanitizeForPipeExtraction()`-Behandlung.
**Bewusst NICHT mitbehoben** (out of scope für C1, vorbestehend seit A2):
`spawn.objectId` hat exakt dieselbe strukturelle Lücke — dort unangetastet
gelassen, um den Blast-Radius dieses Milestones nicht auf bereits produktiven,
gut getesteten A1-A5-Code auszudehnen; vorgemerkt für einen eigenen,
fokussierten Fix (Abschnitt 6).

Getestet in `agent/tests/pipeSanitize.test.ts` (3 neue Tests: `objectId` UND
`macroName` werden gemeinsam sanitisiert, ein sauberer `sector_object` bleibt
unverändert, `sector_mirror` ohne Freitextfelder bleibt komplett unangetastet).

## 4. MD — `mod/md/XMP_Coop.xml` (neu) + drei Dispatch-Zweige in `XMP_Arena.xml`

### 4.1 Architekturentscheidung: keine Host/Gast-Unterscheidung

PlanMod.md's Prosa für C1 ("Host exportiert beim Gast-Join... Gast-Client
spawnt...") impliziert asymmetrische Rollen. Diese Codebase kennt aber
NIRGENDS ein Host/Gast-Konzept — weder im Protokoll noch im
`SessionManager` (siehe `server/src/sessionManager.ts`: ein "Mitglied" ist
rein symmetrisch). C1 führt das bewusst NICHT neu ein, um keine
Server-/Protokoll-Änderung zu erzwingen, die für spätere Meilensteine
(C2 "Host-Schiff als dynamisches Objekt = Arena-Code wiederverwendet") ohnehin
wieder aufgebrochen werden müsste. Stattdessen: **jedes** Mitglied reagiert
auf JEDES empfangene `session join` (das laut Server-Semantik — `broadcast()`
schließt den Sender aus — IMMER von einem ANDEREN Mitglied stammt) mit einem
Export des EIGENEN aktuellen Sektors. Wer nichts Nennenswertes im Sektor hat
(die leere Arena, ein noch leerer Warteraum), exportiert schlicht null
Objekte — kein Sonderfall irgendwo im Code.

**Explizit nicht umgesetzt, dokumentierte Vereinfachung** (nicht Versehen):
kein neuer "Coop-Warteraum"-Gamestart für die Gast-Seite. PlanMod.md's
Architekturprinzip ("Gast startet in leerem Custom-Universum") ist damit noch
NICHT als ausgelieferter Content umgesetzt — für C1 muss, wer den Sektor des
ANDEREN gespiegelt sehen will, selbst in einem Sektor mit wenig/nichts
Eigenem stehen (sonst spiegeln beide Seiten symmetrisch, was ebenfalls
funktioniert, aber verwirrend aussehen könnte). Ein eigener Gamestart
(analog zu den vier Arena-Varianten, `libraries/{clusters,sectors,zones,
galaxy,gamestarts}.xml`) ist als Folgeschritt vorgemerkt (Abschnitt 6).

### 4.2 Die größte Einzel-Annahme in diesem Milestone: Objekt-Enumeration

`XMP_Coop_FindObjectsOfClass` (in `XMP_Coop.xml`) ist der einzige Baustein
in A1-C1, der eine SAMMLUNG von Objekten in einem Sektor aufzählen muss —
alles bisherige griff nur auf das eigene Spielerschiff (`player.entity.*`)
oder einen einzelnen Skalarwert (`player.sector.macro.name`, A5) zu. Es gibt
im gesamten bisherigen Repository KEIN Vorbild für diesen Zugriffsstil.
Angenommen: eine generische `find_object`-Aktion mit `class`
(`'station'`/`'gate'`/`'asteroid'`/`'region'`) und `sector`-Attributen plus
`multiple="true"`, deren Ergebnis über `<do_all exact="$Result"
counter="$XMP.CoopIndex">` iterierbar ist (`$XMP.CoopIndex.entry` pro
Durchlauf). Bewusst EINE parametrisierte Aktion statt vier verschiedener
(`find_station`/`find_gate`/`find_asteroid`/`find_region`), damit eine
Korrektur — falls die Annahme falsch ist — eine EINZIGE Stelle trifft, nicht
vier unabhängig falsche. Fallback, falls `find_object` nicht existiert: die
vier spezifischeren Aktionen (in verschiedenen Community-MD-Referenzen
dokumentiert), mit demselben Iterations-Schema — nur `XMP_Coop_ExportSector`s
vier `<include_interrupt_actions>`-Ziele müssten sich ändern, sonst nichts.

### 4.3 Weitere Annahmen, nach Risiko geordnet

- [ ] **`find_object`/`find_station`/`find_gate`/`find_asteroid`/
      `find_region`** (Abschnitt 4.2) — die zentrale Annahme, ohne die C1
      überhaupt keine Objekte findet.
- [ ] **`.id`/`.macro.name`/`.position`/`.rotation` auf `$XMP.CoopIndex.entry`**
      zugreifbar, im selben Stil wie das bereits (ebenfalls unbestätigte)
      `player.entity.*`-Muster seit A1.
- [ ] **`create_station`** als Erzeugungsaktion für JEDEN Sektor-Objekt-Typ
      auf Gast-Seite (`XMP_Coop_HandleSectorObject`), unabhängig vom
      tatsächlichen `objectType` — angenommene Signatur: `name`/`macro`/
      `sector`/`position`/`rotation`/`owner="ownerless"`. Unbestätigt, ob eine
      Station ohne echte Modul-/Bau-Voraussetzungen so einfach platzierbar
      ist wie ein Schiff über `create_ship`.
- [ ] **`$XMP.CoopPlaceholderMacro` (`'xmp_coop_placeholder_macro'`)**: ein
      REINER Platzhalter-String, exakt dieselbe Risikokategorie wie A5s drei
      Regions-Makro-Platzhalter (`docs/A5-messprotokoll.md` Abschnitt 9) —
      muss vor jedem In-Game-Test durch einen echten, bestätigten Makronamen
      ersetzt werden (ein kleines, günstiges, fraktionsneutrales Objekt, z. B.
      eine Navigationsbake).
- [ ] **`player.sector` als `sector`-Attributwert** (nicht nur lesbar für
      `.macro.name`, wie seit A5 bereits genutzt) für `find_object`/
      `create_station`.

**Bewusst nicht umgesetzt** (dokumentierte Vereinfachungen, siehe
`XMP_Coop.xml`s Dateikopf für die volle Begründung):

- Gast-seitige Proxies unterscheiden sich NICHT nach `objectType` — alle vier
  Typen nutzen dieselbe Platzhalter-Erzeugung. `objectType` wird übertragen
  und gespeichert (`$XMP.SectorProxyTypes`), aber nur für Logging genutzt.
- Kein Re-Export-Drosseln: tritt ein drittes Mitglied bei, exportieren ALLE
  bereits anwesenden Mitglieder erneut (inklusive der Gast, der den ERSTEN
  Export schon erhalten hat) und senden dieselben Objekte nochmal.
  `XMP_Coop_HandleSectorObject`s Idempotenz-Guard (`not
  $XMP.SectorProxies.{objectId}.exists`, exakt wie `XMP_Arena_HandleSpawn`)
  macht einen redundanten Empfang zum harmlosen No-Op — akzeptiert statt mit
  Server-seitigem Caching gelöst (anders als A2s Spawn-Replay für
  Späteinsteiger, `sessionManager.ts`; für `sector_object` gibt es bewusst
  KEIN serverseitiges Replay/Cache).
- Kein Despawn/Teardown-Pfad für Sektor-Proxies: PlanMod.md nennt C1
  ausdrücklich "statisch", ein einmaliger Transfer ohne weitere
  Synchronisation. Ein `session leave`/Sektor-Austritt räumt
  `$XMP.SectorProxies` NICHT auf (anders als `XMP_Arena_OnExitSector`s echtes
  Schiffs-Despawn) — akzeptiert für V1, relevant sobald C5
  ("Sektorwechsel") existiert.
- Kein Caching in `agent/src/index.ts`s `knownSpawns`/Replay bei
  Pipe-Reconnect: ein lokaler X4-Neustart mitten in einer Coop-Session
  verliert die gespiegelten statischen Objekte bis zum nächsten vollständigen
  Session-(Wieder-)Beitritt.
- **Von der internen Test-Review als Randfall benannt:** `$XMP.CoopReceivedObjectCount`
  (`XMP_Coop_HandleSectorMirror`) ist ein einzelner globaler Zähler ohne
  Bezug zu einer konkreten Mirror-Übertragung. Überlappen sich zwei Exporte
  zeitlich (z. B. zwei nahezu gleichzeitige `session join`s in einer
  3er-Session, jedes Mitglied exportiert unabhängig), können sich die
  `begin`/`sector_object`/`end`-Ströme verschiedener Sender vermischen und den
  Zähler verfälschen. Auswirkung ist rein kosmetisch (nur die
  Log-Zeile/`debug_text` bei "end" zeigt einen falschen Abgleich, kein
  Proxy wird dadurch falsch erzeugt oder ausgelassen) — akzeptiert für V1.
- **Von der internen Sicherheits-Review benannt, nicht abschließend
  bewertbar:** `XMP_Coop_ExportSector` schreibt pro gefundenem Objekt
  synchron einen Pipe-Write, ohne Batching/Pacing. Bei einem sehr großen
  realen Sektor (tausende Objekte, anders als die absichtlich leere Arena)
  könnte das kurzzeitig mit der 10-Hz-Telemetrie konkurrieren oder den
  Pipe-Puffer belasten. Ohne X4-Installation nicht verifizierbar; vor dem
  ersten In-Game-Test mit einem dicht besiedelten Sektor gezielt beobachten,
  ggf. Chunking (max. N Objekte pro Tick) nachrüsten.

## 5. Warum (noch) keine Whitelist-/Ownership-Autorisierung für `sector_object`/`sector_mirror`

Bewusst OFFEN gelassen (kein Fix in diesem Milestone, aber dokumentiert statt
übersehen — Abschnitt 2 schließt die MENGEN-Lücke bereits, dieser Abschnitt
betrifft die INHALTS-Plausibilität, ein separates Problem): jedes
Session-Mitglied kann `sector_object` mit beliebigem Inhalt senden, unabhängig
davon, ob es tatsächlich diesen Sektor-Inhalt hat — anders als bei `spawn`
(Whitelist + Owner-Cap) gibt es hierfür keine Plausibilitätsprüfung des
`macroName`/`objectType`/Position. Ein böswilliger Client könnte beliebige
(aber jetzt zahlenmäßig begrenzte, Abschnitt 2, und größenbegrenzte,
Abschnitt 1) Fake-Objekte in eine fremde Session einschleusen. Diese Lücke ist
strukturell dieselbe wie A5s ursprünglich fehlende Server-seitige
`shipType`-Prüfung (Abschnitt 7 dort) — dort wurde sie nachträglich
geschlossen, weil eine Whitelist existierte; hier gibt es noch keine, also
gibt es (noch) nichts, wogegen zu prüfen wäre. Sobald eine reale
Makro-Whitelist für Sektor-Objekte existiert (Nächste Schritte, Punkt 3),
sollte dieselbe serverseitige Prüfung wie bei `spawn.shipType` ergänzt werden.

**Risikoeinschätzung der internen Sicherheits-Review zu dieser verbleibenden
Lücke:** strukturell real, aber praktisch durch den bestehenden allgemeinen
Rate-Limiter (A5, ~30 Nachrichten/s, greift für JEDEN Nachrichtentyp VOR
`parseMessage`, siehe `server/src/server.ts`) und jetzt zusätzlich durch die
neue Mengenbegrenzung (Abschnitt 2) eingehegt — ein Angreifer kann keine
unbegrenzte Menge Fake-Objekte in kurzer Zeit einschleusen, auch ohne
Whitelist. Als Gesamtrisiko für dieses Milestone als MITTEL statt HOCH
eingestuft; vor Ausbau von C2 (dynamische Host-Schiff-Objekte, die
Ownership-Semantik brauchen werden) sollte diese Lücke aber geschlossen sein.

## 6. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren; zuerst
   `find_object`/`find_station` (Abschnitt 4.2) bestätigen — ohne
   funktionierende Enumeration liefert `XMP_Coop_ExportSector` immer
   `objectCount: 0`, der Rest dieses Milestones bleibt ungetestet.
2. `create_station`-Signatur (Abschnitt 4.3) isoliert bestätigen, inklusive
   ob eine Station ohne reale Bauvoraussetzungen platzierbar ist.
3. `$XMP.CoopPlaceholderMacro` durch einen echten, gegen die
   X4-Bibliotheksdateien geprüften Makronamen ersetzen.
4. Eine echte Makro-Whitelist für Sektor-Objekte aufbauen (analog
   `SHIP_MACRO_WHITELIST`, `shipMacros.ts`) und serverseitig durchsetzen
   (Abschnitt 5).
5. Einen dedizierten "Coop-Warteraum"-Gamestart für die Gast-Seite ausliefern,
   sobald PlanMod.md's "leeres Custom-Universum"-Prinzip als echter Content
   gewünscht ist (Abschnitt 4.1).
6. `objectType`-spezifische Gast-Darstellung (Abschnitt 4.3) statt einer
   einzigen Platzhalter-Erzeugung für alle vier Typen.
7. C2 ("Host-Schiff als dynamisches Objekt = Arena-Code wiederverwendet")
   aufsetzen — laut PlanMod.md der nächste Meilenstein, der `session join`
   als denselben Auslöser wie C1 wiederverwendet.
8. `spawn.objectId` denselben `sanitizeForPipeExtraction()`-Fix geben wie
   `sector_object.objectId` in diesem Milestone (Abschnitt 3) — dieselbe
   strukturelle Lücke, vorbestehend seit A2, bewusst nicht in C1 mitgezogen,
   um den Änderungsumfang dieses Milestones nicht auf bereits produktiven
   A1-A5-Code auszudehnen.
